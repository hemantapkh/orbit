"""Audience numbers come from a stored snapshot: instant to read, refreshed in the
background only when someone asks for stale numbers."""

from datetime import timedelta

import pytest
from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.db import SessionLocal, utcnow
from app.modules.sources import service
from app.modules.sources.models import BotSource, BotSuppression
from tests.conftest import connect_bot
from tests.test_standard_chats import NOW, connect_chats


@pytest.fixture
def background_refresh(monkeypatch):
    monkeypatch.setattr(get_settings(), "audience_refresh_inline", False)


async def refreshed(bot_id):
    """Wait for the background refresh of this bot's numbers to finish."""
    async with SessionLocal() as s:
        source_id = await s.scalar(select(BotSource.id).where(BotSource.bot_id == bot_id))
    await service.refresher.wait(source_id)


async def counts(client, bot_id):
    return (await client.get(f"/bots/{bot_id}")).json()["subscribers"]


async def age_snapshot(bot_id, minutes=10):
    async with SessionLocal() as s:
        await s.execute(
            update(BotSource)
            .where(BotSource.bot_id == bot_id)
            .values(cached_count_at=utcnow() - timedelta(minutes=minutes))
        )
        await s.commit()


async def test_stale_numbers_answer_at_once_and_refresh_behind(client, background_refresh):
    bot = await connect_bot(client, 0)
    await connect_chats(client, bot["id"], "snapshots")  # can receive: 1, 5 and -100

    first = await counts(client, bot["id"])  # no snapshot yet: this one waits for a count
    assert first["active"] == 3 and first["refreshed_at"] and not first["refreshing"]

    async with SessionLocal() as s:  # Orbit sees Dee fail to receive a message
        s.add(BotSuppression(bot_id=bot["id"], chat_id=5, reason="blocked", created_at=utcnow()))
        await s.commit()
    assert (await counts(client, bot["id"]))["active"] == 3  # fresh snapshot: not re-read

    await age_snapshot(bot["id"])
    stale = await counts(client, bot["id"])
    assert stale["active"] == 3 and stale["refreshing"]  # old numbers, newer ones coming
    await refreshed(bot["id"])
    fresh = await counts(client, bot["id"])
    assert fresh["active"] == 2 and fresh["blocked"] == 2 and not fresh["refreshing"]


async def test_only_recent_activity_is_checked_for_returns(client, background_refresh):
    bot = await connect_bot(client, 0)
    await connect_chats(client, bot["id"], "returns")
    await counts(client, bot["id"])  # first refresh: the full check, nothing recorded yet

    async with SessionLocal() as s:  # failures Orbit saw two days ago
        for cid in (1, 5):
            s.add(
                BotSuppression(
                    bot_id=bot["id"],
                    chat_id=cid,
                    reason="blocked",
                    created_at=NOW - timedelta(days=2),
                )
            )
        await s.commit()
    # Dee (5) was active just now, Ana (1) nine days ago: only Dee counts as back.
    await age_snapshot(bot["id"])
    await counts(client, bot["id"])
    await refreshed(bot["id"])
    async with SessionLocal() as s:
        left = (await s.scalars(select(BotSuppression.chat_id))).all()
        checked = await s.scalar(select(BotSource.returned_checked_at))
    assert left == [1] and checked is not None
