"""Introspection and query building for a bot's database, via SQLAlchemy Core only.

Table and column names never go into SQL as strings: the table is reflected, and mapped
or filter columns must exist on the reflected Table before any query is built."""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Column,
    MetaData,
    String,
    Table,
    and_,
    bindparam,
    cast,
    distinct,
    exists,
    func,
    inspect,
    or_,
    select,
    text,
)
from sqlalchemy.exc import NoSuchTableError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from sqlalchemy.sql.elements import ColumnElement

from app.modules.sources.connection import SourceError
from app.modules.sources.schemas import (
    ColumnInfo,
    RelationInfo,
    SourceFilter,
    SourceSpec,
    TableInfo,
)

CHUNK = 5000
_SYSTEM_SCHEMAS = {"information_schema", "pg_catalog"}
_TRUTHY = ("1", "t", "true", "y", "yes", "on")

SUGGESTIONS: dict[str, list[str]] = {
    "chat_id": [
        "chat_id",
        "user_id",
        "tg_id",
        "telegram_id",
        "tg_user_id",
        "telegram_user_id",
        "id",
    ],
    "username": ["username", "tg_username", "telegram_username", "user_name", "handle"],
    "first_name": ["first_name", "firstname", "name", "full_name", "display_name"],
    "last_name": ["last_name", "lastname", "surname"],
    "language_code": ["language_code", "lang", "language", "locale"],
    "joined_at": [
        "joined_at",
        "created_at",
        "subscribed_at",
        "registered_at",
        "date_joined",
        "created",
    ],
    "is_active": ["is_active", "active", "is_subscribed", "subscribed", "enabled"],
}


def suggest_mapping(column_names: list[str]) -> dict[str, str]:
    by_lower = {c.lower(): c for c in column_names}
    used: set[str] = set()
    out: dict[str, str] = {}
    for fld, candidates in SUGGESTIONS.items():
        for cand in candidates:
            col = by_lower.get(cand)
            if col and col not in used:
                out[fld] = col
                used.add(col)
                break
    return out


def _type_name(col_type) -> str:
    try:
        return str(col_type).lower()
    except Exception:  # some dialect types can't compile generically
        return col_type.__class__.__name__.lower()


def qualified(schema: str | None, table: str) -> str:
    return f"{schema}.{table}" if schema else table


# ---- introspection ---------------------------------------------------------------------


async def server_version(conn: AsyncConnection) -> str | None:
    info = conn.dialect.server_version_info
    return ".".join(str(p) for p in info[:2]) if info else None


async def list_tables(conn: AsyncConnection) -> list[TableInfo]:
    def _inspect(sync_conn) -> list[TableInfo]:
        insp = inspect(sync_conn)
        is_sqlite = sync_conn.dialect.name == "sqlite"
        schemas = (
            [None]
            if is_sqlite
            else [
                s
                for s in insp.get_schema_names()
                if s not in _SYSTEM_SCHEMAS and not s.startswith("pg_")
            ]
        )
        out: list[TableInfo] = []
        fks: list[tuple[TableInfo, dict]] = []
        unique_cols: dict[tuple, set[str]] = {}
        for schema in schemas:
            names = [(n, "table") for n in insp.get_table_names(schema=schema)]
            names += [(n, "view") for n in insp.get_view_names(schema=schema)]
            for name, kind in names:
                if is_sqlite and name.startswith("sqlite_"):
                    continue
                cols = insp.get_columns(name, schema=schema)
                info = TableInfo(
                    schema_=schema,
                    name=name,
                    kind=kind,
                    row_estimate=None,
                    columns=[
                        ColumnInfo(
                            name=c["name"],
                            type=_type_name(c["type"]),
                            nullable=c.get("nullable", True),
                        )
                        for c in cols
                    ],
                    suggested=suggest_mapping([c["name"] for c in cols]),
                )
                out.append(info)
                if kind == "table":
                    unique_cols[(schema, name)] = _single_unique_columns(insp, name, schema)
                    fks += [(info, fk) for fk in insp.get_foreign_keys(name, schema=schema)]
        _link(out, fks, unique_cols)
        return out

    tables = await conn.run_sync(_inspect)
    await _fill_row_estimates(conn, tables)
    return sorted(tables, key=lambda t: (t.schema_ or "", t.name))


def _single_unique_columns(insp, name: str, schema: str | None) -> set[str]:
    """Columns that are unique on their own (single-column PK, unique constraint or index)."""
    out: set[str] = set()
    pk = insp.get_pk_constraint(name, schema=schema).get("constrained_columns") or []
    if len(pk) == 1:
        out.add(pk[0])
    for uc in insp.get_unique_constraints(name, schema=schema):
        if len(uc["column_names"]) == 1:
            out.add(uc["column_names"][0])
    for ix in insp.get_indexes(name, schema=schema):
        if ix.get("unique") and len(ix["column_names"]) == 1:
            out.add(ix["column_names"][0])
    return out


def _link(tables: list[TableInfo], fks: list[tuple[TableInfo, dict]], unique_cols) -> None:
    """Turn single-column foreign keys into relations on both tables, then suggest
    mappings from linked tables for fields the table itself doesn't have."""
    by_key = {(t.schema_, t.name): t for t in tables}
    for child, fk in fks:
        if len(fk["constrained_columns"]) != 1 or len(fk["referred_columns"]) != 1:
            continue
        parent = by_key.get((fk.get("referred_schema") or child.schema_, fk["referred_table"]))
        if parent is None or parent is child:
            continue
        col, ref = fk["constrained_columns"][0], fk["referred_columns"][0]
        child.relations.append(
            RelationInfo(
                table=parent.name,
                schema_=parent.schema_,
                base_column=col,
                related_column=ref,
                cardinality="one",
            )
        )
        child_unique = col in unique_cols.get((child.schema_, child.name), set())
        parent.relations.append(
            RelationInfo(
                table=child.name,
                schema_=child.schema_,
                base_column=ref,
                related_column=col,
                cardinality="one" if child_unique else "many",
            )
        )
    for t in tables:
        if "chat_id" not in t.suggested:
            continue  # only worth it for tables that look like user tables
        for rel in sorted(t.relations, key=lambda r: r.cardinality != "one"):
            other = by_key[(rel.schema_, rel.table)]
            for fld, col in suggest_mapping([c.name for c in other.columns]).items():
                if fld != "chat_id" and fld not in t.suggested:
                    t.suggested[fld] = f"{rel.table}.{col}"


async def _fill_row_estimates(conn: AsyncConnection, tables: list[TableInfo]) -> None:
    if conn.dialect.name == "postgresql":
        # Planner statistics: instant even on huge tables. -1 means never analyzed.
        rows = await conn.execute(
            text(
                "SELECT n.nspname, c.relname, c.reltuples::bigint FROM pg_class c "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname = ANY(:schemas)"
            ).bindparams(bindparam("schemas", value=list({t.schema_ for t in tables if t.schema_})))
        )
        est = {(s, n): (c if c >= 0 else None) for s, n, c in rows}
        for t in tables:
            t.row_estimate = est.get((t.schema_, t.name))
    else:
        for t in tables:
            if t.kind == "table":
                tbl = Table(t.name, MetaData(), schema=t.schema_)
                t.row_estimate = await conn.scalar(select(func.count()).select_from(tbl))


# ---- query building --------------------------------------------------------------------


@dataclass
class Resolved:
    """A spec checked against the real database: the main table plus linked tables."""

    base: Table
    joins: dict[str, tuple[Table, Column, Column]] = field(default_factory=dict)

    def column(self, ref: str) -> tuple[Column, tuple[Table, Column, Column] | None]:
        """Resolve "column" (main table) or "table.column" (linked table)."""
        if "." in ref:
            tname, cname = ref.split(".", 1)
            if tname not in self.joins:
                raise SourceError(
                    f"Table {tname} isn't linked to {qualified(self.base.schema, self.base.name)}"
                )
            related = self.joins[tname]
            return _column(related[0], cname), related
        return _column(self.base, ref), None


async def reflect(conn: AsyncConnection, spec: SourceSpec) -> Resolved:
    def _load(sync_conn, name: str, schema: str | None) -> Table:
        try:
            return Table(name, MetaData(), schema=schema, autoload_with=sync_conn)
        except NoSuchTableError as exc:
            raise SourceError(f"Table {qualified(schema, name)} doesn't exist") from exc

    base = await conn.run_sync(_load, spec.table, spec.db_schema)
    resolved = Resolved(base)
    for j in spec.joins:
        related = await conn.run_sync(_load, j.table, j.db_schema)
        resolved.joins[j.table] = (
            related,
            _column(base, j.base_column),
            _column(related, j.related_column),
        )
    return resolved


def _column(table: Table, name: str) -> Column:
    if name not in table.c:
        raise SourceError(f"Column {name} doesn't exist in {qualified(table.schema, table.name)}")
    return table.c[name]


def _python_type(col: Column):
    try:
        return col.type.python_type
    except NotImplementedError:
        return None


def _truthy(col: Column) -> ColumnElement[bool]:
    py = _python_type(col)
    if isinstance(col.type, Boolean) or py is bool:
        return col.is_(True)
    if py in (int, float, Decimal):
        return col != 0
    return func.lower(col).in_(_TRUTHY)


def _coerce(col: Column, value):
    if value is None:
        raise SourceError(f"The filter on {col.name} needs a value")
    py = _python_type(col)
    try:
        if py is bool:
            return str(value).strip().lower() in _TRUTHY
        if py is int:
            return int(value)
        if py in (float, Decimal):
            return float(value)
        if py is datetime:
            return datetime.fromisoformat(str(value))
        if py is date:
            return date.fromisoformat(str(value))
    except ValueError as exc:
        raise SourceError(f"{value!r} isn't a valid value for {col.name}") from exc
    return str(value) if py is str else value


def _test(col: Column, f: SourceFilter) -> ColumnElement[bool]:
    match f.op:
        case "eq":
            return col == _coerce(col, f.value)
        case "neq":
            return col != _coerce(col, f.value)
        case "is_null":
            return col.is_(None)
        case "not_null":
            return col.is_not(None)
        case "is_true":
            return _truthy(col)
        case "is_false":
            return ~_truthy(col)
    raise SourceError(f"Unknown filter condition {f.op}")


def _on_related(src: Resolved, ref: str, test) -> ColumnElement[bool]:
    """A condition on the main table, or "has a linked row where …" via EXISTS."""
    col, related = src.column(ref)
    if related is None:
        return test(col)
    table, base_col, rel_col = related
    return exists().where(rel_col == base_col, test(col))


def _value(src: Resolved, ref: str):
    """A mapped field. From a linked table it's one value per user (no duplicate rows)."""
    col, related = src.column(ref)
    if related is None:
        return col
    table, base_col, rel_col = related
    return select(col).where(rel_col == base_col).limit(1).scalar_subquery()


def _chat(src: Resolved, spec: SourceSpec) -> Column:
    if "." in spec.column_map.chat_id:
        raise SourceError("The Telegram user ID must come from the main table")
    return _column(src.base, spec.column_map.chat_id)


def where_clause(src: Resolved, spec: SourceSpec) -> ColumnElement[bool]:
    mapping = spec.column_map.mapped()
    for ref in mapping.values():
        src.column(ref)  # validate every mapped column up front
    chat = _chat(src, spec)
    conds = [chat.is_not(None)]
    if spec.column_map.is_active:
        conds.append(_on_related(src, spec.column_map.is_active, _truthy))
    conds += [_on_related(src, f.column, lambda c, f=f: _test(c, f)) for f in spec.filters]
    return and_(*conds)


def rows_query(src: Resolved, spec: SourceSpec):
    cols = [_value(src, ref).label(fld) for fld, ref in spec.column_map.mapped().items()]
    chat = _chat(src, spec)
    return select(*cols).where(where_clause(src, spec)).order_by(chat)


def search_query(src: Resolved, spec: SourceSpec, q: str, limit: int):
    """Match a Telegram ID exactly, or username/name as a case-insensitive substring."""
    mapping = spec.column_map.mapped()
    chat = _chat(src, spec)
    term = q.strip().lstrip("@")
    conds = []
    if term.lstrip("-").isdigit():
        conds.append(cast(chat, String) == term)
    pattern = f"%{term.lower()}%"
    for fld in ("username", "first_name", "last_name"):
        if mapping.get(fld):
            conds.append(func.lower(cast(_value(src, mapping[fld]), String)).like(pattern))
    return rows_query(src, spec).where(or_(*conds) if conds else False).limit(limit)


def count_query(src: Resolved, spec: SourceSpec):
    chat = _chat(src, spec)
    return select(func.count(distinct(chat))).where(where_clause(src, spec))


def chat_ids_query(src: Resolved, spec: SourceSpec):
    chat = _chat(src, spec)
    return select(chat).where(where_clause(src, spec)).distinct()


def as_chat_id(value) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


async def stream_chat_ids(engine: AsyncEngine, spec: SourceSpec) -> AsyncIterator[list[int]]:
    """Yield integer chat_ids in chunks. Non-numeric values are dropped."""
    async with engine.connect() as conn:
        table = await reflect(conn, spec)
        result = await conn.stream(chat_ids_query(table, spec).execution_options(yield_per=CHUNK))
        async for part in result.partitions(CHUNK):
            ids = [cid for (v,) in part if (cid := as_chat_id(v)) is not None]
            if ids:
                yield ids
