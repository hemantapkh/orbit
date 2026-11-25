from tests.conftest import TOKENS, connect_bot, push


async def test_requires_login(anon):
    assert (await anon.get("/bots")).status_code == 401
    r = await anon.post("/auth/login", json={"email": "ops@example.com", "password": "nope"})
    assert r.status_code == 401


async def test_connect_bot_validates_token(client):
    bot = await connect_bot(client)
    assert bot["username"] == "alpha_bot"
    assert bot["api_key"].startswith("orb_")
    assert "token" not in bot and "token_encrypted" not in bot

    dup = await client.post("/bots", json={"token": list(TOKENS)[0]})
    assert dup.status_code == 409

    bad = await client.post("/bots", json={"token": "999999:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"})
    assert bad.status_code == 422


async def test_integration_ingest_and_counts(client):
    a = await connect_bot(client, 0)
    b = await connect_bot(client, 1)

    assert (await push(client, "orb_wrong", [1])).status_code == 401
    r = await push(client, a["api_key"], [1, 2, 3, 3])
    assert r.status_code == 200 and r.json() == {"received": 3}
    await push(client, b["api_key"], [3, 4])
    await push(client, a["api_key"], [2], status="unsubscribed")

    bots = {x["username"]: x["subscribers"] for x in (await client.get("/bots")).json()}
    assert bots["alpha_bot"]["active"] == 2
    assert bots["alpha_bot"]["unsubscribed"] == 1
    assert bots["alpha_bot"]["total"] == 3
    assert bots["beta_bot"]["active"] == 2

    ov = (await client.get("/overview")).json()
    assert ov["total_bots"] == 2
    assert ov["total_active_subscribers"] == 4
    assert ov["unique_people"] == 3  # chat 3 follows both bots


async def test_rotate_key_revokes_old(client):
    a = await connect_bot(client)
    rotated = (await client.post(f"/bots/{a['id']}/rotate-key")).json()
    assert (await push(client, a["api_key"], [1])).status_code == 401
    assert (await push(client, rotated["api_key"], [1])).status_code == 200


async def test_disabled_bot_cannot_ingest(client):
    a = await connect_bot(client)
    await client.patch(f"/bots/{a['id']}", json={"is_active": False})
    assert (await push(client, a["api_key"], [1])).status_code == 403

