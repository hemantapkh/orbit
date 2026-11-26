"""The People list and person view across two bots: one on the shared chats schema, one
with a minimal users table (no status, type or activity mapped)."""

from app.core.db import SessionLocal
from app.modules.people import service
from app.modules.sources.models import BotSuppression
from tests.conftest import attach_users, connect_bot, drain
from tests.test_standard_chats import connect_chats


async def two_bots(client):
    service._cache.clear()
    a = await connect_bot(client, 0)  # chats 1, 2, 3, 4, 5, -100, -200 (see test_standard_chats)
    await connect_chats(client, a["id"], "people")
    b = await connect_bot(client, 1)
    await attach_users(client, b["id"], [(1, "ana", "Ana"), (5, "dee", "Dee"), (77, "zed", "Zed")])
    return a["id"], b["id"]


async def people(client, **params):
    r = await client.get("/people", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def test_list_merges_bots_and_filters(client):
    a, b = await two_bots(client)

    every = await people(client)
    assert every["total"] == 8  # 7 chats on a, plus 77 only on b
    assert every["items"][0]["chat_id"] in (5, -100)  # most recently active first
    dee = next(p for p in every["items"] if p["chat_id"] == 5)
    assert [r["bot_id"] for r in dee["bots"]] == [a, b] and dee["name"] == "Dee"
    group = next(p for p in every["items"] if p["chat_id"] == -100)
    assert (group["name"], group["kind"]) == ("Movie club", "supergroup")

    assert {p["chat_id"] for p in (await people(client, status="can_receive"))["items"]} == {
        1,
        5,
        77,
        -100,
    }
    assert [p["chat_id"] for p in (await people(client, multi="true"))["items"]] == [5, 1]
    assert [p["chat_id"] for p in (await people(client, q="dee"))["items"]] == [5]

    # Filters bot b can't apply leave it out, and say why.
    blocked = await people(client, status="blocked")
    assert [p["chat_id"] for p in blocked["items"]] == [2]
    assert blocked["skipped"] == {str(b): ["Bot's status"]}
    groups = await people(client, kind="groups")
    assert {p["chat_id"] for p in groups["items"]} == {-100, -200}
    assert groups["skipped"] == {str(b): ["Chat type"]}
    week = await people(client, active="7d", bot=a)
    assert {p["chat_id"] for p in week["items"]} == {5, -100} and week["skipped"] == {}
    assert {p["chat_id"] for p in (await people(client, active="dormant_30d", bot=a))["items"]} == {
        2,
        3,
        4,
        -200,
    }
    assert [p["chat_id"] for p in (await people(client, premium="true"))["items"]] == [1]

    page = await people(client, size=10, page=1, bot=a)
    assert page["total"] == 7 and len(page["items"]) == 7


async def test_orbit_failures_and_person_view(client, telegram_fake, delivery_engine):
    a, b = await two_bots(client)
    async with SessionLocal() as s:  # Orbit saw Ana block bot a while sending
        s.add(BotSuppression(bot_id=a, chat_id=1, reason="blocked"))
        await s.commit()
    service._cache.clear()

    assert {p["chat_id"] for p in (await people(client, status="blocked", bot=a))["items"]} == {
        1,
        2,
    }
    ana = next(p for p in (await people(client))["items"] if p["chat_id"] == 1)
    assert {r["bot_id"]: r["category"] for r in ana["bots"]} == {a: "blocked", b: "can_receive"}

    c = (
        await client.post(
            "/campaigns", json={"name": "Hello", "bot_ids": [a], "message": {"text": "hi"}}
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)

    dee = (await client.get("/people/5")).json()
    assert dee["person"]["username"] == "dee" and len(dee["person"]["bots"]) == 2
    assert [(r["campaign_name"], r["bot_id"], r["status"]) for r in dee["received"]] == [
        ("Hello", a, "sent")
    ]
    assert (await client.get("/people/999")).json() == {"person": None, "received": []}
