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
        "left": 0,
        "deleted": 0,
        "unreachable": 0,
        "connected": False,
        "source_error": None,
        "refreshed_at": None,
        "refreshing": False,
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
    reach = (await client.get("/overview/reach")).json()
    assert reach == {"unique_people": 4, "pending": False}  # chat 3 follows both bots


def test_plain_postgres_urls_use_asyncpg():
    from app.core.config import Settings

    for raw in ("postgres://u:p@db:5432/orbit", "postgresql://u:p@db:5432/orbit"):
        assert Settings(database_url=raw).database_url == "postgresql+asyncpg://u:p@db:5432/orbit"
    assert (
        Settings(database_url="sqlite+aiosqlite:///x.db").database_url == "sqlite+aiosqlite:///x.db"
    )


async def test_bot_profile_photo_and_texts(client, telegram_fake):
    bot = await connect_bot(client)
    assert bot["about"] == "About Alpha" and bot["telegram_description"] == "Press Start to begin."
    assert bot["avatar_version"] == "v1"
    photo = await client.get(f"/bots/{bot['id']}/avatar")
    assert photo.status_code == 200 and photo.content == telegram_fake.PHOTO
    assert photo.headers["content-type"] == "image/jpeg"
    # the Telegram file link (which contains the token) never reaches the client
    assert "AAAA" not in photo.text and "file/bot" not in str(photo.headers)

    telegram_fake.photo_version = 2
    refreshed = (await client.post(f"/bots/{bot['id']}/refresh")).json()
    assert refreshed["avatar_version"] == "v2"

    telegram_fake.with_photo = False
    gone = (await client.post(f"/bots/{bot['id']}/refresh")).json()
    assert gone["avatar_version"] is None
    assert (await client.get(f"/bots/{bot['id']}/avatar")).status_code == 404


async def test_profile_failure_never_blocks_connecting(client, telegram_fake, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("telegram is down")

    monkeypatch.setattr("app.modules.bots.profile.fetch_profile", boom)
    bot = await connect_bot(client)
    assert bot["avatar_version"] is None and bot["about"] == ""


async def test_refresh_all_bots(client, telegram_fake):
    a = await connect_bot(client, 0)
    await connect_bot(client, 1)
    telegram_fake.photo_version = 7
    bots = (await client.post("/bots/refresh")).json()
    assert {b["username"] for b in bots} == {"alpha_bot", "beta_bot"}
    assert all(b["avatar_version"] == "v7" for b in bots)
    one = (await client.post(f"/bots/{a['id']}/refresh")).json()
    assert one["token_valid"] is True
