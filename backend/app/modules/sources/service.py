import asyncio
import logging
import time
from collections import Counter, defaultdict
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import get_settings
from app.core.db import SessionLocal, upsert_insert, utcnow
from app.core.security import decrypt_secret
from app.modules.sources.connection import SourceError, engines, normalize_url, safe_error
from app.modules.sources.models import BotSource, BotSuppression, SourceKind, SourceStatus
from app.modules.sources.query import (
    CHUNK,
    active_since_query,
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
    """The reachable chat_id set per source, from its last refresh: unique people across
    bots and overlap need the ids themselves, not just counts. In memory only."""

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
            and time.monotonic() - hit[0] < get_settings().audience_ttl_seconds
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


class _Refresher:
    """Recomputes a bot's audience in the background: at most one run per bot at a time,
    and only when someone asked for numbers that were stale. Idle Orbit does nothing."""

    def __init__(self):
        self._tasks: dict[int, asyncio.Task] = {}

    def running(self, source_id: int) -> bool:
        task = self._tasks.get(source_id)
        return task is not None and not task.done()

    def schedule(self, source_id: int) -> asyncio.Task:
        task = self._tasks.get(source_id)
        if task is None or task.done():
            task = asyncio.create_task(_refresh(source_id))
            self._tasks[source_id] = task
        return task

    async def wait(self, source_id: int) -> None:
        await asyncio.shield(self.schedule(source_id))


refresher = _Refresher()


async def _refresh(source_id: int) -> None:
    """Read the bot's database and store a fresh snapshot of who it can reach."""
    try:
        async with SessionLocal() as session:
            source = await session.get(BotSource, source_id)
            if source is None:
                return
            try:
                engine, spec = await engine_for(source), spec_of(source)
                raw = await collect_chat_ids(engine, spec)
                lost = await collect_lost(engine, spec)
                await clear_returned(session, source, engine, spec)
            except Exception as exc:
                mark_error(source, exc)
                await session.commit()
                return
            failed = await orbit_failures(session, source.bot_id)
            ids = frozenset(raw - set(failed))
            # One reason per chat: the bot's own record wins over what Orbit saw sending.
            why = Counter({**failed, **lost}.values())
            now = utcnow()
            source.status, source.last_error, source.last_checked_at = (
                SourceStatus.HEALTHY,
                None,
                now,
            )
            source.cached_count, source.cached_count_at = len(ids), now
            source.cached_breakdown = {
                k: why[k] for k in ("blocked", "left", "deleted", "unreachable")
            }
            await session.commit()
            id_cache.put(source, ids, lost)
    except Exception:
        log.exception("Refreshing the audience of source %s failed", source_id)


async def orbit_failures(session: AsyncSession, bot_id: int) -> dict[int, str]:
    """chat_id -> blocked / unreachable, for chats Orbit saw fail while sending."""
    rows = await session.execute(
        select(BotSuppression.chat_id, BotSuppression.reason).where(BotSuppression.bot_id == bot_id)
    )
    return {cid: "blocked" if reason == "blocked" else "unreachable" for cid, reason in rows}


def _stale(source: BotSource) -> bool:
    if get_settings().audience_refresh_inline:  # tests: every read counts afresh
        return True
    at = source.cached_count_at
    return at is None or (utcnow() - at).total_seconds() >= get_settings().audience_ttl_seconds


async def live_ids(session: AsyncSession, source: BotSource) -> frozenset[int] | None:
    """Reachable chat_ids (Orbit's failures removed), or None if the database failed.
    Waits for a refresh when there's no recent one. For pages that need the ids."""
    if not get_settings().audience_refresh_inline and (ids := id_cache.fresh(source)) is not None:
        return ids
    await refresher.wait(source.id)
    await session.refresh(source)
    return id_cache.fresh(source)


def cached_ids(source: BotSource) -> frozenset[int] | None:
    """The last ids read, without waiting; starts a refresh when there are none."""
    ids = id_cache.fresh(source)
    if ids is None:
        refresher.schedule(source.id)
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
    session: AsyncSession, source: BotSource, engine: AsyncEngine, spec: SourceSpec
) -> None:
    """Forget a block or failure Orbit recorded if the person used the bot after it.

    Only chats active since the last check are read, so this stays cheap however many
    failures Orbit has recorded. Needs "Last active" mapped. Caller commits."""
    if not spec.column_map.last_active_at:
        return
    now = utcnow()
    since = source.returned_checked_at
    seen: dict[int, datetime] = {}
    async with engine.connect() as conn:
        src = await reflect(conn, spec)
        if since is None:  # first check: compare every recorded failure once
            recorded = [
                cid
                for (cid,) in await session.execute(
                    select(BotSuppression.chat_id).where(BotSuppression.bot_id == source.bot_id)
                )
            ]
            for i in range(0, len(recorded), 1000):
                for value, t in await conn.execute(
                    last_active_query(src, spec, recorded[i : i + 1000])
                ):
                    if (cid := as_chat_id(value)) is not None and (at := _as_utc(t)):
                        seen[cid] = at
        else:  # a few minutes' overlap covers clocks and slow writes
            query = active_since_query(src, spec, conn.dialect.name, since - timedelta(minutes=5))
            for value, t in await conn.execute(query):
                if (cid := as_chat_id(value)) is not None and (at := _as_utc(t)):
                    seen[cid] = at
    back: list[int] = []
    ids = list(seen)
    for i in range(0, len(ids), 1000):
        rows = await session.execute(
            select(BotSuppression.id, BotSuppression.chat_id, BotSuppression.created_at).where(
                BotSuppression.bot_id == source.bot_id,
                BotSuppression.chat_id.in_(ids[i : i + 1000]),
            )
        )
        for sid, cid, created in rows:
            if (failed := _as_utc(created)) and seen[cid] > failed:
                back.append(sid)
    if back:
        await session.execute(delete(BotSuppression).where(BotSuppression.id.in_(back)))
        log.info(
            "Bot %s: %d people used the bot again after a failed send", source.bot_id, len(back)
        )
    source.returned_checked_at = now


def mark_error(source: BotSource, exc: BaseException) -> None:
    message = safe_error(exc)
    if not isinstance(exc, SourceError):
        log.warning("Source %s for bot %s failed: %s", source.id, source.bot_id, message)
    source.status, source.last_error, source.last_checked_at = SourceStatus.ERROR, message, utcnow()


async def database_counts(
    session: AsyncSession, sources: dict[int, BotSource]
) -> dict[int, SubscriberCounts]:
    """Each bot's last snapshot, instantly. A stale one is refreshed in the background;
    only a bot with no snapshot yet (or tests, see audience_refresh_inline) waits."""
    inline = get_settings().audience_refresh_inline
    first = [s.id for s in sources.values() if s.cached_count_at is None or (inline and _stale(s))]
    if first:
        await asyncio.gather(*(refresher.wait(sid) for sid in first))
        for source in sources.values():
            await session.refresh(source)
    out: dict[int, SubscriberCounts] = {}
    for bot_id, source in sources.items():
        if _stale(source):
            refresher.schedule(source.id)
        why = source.cached_breakdown or {}
        out[bot_id] = SubscriberCounts(
            active=source.cached_count or 0,
            blocked=why.get("blocked", 0),
            left=why.get("left", 0),
            deleted=why.get("deleted", 0),
            unreachable=why.get("unreachable", 0),
            connected=True,
            source_error=source.last_error if source.status == SourceStatus.ERROR else None,
            refreshed_at=source.cached_count_at,
            refreshing=refresher.running(source.id),
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
