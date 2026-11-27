import sqlite3

import pytest
from sqlalchemy import select

from app.core.db import SessionLocal
from app.modules.sources.models import BotSuppression
from app.modules.sources.service import id_cache
from tests.conftest import attach_users, connect_bot, drain

USERS = [
    # id, tg_id, username, first_name, is_active, plan
    (1, 5001, "ana", "Ana", 1, "pro"),
    (2, 5002, "bo", "Bo", 1, "free"),
    (3, 5003, None, "Cy", 0, "pro"),  # inactive: excluded by the active flag
    (4, 5004, "di", "Di", 1, "pro"),
    (5, None, "ed", "Ed", 1, "free"),  # no telegram id: excluded
    (6, 5006, "fa", "Fa", 1, "pro"),
    (7, 5001, "ana2", "Ana", 1, "pro"),  # duplicate chat id
]


@pytest.fixture
def bot_db(tmp_path):
    path = tmp_path / "botdb.sqlite"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE users (
            id INTEGER PRIMARY KEY, tg_id INTEGER, username TEXT, first_name TEXT,
            is_active INTEGER, plan TEXT, created_at TEXT DEFAULT '2026-01-01T00:00:00'
        );
        CREATE VIEW pro_users AS SELECT * FROM users WHERE plan = 'pro';
        CREATE TABLE leads (chat_id TEXT, name TEXT);
        INSERT INTO leads VALUES ('abc', 'x'), ('6001', 'y');
        """
    )
    con.executemany(
        "INSERT INTO users (id, tg_id, username, first_name, is_active, plan) VALUES (?,?,?,?,?,?)",
        USERS,
    )
    con.commit()
    con.close()
    return path


def url(path) -> str:
    return f"sqlite:///{path}"


MAPPING = {
    "chat_id": "tg_id",
    "username": "username",
    "first_name": "first_name",
    "is_active": "is_active",
}


async def save_source(client, bot_id, path, **extra):
    body = {"database_url": url(path), "table": "users", "column_map": MAPPING, **extra}
    r = await client.put(f"/bots/{bot_id}/source", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def test_rejects_unsupported_scheme(client):
    r = await client.post("/sources/test", json={"database_url": "mysql://u:p@h/db"})
    assert r.status_code == 422 and "Only PostgreSQL" in r.json()["detail"]


async def test_connection_error_is_readable_and_secret_free(client):
    r = await client.post(
        "/sources/test", json={"database_url": "postgresql://bob:hunter2@127.0.0.1:1/nope"}
    )
    assert r.status_code == 422
    assert "hunter2" not in r.text and "reach the database" in r.json()["detail"]


async def test_introspect(client, bot_db):
    r = await client.post("/sources/introspect", json={"database_url": url(bot_db)})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["connection"]["driver"] == "SQLite"
    tables = {t["name"]: t for t in data["tables"]}
    assert tables["users"]["kind"] == "table" and tables["users"]["row_estimate"] == len(USERS)
    assert tables["pro_users"]["kind"] == "view"
    assert {c["name"] for c in tables["users"]["columns"]} >= {"tg_id", "username", "is_active"}
    assert tables["users"]["suggested"] == {
        "chat_id": "tg_id",
        "username": "username",
        "first_name": "first_name",
        "joined_at": "created_at",
        "is_active": "is_active",
    }
    assert tables["leads"]["suggested"]["chat_id"] == "chat_id"


async def test_mapping_validation(client, bot_db):
    base = {"database_url": url(bot_db), "table": "users"}
    r = await client.post("/sources/preview", json={**base, "column_map": {"chat_id": "nope"}})
    assert r.status_code == 422 and r.json()["detail"] == "Column nope doesn't exist in users"

    r = await client.post(
        "/sources/preview",
        json={
            **base,
            "column_map": {"chat_id": "tg_id"},
            "filters": [{"column": "ghost", "op": "is_null"}],
        },
    )
    assert r.status_code == 422 and "ghost" in r.json()["detail"]

    r = await client.post(
        "/sources/preview", json={**base, "table": "missing", "column_map": {"chat_id": "id"}}
    )
    assert r.status_code == 422 and "missing doesn't exist" in r.json()["detail"]

    # filter values are coerced to the column type, bad values are rejected
    r = await client.post(
        "/sources/preview",
        json={
            **base,
            "column_map": {"chat_id": "tg_id"},
            "filters": [{"column": "id", "op": "eq", "value": "x"}],
        },
    )
    assert r.status_code == 422 and "isn't a valid value" in r.json()["detail"]


async def test_preview(client, bot_db):
    r = await client.post(
        "/sources/preview",
        json={
            "database_url": url(bot_db),
            "table": "users",
            "column_map": MAPPING,
            "filters": [{"column": "plan", "op": "eq", "value": "pro"}],
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    # pro + active + has tg_id: 5001 (twice), 5004, 5006 -> 3 distinct
    assert data["total"] == 3
    assert data["rows"][0] == {
        "chat_id": 5001,
        "username": "ana",
        "first_name": "Ana",
        "is_active": 1,
    }
    assert data["warnings"] == []

    r = await client.post(
        "/sources/preview",
        json={"database_url": url(bot_db), "table": "leads", "column_map": {"chat_id": "chat_id"}},
    )
    assert any("aren't numeric" in w for w in r.json()["warnings"])


async def test_save_and_counts_with_suppressions(client, bot_db):
    bot = await connect_bot(client)
    saved = await save_source(client, bot["id"], bot_db)
    assert saved["kind"] == "database" and saved["table"] == "users"
    assert saved["cached_count"] == 4 and saved["status"] == "healthy"

    got = await client.get(f"/bots/{bot['id']}/source")
    assert "database_url" not in got.json() and str(bot_db) not in got.text
    assert got.json()["database"] == "botdb.sqlite"

    counts = (await client.get(f"/bots/{bot['id']}")).json()["subscribers"]
    assert counts["active"] == 4 and counts["connected"] is True

    async with SessionLocal() as s:
        s.add(BotSuppression(bot_id=bot["id"], chat_id=5002, reason="blocked"))
        await s.commit()
    id_cache._data.clear()
    counts = (await client.get(f"/bots/{bot['id']}")).json()["subscribers"]
    assert counts["active"] == 3 and counts["blocked"] == 1

    ov = (await client.get("/overview")).json()
    assert ov["total_active_subscribers"] == 3
    assert (await client.get("/overview/reach")).json()["unique_people"] == 3

    # editing without a URL keeps the saved connection
    r = await client.put(
        f"/bots/{bot['id']}/source",
        json={
            "table": "users",
            "column_map": MAPPING,
            "filters": [{"column": "plan", "op": "eq", "value": "pro"}],
        },
    )
    assert r.status_code == 200 and r.json()["cached_count"] == 3

    assert (await client.delete(f"/bots/{bot['id']}/source")).status_code == 204
    assert (await client.get(f"/bots/{bot['id']}/source")).json()["kind"] == "none"
    after = (await client.get(f"/bots/{bot['id']}")).json()["subscribers"]
    assert after["active"] == 0 and after["connected"] is False


async def test_campaign_from_external_database(client, bot_db, telegram_fake, delivery_engine):
    a = await connect_bot(client, 0)
    b = await connect_bot(client, 1)
    await attach_users(client, b["id"], [222, 223])
    await save_source(client, a["id"], bot_db)
    telegram_fake.blocked.add(5004)
    telegram_fake.missing.add(5006)

    c = (
        await client.post(
            "/campaigns",
            json={"name": "x", "bot_ids": [a["id"], b["id"]], "message": {"text": "hi"}},
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)

    sent = {(m["token"][:6], m["chat_id"]) for m in telegram_fake.sent}
    assert sent == {("111111", 5001), ("111111", 5002), ("222222", 222), ("222222", 223)}
    detail = (await client.get(f"/campaigns/{c['id']}")).json()
    assert detail["status"] == "completed"
    assert (
        detail["stats"]["sent"] == 4
        and detail["stats"]["blocked"] == 1
        and detail["stats"]["failed"] == 1
    )

    async with SessionLocal() as s:
        rows = (await s.execute(select(BotSuppression.chat_id, BotSuppression.reason))).all()
    assert sorted(rows) == [(5004, "blocked"), (5006, "unreachable")]

    # the next campaign skips suppressed chats
    telegram_fake.sent.clear()
    c2 = (await client.post(f"/campaigns/{c['id']}/duplicate")).json()
    await client.post(f"/campaigns/{c2['id']}/launch", json={})
    await drain(delivery_engine)
    assert {m["chat_id"] for m in telegram_fake.sent if m["token"].startswith("111111")} == {
        5001,
        5002,
    }


async def test_source_error(client, bot_db, telegram_fake, delivery_engine):
    a = await connect_bot(client, 0)
    b = await connect_bot(client, 1)
    await attach_users(client, b["id"], [222])
    await save_source(client, a["id"], bot_db)

    con = sqlite3.connect(bot_db)
    con.execute("DROP VIEW pro_users")
    con.execute("ALTER TABLE users RENAME COLUMN tg_id TO telegram")
    con.commit()
    con.close()
    id_cache._data.clear()

    counts = (await client.get(f"/bots/{a['id']}")).json()["subscribers"]
    assert counts["source_error"] == "Column tg_id doesn't exist in users"
    assert counts["active"] == 4  # last cached count
    src = (await client.get(f"/bots/{a['id']}/source")).json()
    assert src["status"] == "error" and "tg_id" in src["last_error"]

    # a campaign still reaches the healthy bot and records why the other sent nothing
    c = (
        await client.post(
            "/campaigns",
            json={"name": "x", "bot_ids": [a["id"], b["id"]], "message": {"text": "hi"}},
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    detail = (await client.get(f"/campaigns/{c['id']}")).json()
    assert detail["status"] == "completed" and detail["stats"]["sent"] == 1
    errs = {x["username"]: x["error"] for x in detail["bots"]}
    assert "tg_id" in errs["alpha_bot"] and errs["beta_bot"] is None
