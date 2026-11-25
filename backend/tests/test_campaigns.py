import sqlite3
from datetime import UTC, datetime, timedelta

from tests.conftest import attach_users, connect_bot, drain


async def _setup(client, n_a=5, n_b=3):
    a = await connect_bot(client, 0)
    b = await connect_bot(client, 1)
    a["db"] = await attach_users(client, a["id"], list(range(100, 100 + n_a)))
    b["db"] = await attach_users(client, b["id"], list(range(200, 200 + n_b)))
    return a, b


async def _campaign(client, bot_ids, **message):
    msg = {"text": "<b>Hello</b>", "parse_mode": "HTML", **message}
    r = await client.post("/campaigns", json={"name": "Launch", "bot_ids": bot_ids, "message": msg})
    assert r.status_code == 201, r.text
    return r.json()


async def test_full_broadcast(client, telegram_fake, delivery_engine):
    a, b = await _setup(client)
    telegram_fake.blocked.add(101)
    telegram_fake.missing.add(202)
    telegram_fake.rate_limit_once.add(103)

    c = await _campaign(
        client,
        [a["id"], b["id"]],
        buttons=[{"text": "Open", "url": "https://example.com"}],
        disable_link_preview=True,
    )
    assert c["status"] == "draft"
    assert {x["audience"] for x in c["bots"]} == {5, 3}

    r = await client.post(f"/campaigns/{c['id']}/launch", json={})
    assert r.json()["status"] == "scheduled"
    await drain(delivery_engine)

    done = (await client.get(f"/campaigns/{c['id']}")).json()
    assert done["status"] == "completed"
    assert done["stats"] == {
        "pending": 0,
        "sent": 6,
        "failed": 1,
        "blocked": 1,
        "skipped": 0,
        "total": 8,
    }
    first = telegram_fake.sent[0]
    assert first["parse_mode"] == "HTML"
    assert first["reply_markup"]["inline_keyboard"][0][0]["url"] == "https://example.com"
    assert first["link_preview_options"] == {"is_disabled": True}

    subs = {x["username"]: x["subscribers"] for x in (await client.get("/bots")).json()}
    assert subs["alpha_bot"]["blocked"] == 1
    assert subs["beta_bot"]["unreachable"] == 1

    failed = (await client.get(f"/campaigns/{c['id']}/deliveries?status=failed")).json()
    assert failed["total"] == 1 and "chat not found" in failed["items"][0]["error"]


async def test_launch_validation(client):
    a, _ = await _setup(client)
    no_bots = await _campaign(client, [])
    assert (await client.post(f"/campaigns/{no_bots['id']}/launch", json={})).status_code == 422

    empty = await _campaign(client, [a["id"]], text="")
    assert (await client.post(f"/campaigns/{empty['id']}/launch", json={})).status_code == 422

    ok = await _campaign(client, [a["id"]])
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    r = await client.post(f"/campaigns/{ok['id']}/launch", json={"scheduled_at": past})
    assert r.status_code == 422


async def test_schedule_waits_until_due(client, telegram_fake, delivery_engine):
    a, _ = await _setup(client)
    c = await _campaign(client, [a["id"]])
    later = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    await client.post(f"/campaigns/{c['id']}/launch", json={"scheduled_at": later})
    await delivery_engine.tick()
    assert (await client.get(f"/campaigns/{c['id']}")).json()["status"] == "scheduled"
    assert telegram_fake.sent == []

    r = await client.post(f"/campaigns/{c['id']}/unschedule")
    assert r.json()["status"] == "draft"


async def test_pause_resume_cancel(client, telegram_fake, delivery_engine, monkeypatch):
    a, _ = await _setup(client, n_a=10)
    monkeypatch.setattr(delivery_engine._s, "delivery_batch_size", 4)
    c = await _campaign(client, [a["id"]])
    await client.post(f"/campaigns/{c['id']}/launch", json={})

    await delivery_engine.tick()  # starts + sends first batch of 4
    assert len(telegram_fake.sent) == 4
    assert (await client.post(f"/campaigns/{c['id']}/pause")).json()["status"] == "paused"
    await delivery_engine.tick()
    assert len(telegram_fake.sent) == 4

    await client.post(f"/campaigns/{c['id']}/resume")
    await delivery_engine.tick()
    assert len(telegram_fake.sent) == 8

    r = (await client.post(f"/campaigns/{c['id']}/cancel")).json()
    assert r["status"] == "cancelled"
    assert r["stats"]["skipped"] == 2 and r["stats"]["sent"] == 8
    await delivery_engine.tick()
    assert len(telegram_fake.sent) == 8

    # history is immutable, but the name can always change
    locked = await client.patch(f"/campaigns/{c['id']}", json={"message": {"text": "new"}})
    assert locked.status_code == 409
    renamed = await client.patch(f"/campaigns/{c['id']}", json={"name": "Renamed"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Renamed"
    dup = (await client.post(f"/campaigns/{c['id']}/duplicate")).json()
    assert dup["status"] == "draft" and dup["bot_ids"] == [a["id"]]


async def test_media_uploads_once_per_bot(client, telegram_fake, delivery_engine):
    a, b = await _setup(client, n_a=4, n_b=2)
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    media = await client.post("/media", files={"file": ("pic.png", png, "image/png")})
    assert media.status_code == 201 and media.json()["kind"] == "photo"

    c = await _campaign(client, [a["id"], b["id"]], media_id=media.json()["id"], text="caption")
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)

    photos = [m for m in telegram_fake.sent if m["method"] == "sendPhoto"]
    assert len(photos) == 6
    assert sum(1 for m in photos if m.get("_upload")) == 2  # one upload per bot
    reused = [m for m in photos if not m.get("_upload")]
    assert all(m["photo"].startswith("photo-") for m in reused)


async def test_new_subscribers_after_start_are_not_included(client, telegram_fake, delivery_engine):
    a, _ = await _setup(client, n_a=2)
    c = await _campaign(client, [a["id"]])
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await delivery_engine.tick()
    con = sqlite3.connect(a["db"])
    con.execute("INSERT INTO users (tg_id, active) VALUES (999, 1)")
    con.commit()
    con.close()
    await drain(delivery_engine)
    assert {m["chat_id"] for m in telegram_fake.sent} == {100, 101}


async def test_test_send(client, telegram_fake):
    a, _ = await _setup(client)
    r = await client.post(
        "/campaigns/test-send", json={"bot_id": a["id"], "chat_id": 42, "message": {"text": "hi"}}
    )
    assert r.status_code == 200
    telegram_fake.blocked.add(43)
    r = await client.post(
        "/campaigns/test-send", json={"bot_id": a["id"], "chat_id": 43, "message": {"text": "hi"}}
    )
    assert r.status_code == 422 and "Start" in r.json()["detail"]


async def test_standard_markdown_is_sent_as_markdown_v2(client, telegram_fake):
    a = await connect_bot(client)
    r = await client.post(
        "/campaigns/test-send",
        json={"bot_id": a["id"], "chat_id": 42, "message": {"text": "**Hi** _there_, v1.5!"}},
    )
    assert r.status_code == 200
    sent = telegram_fake.sent[-1]
    assert sent["parse_mode"] == "MarkdownV2"
    assert sent["text"] == "*Hi* _there_, v1\\.5\\!"


async def test_progress_timeline_eta_and_errors(
    client, telegram_fake, delivery_engine, monkeypatch
):
    a, b = await _setup(client, n_a=6, n_b=2)
    telegram_fake.blocked.update({101, 102})
    monkeypatch.setattr(delivery_engine._s, "delivery_batch_size", 3)

    est = (await client.get("/campaigns/estimate", params={"bot_ids": [a["id"], b["id"]]})).json()
    assert est["recipients"] == 8 and est["bots"] == [
        {"bot_id": a["id"], "recipients": 6},
        {"bot_id": b["id"], "recipients": 2},
    ]

    c = await _campaign(client, [a["id"], b["id"]])
    p = (await client.get(f"/campaigns/{c['id']}/progress")).json()
    assert p["points"] == [] and p["start"] is None and p["eta_seconds"] is None

    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await delivery_engine.tick()  # first batch only
    p = (await client.get(f"/campaigns/{c['id']}/progress")).json()
    assert p["eta_seconds"] is not None and p["eta_seconds"] > 0  # 3 of bot A still waiting
    assert p["per_minute"] > 0

    await drain(delivery_engine)
    p = (await client.get(f"/campaigns/{c['id']}/progress")).json()
    assert p["eta_seconds"] is None and p["per_minute"] == 0
    by = {}
    for pt in p["points"]:
        by[(pt["bot_id"], pt["outcome"])] = by.get((pt["bot_id"], pt["outcome"]), 0) + pt["count"]
    assert by == {(a["id"], "delivered"): 4, (a["id"], "blocked"): 2, (b["id"], "delivered"): 2}
    assert p["start"] is not None and p["end"] >= p["start"]
    assert p["errors"] == [
        {
            "bot_id": a["id"],
            "status": "blocked",
            "error": "Forbidden: bot was blocked by the user",
            "count": 2,
        }
    ]


async def test_progress_classifies_outcomes(client, telegram_fake, delivery_engine):
    a, _ = await _setup(client, n_a=4, n_b=1)
    telegram_fake.blocked.add(100)
    telegram_fake.missing.add(101)  # chat not found -> unreachable
    telegram_fake.rejected.add(102)  # anything else -> failed
    c = await _campaign(client, [a["id"]])
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    p = (await client.get(f"/campaigns/{c['id']}/progress")).json()
    outcomes = {pt["outcome"]: pt["count"] for pt in p["points"]}
    assert outcomes == {"delivered": 1, "blocked": 1, "unreachable": 1, "failed": 1}
