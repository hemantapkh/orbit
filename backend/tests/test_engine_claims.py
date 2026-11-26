"""Two delivery engines at once (old and new container during a deploy) never send the
same message twice, and messages claimed by an engine that died get sent later."""

import asyncio
from datetime import timedelta

from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.db import SessionLocal, utcnow
from app.modules.campaigns.engine import DeliveryEngine
from app.modules.campaigns.models import Delivery, DeliveryStatus
from tests.conftest import attach_users, connect_bot, drain

PEOPLE = list(range(1, 251))


async def started_campaign(client, delivery_engine) -> int:
    bot = await connect_bot(client, 0)
    await attach_users(client, bot["id"], PEOPLE)
    c = (
        await client.post(
            "/campaigns", json={"name": "x", "bot_ids": [bot["id"]], "message": {"text": "hi"}}
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await delivery_engine._start_due_campaigns()  # snapshot the audience, send nothing yet
    return c["id"]


async def test_two_engines_never_send_the_same_message(
    client, telegram_fake, tg_client, delivery_engine
):
    cid = await started_campaign(client, delivery_engine)
    other = DeliveryEngine(SessionLocal, tg_client, get_settings())
    for _ in range(10):
        if not any(await asyncio.gather(delivery_engine._send_tick(), other._send_tick())):
            break
    await drain(delivery_engine)
    sent = [m["chat_id"] for m in telegram_fake.sent]
    assert sorted(sent) == PEOPLE  # everyone once, nobody twice
    detail = (await client.get(f"/campaigns/{cid}")).json()
    assert detail["status"] == "completed" and detail["stats"]["sent"] == len(PEOPLE)


async def test_claims_of_a_dead_engine_are_sent_later(client, telegram_fake, delivery_engine):
    cid = await started_campaign(client, delivery_engine)
    async with SessionLocal() as s:  # an engine claimed 50 messages and was killed
        ids = (
            await s.scalars(select(Delivery.id).where(Delivery.campaign_id == cid).limit(50))
        ).all()
        await s.execute(
            update(Delivery)
            .where(Delivery.id.in_(ids))
            .values(status=DeliveryStatus.SENDING, claimed_at=utcnow() - timedelta(minutes=1))
        )
        await s.commit()

    await drain(delivery_engine)
    assert len(telegram_fake.sent) == 200  # a fresh claim isn't taken over...
    assert (await client.get(f"/campaigns/{cid}")).json()["status"] == "running"  # ...nor finished

    async with SessionLocal() as s:  # five minutes on, it's given up on
        await s.execute(
            update(Delivery)
            .where(Delivery.status == DeliveryStatus.SENDING)
            .values(claimed_at=utcnow() - timedelta(minutes=6))
        )
        await s.commit()
    await delivery_engine._release_stale()
    await drain(delivery_engine)
    assert sorted(m["chat_id"] for m in telegram_fake.sent) == PEOPLE
    assert (await client.get(f"/campaigns/{cid}")).json()["status"] == "completed"
