from tests.conftest import TOKENS, attach_users, connect_bot


async def test_requires_login(anon):
    assert (await anon.get("/bots")).status_code == 401
    r = await anon.post("/auth/login", json={"email": "ops@example.com", "password": "nope"})
    assert r.status_code == 401


async def test_connect_bot_validates_token(client):
    bot = await connect_bot(client)
    assert bot["username"] == "alpha_bot"
    assert "token" not in bot and "token_encrypted" not in bot and "api_key" not in bot
    assert bot["subscribers"] == {
        "active": 0,
        "blocked": 0,
        "unreachable": 0,
        "connected": False,
        "source_error": None,
        "total": 0,
    }

    dup = await client.post("/bots", json={"token": list(TOKENS)[0]})
    assert dup.status_code == 409

    bad = await client.post("/bots", json={"token": "999999:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"})
    assert bad.status_code == 422


async def test_counts_and_unique_people_across_bots(client):
    a = await connect_bot(client, 0)
    b = await connect_bot(client, 1)
    await attach_users(client, a["id"], [1, 2, 3, (4, "x", "X", 0)])  # 4 is inactive
    await attach_users(client, b["id"], [3, 5])

    bots = {x["username"]: x["subscribers"] for x in (await client.get("/bots")).json()}
    assert bots["alpha_bot"]["active"] == 3 and bots["alpha_bot"]["connected"] is True
    assert bots["beta_bot"]["active"] == 2

    ov = (await client.get("/overview")).json()
    assert ov["total_bots"] == 2
    assert ov["total_active_subscribers"] == 5
    assert ov["unique_people"] == 4  # chat 3 follows both bots


def test_plain_postgres_urls_use_asyncpg():
    from app.core.config import Settings

    for raw in ("postgres://u:p@db:5432/orbit", "postgresql://u:p@db:5432/orbit"):
        assert Settings(database_url=raw).database_url == "postgresql+asyncpg://u:p@db:5432/orbit"
    assert (
        Settings(database_url="sqlite+aiosqlite:///x.db").database_url == "sqlite+aiosqlite:///x.db"
    )
