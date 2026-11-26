"""What happened on each bot recently, read from its database: joins, activity, losses.

Windows are rolling (the last 24 hours, the 24 before that, the last 7 days), so there's
no question of whose midnight "today" starts at."""

import asyncio
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import utcnow
from app.modules.sources.connection import safe_error
from app.modules.sources.models import BotSource, BotSuppression
from app.modules.sources.query import (
    _chat,
    as_chat_id,
    at_or_after,
    before,
    known_clause,
    lost_query,
    lost_reason,
    reflect,
)
from app.modules.sources.service import engine_for, spec_of

CACHE_SECONDS = 60
DAY = timedelta(days=1)


@dataclass
class Recent:
    joined: int | None = None  # last 24 hours (None: "Joined at" isn't mapped)
    joined_before: int | None = None  # the 24 hours before that
    active: int | None = None  # used the bot in the last 24 hours ("Last active" mapped)
    active_week: int | None = None
    # Became unreachable in the last 24 hours, by reason. None: losses can't be dated.
    lost: dict[str, int] | None = None
    error: str | None = None
    bot_lost: dict[int, str] = field(default_factory=dict)  # chat_id -> reason, for merging


_cache: dict[int, tuple[float, str, Recent]] = {}


def _fingerprint(source: BotSource) -> str:
    return repr((source.updated_at, source.column_map, source.filters, source.joins))


async def _from_database(source: BotSource, now: datetime) -> Recent:
    spec = spec_of(source)
    m = spec.column_map
    out = Recent()
    engine = await engine_for(source)
    async with engine.connect() as conn:
        src = await reflect(conn, spec)
        dialect = conn.dialect.name
        known, chat = known_clause(src, spec), _chat(src, spec)

        async def count(*conds) -> int:
            return await conn.scalar(select(func.count(distinct(chat))).where(known, *conds)) or 0

        if m.joined_at:
            out.joined = await count(at_or_after(src, m.joined_at, dialect, now - DAY))
            out.joined_before = await count(
                at_or_after(src, m.joined_at, dialect, now - 2 * DAY),
                before(src, m.joined_at, dialect, now - DAY),
            )
        if m.last_active_at:
            out.active = await count(at_or_after(src, m.last_active_at, dialect, now - DAY))
            out.active_week = await count(
                at_or_after(src, m.last_active_at, dialect, now - 7 * DAY)
            )

        dated = [ref for ref in (m.status_changed_at, m.unreachable_at) if ref]
        if dated:
            recent = or_(*(at_or_after(src, ref, dialect, now - DAY) for ref in dated))
            if (stmt := lost_query(src, spec, recent)) is not None:
                for row in (await conn.execute(stmt)).mappings():
                    if (cid := as_chat_id(row["chat_id"])) is not None:
                        out.bot_lost[cid] = lost_reason(row)
            out.lost = {}
    return out


async def recent_activity(
    session: AsyncSession, sources: dict[int, BotSource]
) -> dict[int, Recent]:
    """Per bot. Bots whose database can't be read get an empty Recent with the error."""
    now = utcnow()
    out: dict[int, Recent] = {}
    todo: dict[int, BotSource] = {}
    for bot_id, source in sources.items():
        hit = _cache.get(source.id)
        if hit and hit[1] == _fingerprint(source) and time.monotonic() - hit[0] < CACHE_SECONDS:
            out[bot_id] = hit[2]
        else:
            todo[bot_id] = source
    results = await asyncio.gather(
        *(_from_database(s, now) for s in todo.values()), return_exceptions=True
    )
    for (bot_id, source), r in zip(todo.items(), results, strict=True):
        if isinstance(r, BaseException):
            r = Recent(error=safe_error(r))
        else:
            _cache[source.id] = (time.monotonic(), _fingerprint(source), r)
        out[bot_id] = r

    # Losses Orbit itself saw while sending in the last 24 hours. The bot's record wins.
    rows = await session.execute(
        select(BotSuppression.bot_id, BotSuppression.chat_id, BotSuppression.reason).where(
            BotSuppression.bot_id.in_(list(sources)), BotSuppression.created_at >= now - DAY
        )
    )
    orbit_lost: dict[int, dict[int, str]] = {}
    for bid, cid, reason in rows:
        orbit_lost.setdefault(bid, {})[cid] = "blocked" if reason == "blocked" else "unreachable"
    for bot_id, r in out.items():
        merged = {**orbit_lost.get(bot_id, {}), **r.bot_lost}
        if r.lost is not None or merged:
            r.lost = dict(Counter(merged.values()))
    return out
