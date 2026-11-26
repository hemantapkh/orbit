import asyncio
import logging
import time
from collections import Counter, defaultdict
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db import upsert_insert, utcnow
from app.core.security import decrypt_secret
from app.modules.sources.connection import SourceError, engines, normalize_url, safe_error
from app.modules.sources.models import BotSource, BotSuppression, SourceKind, SourceStatus
from app.modules.sources.query import (
    CHUNK,
    as_chat_id,
    count_query,
    fetch_people,
    last_active_query,
    lost_query,
    lost_reason,
    reflect,
    rows_query,
    search_query,
    stream_chat_ids,
    stream_people,
)
from app.modules.sources.schemas import ColumnMap, PreviewOut, SourceSpec, SubscriberCounts

log = logging.getLogger("orbit.sources")

COUNT_TTL_SECONDS = 60
PREVIEW_ROWS = 5


def spec_of(source: BotSource) -> SourceSpec:
    return SourceSpec(
        table=source.table_name or "",
        db_schema=source.schema_name,
        column_map=ColumnMap.model_validate(source.column_map),
        filters=source.filters or [],
        joins=source.joins or [],
    )


def url_of(source: BotSource) -> URL:
    if not source.database_url_encrypted:
        raise SourceError("This source has no saved connection")
    return normalize_url(decrypt_secret(source.database_url_encrypted))


async def engine_for(source: BotSource) -> AsyncEngine:
    return await engines.get(source.id, url_of(source))


async def database_sources(session: AsyncSession, bot_ids=None) -> dict[int, BotSource]:
    stmt = select(BotSource).where(BotSource.kind == SourceKind.DATABASE)
    if bot_ids is not None:
        stmt = stmt.where(BotSource.bot_id.in_(list(bot_ids)))
    return {s.bot_id: s for s in (await session.scalars(stmt)).all()}


# ---- preview ---------------------------------------------------------------------------


def _jsonable(v):
    if isinstance(v, datetime | date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, bytes):
        return v.hex()
    return v


async def preview(engine: AsyncEngine, spec: SourceSpec) -> PreviewOut:
    async with engine.connect() as conn:
        src = await reflect(conn, spec)
        total = await conn.scalar(count_query(src, spec))
        rows = (await conn.execute(rows_query(src, spec).limit(PREVIEW_ROWS))).mappings().all()

    warnings: list[str] = []
    chat_col = src.base.c[spec.column_map.chat_id]
    try:
        numeric_type = chat_col.type.python_type in (int, Decimal)
    except NotImplementedError:
        numeric_type = False
    bad = [r["chat_id"] for r in rows if as_chat_id(r["chat_id"]) is None]
    if bad:
        warnings.append(
            f"Some {chat_col.name} values aren't numeric Telegram IDs (for example {bad[0]!r}). "
            "Those rows will be skipped."
        )
    elif not numeric_type:
        warnings.append(
            f"{chat_col.name} is stored as {str(chat_col.type).lower()}, not a number. "
            "Rows whose value isn't a numeric Telegram ID will be skipped."
        )
    if total == 0:
        warnings.append("No rows match. Check the table, the mapping and any filters.")
    return PreviewOut(
        rows=[{k: _jsonable(v) for k, v in r.items()} for r in rows], total=total, warnings=warnings
    )


# ---- suppressions ----------------------------------------------------------------------


async def suppress(session: AsyncSession, bot_id: int, items: list[tuple[int, str]]) -> None:
    """Upsert (chat_id, reason) pairs. Caller commits."""
    if not items:
        return
    now = utcnow()
    rows = [
        {"bot_id": bot_id, "chat_id": cid, "reason": reason, "created_at": now}
        for cid, reason in dict(items).items()
    ]
    stmt = upsert_insert()(BotSuppression).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=[BotSuppression.bot_id, BotSuppression.chat_id],
        set_={"reason": stmt.excluded.reason},
    )
    await session.execute(stmt)


async def suppressed_ids(session: AsyncSession, bot_id: int) -> set[int]:
    return set(
        (
            await session.scalars(
                select(BotSuppression.chat_id).where(BotSuppression.bot_id == bot_id)
            )
        ).all()
    )


# ---- live audience ---------------------------------------------------------------------


class _IdCache:
    """chat_id sets per source for ~60s, shared by counts and unique-people.

    TODO(scale): this holds every chat_id of every database source in memory and re-reads
    the full list each minute. Fine for tens of thousands of users per bot; beyond that,
    switch counts to COUNT queries and compute unique people in a background job."""

    def __init__(self):
        self._data: dict[int, tuple[float, str, frozenset[int], dict[int, str]]] = {}
        self._locks: defaultdict[int, asyncio.Lock] = defaultdict(asyncio.Lock)

    @staticmethod
    def _fingerprint(source: BotSource) -> str:
        return repr(
            (
                source.database_url_encrypted,
                source.schema_name,
                source.table_name,
                source.column_map,
                source.filters,
                source.joins,
            )
        )

    def fresh(self, source: BotSource) -> frozenset[int] | None:
        hit = self._data.get(source.id)
        if (
            hit
            and hit[1] == self._fingerprint(source)
            and time.monotonic() - hit[0] < COUNT_TTL_SECONDS
        ):
            return hit[2]
        return None

    def put(self, source: BotSource, ids: frozenset[int], lost: dict[int, str]) -> None:
        self._data[source.id] = (time.monotonic(), self._fingerprint(source), ids, lost)

    def lost(self, source: BotSource) -> dict[int, str]:
        """chat_id -> why the bot's own records say it can't be reached (last read)."""
        hit = self._data.get(source.id)
        return hit[3] if hit and hit[1] == self._fingerprint(source) else {}

    def lock(self, source_id: int) -> asyncio.Lock:
        return self._locks[source_id]

    def drop(self, source_id: int) -> None:
        self._data.pop(source_id, None)


id_cache = _IdCache()


async def collect_chat_ids(
    engine: AsyncEngine, spec: SourceSpec, kinds: Sequence[str] = ()
) -> set[int]:
    ids: set[int] = set()
    async for chunk in stream_chat_ids(engine, spec, kinds):
        ids.update(chunk)
    return ids


async def live_ids(session: AsyncSession, source: BotSource) -> frozenset[int] | None:
    """Current reachable chat_ids (suppressions removed), or None if the database failed.

    Updates the source's health and cached count. Commits."""
    if (ids := id_cache.fresh(source)) is not None:
        return ids
    async with id_cache.lock(source.id):
        if (ids := id_cache.fresh(source)) is not None:
            return ids
        try:
            engine, spec = await engine_for(source), spec_of(source)
            raw = await collect_chat_ids(engine, spec)
            lost = await collect_lost(engine, spec)
            await clear_returned(session, source.bot_id, engine, spec)
        except Exception as exc:
            mark_error(source, exc)
            await session.commit()
            return None
        ids = frozenset(raw - await suppressed_ids(session, source.bot_id))
        now = utcnow()
        source.status, source.last_error, source.last_checked_at = SourceStatus.HEALTHY, None, now
        source.cached_count, source.cached_count_at = len(ids), now
        await session.commit()
        id_cache.put(source, ids, lost)
        return ids


async def collect_lost(engine: AsyncEngine, spec: SourceSpec) -> dict[int, str]:
    """chat_id -> blocked/left/deleted/unreachable, for chats the bot marks unreachable."""
    out: dict[int, str] = {}
    async with engine.connect() as conn:
        src = await reflect(conn, spec)
        if (stmt := lost_query(src, spec)) is None:
            return out
        result = await conn.stream(stmt.execution_options(yield_per=CHUNK))
        async for part in result.mappings().partitions(CHUNK):
            for row in part:
                if (cid := as_chat_id(row["chat_id"])) is not None:
                    out[cid] = lost_reason(row)
    return out


def _as_utc(value) -> datetime | None:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)  # naive means UTC


async def clear_returned(
    session: AsyncSession, bot_id: int, engine: AsyncEngine, spec: SourceSpec
) -> None:
    """Forget a block or failure Orbit recorded if the person used the bot after it.

    Needs "Last active" mapped. Caller commits."""
    if not spec.column_map.last_active_at:
        return
    recorded = {
        cid: (sid, created)
        for sid, cid, created in await session.execute(
            select(BotSuppression.id, BotSuppression.chat_id, BotSuppression.created_at).where(
                BotSuppression.bot_id == bot_id
            )
        )
    }
    if not recorded:
        return
    back: list[int] = []
    async with engine.connect() as conn:
        src = await reflect(conn, spec)
        ids = list(recorded)
        for i in range(0, len(ids), 1000):
            for value, t in await conn.execute(last_active_query(src, spec, ids[i : i + 1000])):
                if (cid := as_chat_id(value)) not in recorded:
                    continue
                sid, created = recorded[cid]
                seen, failed = _as_utc(t), _as_utc(created)
                if seen and failed and seen > failed:
                    back.append(sid)
    if back:
        await session.execute(delete(BotSuppression).where(BotSuppression.id.in_(back)))
        log.info("Bot %s: %d people used the bot again after a failed send", bot_id, len(back))


def mark_error(source: BotSource, exc: BaseException) -> None:
    message = safe_error(exc)
    if not isinstance(exc, SourceError):
        log.warning("Source %s for bot %s failed: %s", source.id, source.bot_id, message)
    source.status, source.last_error, source.last_checked_at = SourceStatus.ERROR, message, utcnow()


async def database_counts(
    session: AsyncSession, sources: dict[int, BotSource]
) -> dict[int, SubscriberCounts]:
    if not sources:
        return {}
    # Read the bots first: that also forgets failures of people who came back.
    live = {bot_id: await live_ids(session, source) for bot_id, source in sources.items()}
    orbit_lost: dict[int, dict[int, str]] = defaultdict(dict)
    rows = await session.execute(
        select(BotSuppression.bot_id, BotSuppression.chat_id, BotSuppression.reason).where(
            BotSuppression.bot_id.in_(list(sources))
        )
    )
    for bid, cid, reason in rows:
        orbit_lost[bid][cid] = "blocked" if reason == "blocked" else "unreachable"

    out: dict[int, SubscriberCounts] = {}
    for bot_id, source in sources.items():
        ids = live[bot_id]
        # One reason per chat: the bot's own record wins over what Orbit saw while sending.
        why = Counter({**orbit_lost[bot_id], **id_cache.lost(source)}.values())
        out[bot_id] = SubscriberCounts(
            active=len(ids) if ids is not None else (source.cached_count or 0),
            blocked=why["blocked"],
            left=why["left"],
            deleted=why["deleted"],
            unreachable=why["unreachable"],
            connected=True,
            source_error=None if ids is not None else source.last_error,
        )
    return out


async def database_people(session: AsyncSession, bot_ids: list[int]) -> set[int]:
    people: set[int] = set()
    for source in (await database_sources(session, bot_ids)).values():
        ids = await live_ids(session, source)
        if ids is not None:
            people |= ids
    return people


async def iter_audience(
    session: AsyncSession, source: BotSource, kinds: Sequence[str] = ()
) -> AsyncIterator[list[int]]:
    """Chunks of chat_ids to message at campaign start: suppressed and duplicates removed.
    `kinds` narrows it to people / groups / channels."""
    skip = await suppressed_ids(session, source.bot_id)
    seen: set[int] = set()
    async for chunk in stream_chat_ids(await engine_for(source), spec_of(source), kinds):
        fresh = [cid for cid in chunk if cid not in skip and cid not in seen]
        seen.update(fresh)
        if fresh:
            yield fresh


async def search_people(session: AsyncSession, bot_id: int, q: str, limit: int = 20) -> list[dict]:
    """Find a bot's users by Telegram ID, username or name in its database."""
    source = (await database_sources(session, [bot_id])).get(bot_id)
    if source is None:
        raise SourceError("Connect this bot's database to search its users")
    spec = spec_of(source)
    async with (await engine_for(source)).connect() as conn:
        src = await reflect(conn, spec)
        rows = (await conn.execute(search_query(src, spec, q, limit))).mappings().all()
    skip = await suppressed_ids(session, bot_id)
    out = []
    for r in rows:
        cid = as_chat_id(r["chat_id"])
        if cid is not None:
            out.append(
                {
                    "chat_id": cid,
                    "username": r.get("username"),
                    "first_name": r.get("first_name") or r.get("title"),
                    "last_name": r.get("last_name"),
                    "reachable": bool(r["can_receive"]) and cid not in skip,
                }
            )
    return out


# ---- audience numbers used across Orbit ----------------------------------------------


async def counts_by_bot(session: AsyncSession, bot_ids=None) -> dict[int, SubscriberCounts]:
    """Subscriber counts per bot. Bots without a database connected get zeros."""
    sources = await database_sources(session, list(bot_ids) if bot_ids is not None else None)
    out: dict[int, SubscriberCounts] = defaultdict(SubscriberCounts)
    out.update(await database_counts(session, sources))
    return out


async def active_audience_size(session: AsyncSession, bot_ids: list[int]) -> int:
    if not bot_ids:
        return 0
    counts = await counts_by_bot(session, bot_ids)
    return sum(counts[b].active for b in bot_ids)


async def unique_active_people(session: AsyncSession, bot_ids: list[int]) -> int:
    """Distinct people across all bots (private chat_id == Telegram user id)."""
    return len(await database_people(session, bot_ids))


async def iter_audience_people(
    session: AsyncSession, source: BotSource, kinds: Sequence[str] = ()
) -> AsyncIterator[list[tuple[int, dict]]]:
    """Like iter_audience, with each person's name fields for personalized messages."""
    skip = await suppressed_ids(session, source.bot_id)
    seen: set[int] = set()
    async for chunk in stream_people(await engine_for(source), spec_of(source), kinds):
        fresh = [(cid, v) for cid, v in chunk if cid not in skip and cid not in seen]
        seen.update(cid for cid, _ in fresh)
        if fresh:
            yield fresh


async def people_by_chat(
    session: AsyncSession, bot_id: int, chat_ids: list[int]
) -> dict[int, dict]:
    """Name fields for specific chats (picked people, test sends). Empty if unknown."""
    source = (await database_sources(session, [bot_id])).get(bot_id)
    if source is None or not chat_ids:
        return {}
    return await fetch_people(await engine_for(source), spec_of(source), chat_ids)


async def audience_size(session: AsyncSession, bot_id: int, kinds: Sequence[str]) -> int | None:
    """How many chats of these kinds a broadcast through this bot would reach right now
    (Orbit's own failures left out). None when the bot's database can't be read."""
    source = (await database_sources(session, [bot_id])).get(bot_id)
    if source is None:
        return 0
    try:
        ids = await collect_chat_ids(await engine_for(source), spec_of(source), kinds)
    except Exception:
        return None
    return len(ids - await suppressed_ids(session, bot_id))
