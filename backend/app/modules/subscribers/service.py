from collections import defaultdict
from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import upsert_insert, utcnow
from app.modules.sources.service import database_counts, database_people, database_sources
from app.modules.subscribers.models import Subscriber, SubscriberStatus
from app.modules.subscribers.schemas import SubscriberCounts, SubscriberIn


async def counts_by_bot(
    session: AsyncSession, bot_ids: Iterable[int] | None = None
) -> dict[int, SubscriberCounts]:
    """Subscriber counts per bot, whichever source the bot uses.

    Database-source bots are counted live from their own database (cached ~60s)."""
    wanted = list(bot_ids) if bot_ids is not None else None
    db_sources = await database_sources(session, wanted)

    stmt = select(Subscriber.bot_id, Subscriber.status, func.count()).group_by(
        Subscriber.bot_id, Subscriber.status
    )
    if wanted is not None:
        stmt = stmt.where(Subscriber.bot_id.in_(wanted))
    raw: dict[int, dict[str, int]] = defaultdict(dict)
    for bot_id, status, n in await session.execute(stmt):
        if bot_id not in db_sources:
            raw[bot_id][status] = n
    out = defaultdict(SubscriberCounts, {b: SubscriberCounts(**c) for b, c in raw.items()})
    out.update(await database_counts(session, db_sources))
    return out


async def active_audience_size(session: AsyncSession, bot_ids: list[int]) -> int:
    if not bot_ids:
        return 0
    counts = await counts_by_bot(session, bot_ids)
    return sum(counts[b].active for b in bot_ids)


async def unique_active_people(session: AsyncSession) -> int:
    """Distinct people across all bots (private chat_id == Telegram user id).

    TODO(scale): builds the full set in Python, including every database-source bot's
    chat_ids. Move to a periodic job once audiences reach the hundreds of thousands."""
    db_bot_ids = list((await database_sources(session)).keys())
    stmt = select(Subscriber.chat_id).where(Subscriber.status == SubscriberStatus.ACTIVE).distinct()
    if db_bot_ids:
        stmt = stmt.where(Subscriber.bot_id.not_in(db_bot_ids))
    people = set((await session.scalars(stmt)).all())
    people |= await database_people(session)
    return len(people)


async def upsert_subscribers(session: AsyncSession, bot_id: int, items: list[SubscriberIn]) -> int:
    now = utcnow()
    # Last write wins if the same chat appears twice in one batch.
    by_chat = {s.chat_id: s for s in items}
    rows = [
        {
            "bot_id": bot_id,
            "chat_id": s.chat_id,
            "username": s.username,
            "first_name": s.first_name,
            "last_name": s.last_name,
            "language_code": s.language_code,
            "status": s.status.value,
            "subscribed_at": s.subscribed_at or now,
            "last_seen_at": now,
            "attributes": s.attributes,
            "created_at": now,
            "updated_at": now,
        }
        for s in by_chat.values()
    ]
    stmt = upsert_insert()(Subscriber).values(rows)
    ex = stmt.excluded
    stmt = stmt.on_conflict_do_update(
        index_elements=[Subscriber.bot_id, Subscriber.chat_id],
        set_={
            "username": ex.username,
            "first_name": ex.first_name,
            "last_name": ex.last_name,
            "language_code": ex.language_code,
            "status": ex.status,
            "last_seen_at": ex.last_seen_at,
            "attributes": ex.attributes,
            "updated_at": ex.updated_at,
        },
    )
    await session.execute(stmt)
    return len(rows)
