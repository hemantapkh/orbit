from tests.conftest import attach_users, connect_bot, drain


async def _sent_campaign(client, delivery_engine, **message):
    a = await connect_bot(client)
    await attach_users(client, a["id"], [(5001, "ana", "Ana"), (5002, "bo", "Bo")])
    picked = [{"bot_id": a["id"], "chat_id": 5001, "label": "Ana (@ana)"}]
    c = (
        await client.post(
            "/campaigns",
            json={
                "name": "Launch",
                "bot_ids": [a["id"]],
                "message": {"text": "**Secret sauce**", **message},
                "audience": {"mode": "selected", "recipients": picked},
            },
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    return c


async def test_share_is_read_only_and_leaks_nothing_personal(client, anon, delivery_engine):
    c = await _sent_campaign(client, delivery_engine)

    shared = (await client.put(f"/campaigns/{c['id']}/share", json={})).json()
    token = shared["share"]["token"]
    assert len(token) >= 40

    await client.post("/auth/logout")  # viewers aren't signed in
    r = await anon.get(f"/public/shares/{token}")
    assert r.status_code == 200
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["cache-control"] == "no-store"
    assert "noindex" in r.headers["x-robots-tag"]
    body = r.json()
    assert body["name"] == "Launch" and body["status"] == "completed" and body["reach"] == 1
    assert body["stats"]["sent"] == 1 and body["message"]["text"] == "**Secret sauce**"
    # nothing that identifies a person or an operator
    for leaked in ("5001", "Ana", "@ana", "recipients", "ops@example.com", "token_encrypted"):
        assert leaked not in r.text
    # no admin access through the share
    assert (await anon.get(f"/campaigns/{c['id']}")).status_code == 401
    assert (await anon.post(f"/campaigns/{c['id']}/pause")).status_code == 401


async def test_hide_message_regenerate_and_revoke(client, anon, delivery_engine):
    c = await _sent_campaign(client, delivery_engine)
    first = (await client.put(f"/campaigns/{c['id']}/share", json={"hide_message": True})).json()
    t1 = first["share"]["token"]
    body = (await anon.get(f"/public/shares/{t1}")).json()
    assert body["message"] is None and body["media"] is None

    second = (await client.put(f"/campaigns/{c['id']}/share", json={"regenerate": True})).json()
    t2 = second["share"]["token"]
    assert t2 != t1
    assert (await anon.get(f"/public/shares/{t1}")).status_code == 404
    assert (await anon.get(f"/public/shares/{t2}")).status_code == 200

    off = (await client.delete(f"/campaigns/{c['id']}/share")).json()
    assert off["share"] is None
    assert (await anon.get(f"/public/shares/{t2}")).status_code == 404
    assert (await anon.get("/public/shares/short")).status_code == 404

    log = (
        await client.get("/activity", params={"entity_type": "campaign", "entity_id": c["id"]})
    ).json()
    assert [e["action"] for e in log][:3] == [
        "campaign.unshared",
        "campaign.share_regenerated",
        "campaign.shared",
    ]


async def test_drafts_cannot_be_shared(client):
    a = await connect_bot(client)
    c = (await client.post("/campaigns", json={"name": "x", "bot_ids": [a["id"]]})).json()
    assert (await client.put(f"/campaigns/{c['id']}/share", json={})).status_code == 409


def test_share_tokens_are_masked_in_access_logs():
    import logging

    from app.main import _HideShareTokens

    rec = logging.LogRecord(
        "uvicorn.access",
        20,
        "",
        0,
        '%s - "%s %s"',
        (
            "1.2.3.4",
            "GET",
            "/api/public/shares/" + "A" * 43,
        ),
        None,
    )
    _HideShareTokens().filter(rec)
    assert rec.args[2] == "/api/public/shares/***"
