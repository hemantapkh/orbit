import asyncio
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db import upsert_insert, utcnow
from app.core.security import decrypt_secret
from app.modules.sources.connection import SourceError, engines, normalize_url, safe_error
from app.modules.sources.models import BotSource, BotSuppression, SourceKind, SourceStatus
from app.modules.sources.query import (
    as_chat_id,
    count_query,
    fetch_people,
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
        self._data: dict[int, tuple[float, str, frozenset[int]]] = {}
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

    def put(self, source: BotSource, ids: frozenset[int]) -> None:
        self._data[source.id] = (time.monotonic(), self._fingerprint(source), ids)

    def lock(self, source_id: int) -> asyncio.Lock:
        return self._locks[source_id]

    def drop(self, source_id: int) -> None:
        self._data.pop(source_id, None)


id_cache = _IdCache()


async def collect_chat_ids(engine: AsyncEngine, spec: SourceSpec) -> set[int]:
    ids: set[int] = set()
    async for chunk in stream_chat_ids(engine, spec):
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
            raw = await collect_chat_ids(await engine_for(source), spec_of(source))
        except Exception as exc:
            mark_error(source, exc)
            await session.commit()
            return None
        ids = frozenset(raw - await suppressed_ids(session, source.bot_id))
        now = utcnow()
        source.status, source.last_error, source.last_checked_at = SourceStatus.HEALTHY, None, now
        source.cached_count, source.cached_count_at = len(ids), now
        await session.commit()
        id_cache.put(source, ids)
        return ids


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
    by_reason: dict[int, dict[str, int]] = defaultdict(dict)
    rows = await session.execute(
        select(BotSuppression.bot_id, BotSuppression.reason, func.count())
        .where(BotSuppression.bot_id.in_(list(sources)))
        .group_by(BotSuppression.bot_id, BotSuppression.reason)
    )
    for bid, reason, n in rows:
        by_reason[bid][reason] = n

    out: dict[int, SubscriberCounts] = {}
    for bot_id, source in sources.items():
        ids = await live_ids(session, source)
        out[bot_id] = SubscriberCounts(
            active=len(ids) if ids is not None else (source.cached_count or 0),
            blocked=by_reason[bot_id].get("blocked", 0),
            unreachable=by_reason[bot_id].get("unreachable", 0),
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


async def iter_audience(session: AsyncSession, source: BotSource) -> AsyncIterator[list[int]]:
    """Chunks of chat_ids to message at campaign start: suppressed and duplicates removed."""
    skip = await suppressed_ids(session, source.bot_id)
    seen: set[int] = set()
    async for chunk in stream_chat_ids(await engine_for(source), spec_of(source)):
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
                    "first_name": r.get("first_name"),
                    "last_name": r.get("last_name"),
                    "reachable": cid not in skip,
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
    session: AsyncSession, source: BotSource
) -> AsyncIterator[list[tuple[int, dict]]]:
    """Like iter_audience, with each person's name fields for personalized messages."""
    skip = await suppressed_ids(session, source.bot_id)
    seen: set[int] = set()
    async for chunk in stream_people(await engine_for(source), spec_of(source)):
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
