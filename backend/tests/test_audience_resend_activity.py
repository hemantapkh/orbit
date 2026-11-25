from app.core.db import SessionLocal
from app.modules.sources.models import BotSuppression
from tests.conftest import attach_users, connect_bot, drain


async def test_selected_people_resend_and_activity(client, telegram_fake, delivery_engine):
    a = await connect_bot(client, 0)
    await attach_users(
        client, a["id"], [(11, "ana", "Ana"), (12, "bob", "Bob"), (13, "anil", "Anil"), 14, 15]
    )
    async with SessionLocal() as s:  # anil blocked the bot earlier
        s.add(BotSuppression(bot_id=a["id"], chat_id=13, reason="blocked"))
        await s.commit()

    hits = (await client.get(f"/bots/{a['id']}/people", params={"q": "an"})).json()
    assert {(h["chat_id"], h["reachable"]) for h in hits} == {(11, True), (13, False)}
    assert [
        h["chat_id"]
        for h in (await client.get(f"/bots/{a['id']}/people", params={"q": "12"})).json()
    ] == [12]

    picked = [{"bot_id": a["id"], "chat_id": c, "label": "x"} for c in (11, 13)]
    c = (
        await client.post(
            "/campaigns",
            json={
                "name": "Test group",
                "bot_ids": [a["id"]],
                "message": {"text": "hi"},
                "audience": {"mode": "selected", "recipients": picked},
            },
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    assert [m["chat_id"] for m in telegram_fake.sent] == [11]  # 13 blocked the bot

    # resend to everyone: same message, linked to the original
    again = (await client.post(f"/campaigns/{c['id']}/duplicate")).json()
    assert again["source_campaign_id"] == c["id"] and again["name"] == "Test group"
    r = await client.patch(f"/campaigns/{again['id']}", json={"audience": {"mode": "all"}})
    assert r.status_code == 200
    await client.post(f"/campaigns/{again['id']}/launch", json={})
    await drain(delivery_engine)
    assert sorted(m["chat_id"] for m in telegram_fake.sent) == [11, 11, 12, 14, 15]

    third = (await client.post(f"/campaigns/{again['id']}/duplicate")).json()
    assert third["source_campaign_id"] == c["id"]  # always points at the first send
    detail = (await client.get(f"/campaigns/{c['id']}")).json()
    assert [s["id"] for s in detail["sends"]] == [c["id"], again["id"], third["id"]]
    assert [s["stats"]["sent"] for s in detail["sends"]] == [1, 4, 0]

    log = (
        await client.get("/activity", params={"entity_type": "campaign", "entity_id": c["id"]})
    ).json()
    assert [e["action"] for e in log][::-1] == [
        "campaign.created",
        "campaign.launched",
        "campaign.started",
        "campaign.completed",
    ]
    assert log[-1]["actor_email"] == "ops@example.com" and log[1]["actor_email"] is None

    bot_log = (
        await client.get("/activity", params={"entity_type": "bot", "entity_id": a["id"]})
    ).json()
    assert bot_log[-1]["action"] == "bot.connected"


async def test_selected_people_must_belong_to_campaign_bots(client):
    a = await connect_bot(client, 0)
    r = await client.post(
        "/campaigns",
        json={
            "name": "x",
            "bot_ids": [a["id"]],
            "audience": {"mode": "selected", "recipients": [{"bot_id": 999, "chat_id": 1}]},
        },
    )
    assert r.status_code == 422
    empty = (
        await client.post(
            "/campaigns",
            json={
                "name": "x",
                "bot_ids": [a["id"]],
                "message": {"text": "hi"},
                "audience": {"mode": "selected"},
            },
        )
    ).json()
    assert (await client.post(f"/campaigns/{empty['id']}/launch", json={})).status_code == 422


async def test_delete_any_broadcast_except_while_sending(client, telegram_fake, delivery_engine):
    a = await connect_bot(client, 0)
    await attach_users(client, a["id"], [1, 2])
    first = (
        await client.post(
            "/campaigns", json={"name": "x", "bot_ids": [a["id"]], "message": {"text": "hi"}}
        )
    ).json()
    await client.post(f"/campaigns/{first['id']}/launch", json={})
    await delivery_engine.tick()  # running now
    assert (await client.get(f"/campaigns/{first['id']}")).json()["status"] == "running"
    assert (await client.delete(f"/campaigns/{first['id']}")).status_code == 409
    await drain(delivery_engine)

    second = (await client.post(f"/campaigns/{first['id']}/duplicate")).json()
    third = (await client.post(f"/campaigns/{first['id']}/duplicate")).json()

    # deleting the original (completed) keeps the resends grouped under the oldest one
    assert (await client.delete(f"/campaigns/{first['id']}")).status_code == 204
    assert (await client.get(f"/campaigns/{first['id']}")).status_code == 404
    detail = (await client.get(f"/campaigns/{third['id']}")).json()
    assert detail["source_campaign_id"] == second["id"]
    assert [s["id"] for s in detail["sends"]] == [second["id"], third["id"]]
    assert (await client.get(f"/campaigns/{first['id']}/deliveries")).status_code == 404
