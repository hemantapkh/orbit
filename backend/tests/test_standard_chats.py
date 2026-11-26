"""Bots on the shared chats schema: suggestions, reachability, Orbit's own failures,
search and analytics."""

import sqlite3
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.core.db import SessionLocal
from app.modules.analytics.service import _cache
from app.modules.sources.models import BotSuppression
from tests.conftest import _tmp, connect_bot, drain

NOW = datetime.now(UTC)
DAY = timedelta(days=1)

HOUR = timedelta(hours=1)

# id, type, first_name, title, username, status, unreachable_reason, premium, members,
# last active, joined, status changed, unreachable since
CHATS = [
    (
        1,
        "private",
        "Ana",
        None,
        "ana",
        "member",
        None,
        1,
        None,
        NOW - 9 * DAY,
        NOW - 30 * HOUR,
        None,
        None,
    ),
    (
        2,
        "private",
        "Bob",
        None,
        "bob",
        "kicked",
        None,
        0,
        None,
        NOW - 30 * DAY,
        NOW - 60 * DAY,
        NOW - 2 * HOUR,
        None,
    ),
    (
        3,
        "private",
        None,
        None,
        None,
        "member",
        "deactivated",
        0,
        None,
        None,
        NOW - 60 * DAY,
        None,
        NOW - 30 * DAY,
    ),
    (
        4,
        "private",
        "Cy",
        None,
        None,
        "member",
        "chat_not_found",
        0,
        None,
        None,
        NOW - 60 * DAY,
        None,
        None,
    ),
    (5, "private", "Dee", None, "dee", "member", None, 0, None, NOW, NOW - 2 * HOUR, None, None),
    (
        -100,
        "supergroup",
        None,
        "Movie club",
        "movies",
        "administrator",
        None,
        None,
        50,
        NOW,
        NOW - 2 * HOUR,
        None,
        None,
    ),
    (
        -200,
        "group",
        None,
        "Old group",
        None,
        "left",
        None,
        None,
        9,
        None,
        NOW - 60 * DAY,
        NOW - 3 * DAY,
        None,
    ),
]


def stamp(t: datetime | None) -> str | None:
    """How SQLAlchemy stores a datetime in SQLite (UTC, no offset)."""
    return t.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f") if t else None


MAPPING = {
    "chat_id": "id",
    "username": "username",
    "first_name": "first_name",
    "joined_at": "created_at",
    "is_active": "is_reachable",
    "chat_type": "type",
    "status": "status",
    "unreachable_reason": "unreachable_reason",
    "last_active_at": "last_active_at",
    "is_premium": "is_premium",
    "title": "title",
    "member_count": "member_count",
    "status_changed_at": "status_changed_at",
    "unreachable_at": "unreachable_at",
}


def make_chats_db(name: str) -> str:
    path = _tmp / f"{name}.sqlite"
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE chats (id BIGINT PRIMARY KEY, type TEXT, first_name TEXT, title TEXT, "
        "username TEXT, status TEXT, unreachable_reason TEXT, is_premium BOOLEAN, "
        "member_count INTEGER, last_active_at TIMESTAMP, created_at TIMESTAMP, "
        "status_changed_at TIMESTAMP, unreachable_at TIMESTAMP, "
        "is_reachable BOOLEAN GENERATED ALWAYS AS (status IN "
        "('creator', 'administrator', 'member', 'restricted') AND unreachable_reason IS NULL))"
    )
    con.executemany(
        "INSERT INTO chats (id, type, first_name, title, username, status, unreachable_reason, "
        "is_premium, member_count, last_active_at, created_at, status_changed_at, unreachable_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(*c[:9], *(stamp(t) for t in c[9:])) for c in CHATS],
    )
    con.commit()
    con.close()
    return f"sqlite:///{path}"


async def connect_chats(client, bot_id: int, name: str) -> None:
    r = await client.put(
        f"/bots/{bot_id}/source",
        json={"database_url": make_chats_db(name), "table": "chats", "column_map": MAPPING},
    )
    assert r.status_code == 200, r.text


async def test_standard_columns_are_suggested(client):
    r = await client.post("/sources/introspect", json={"database_url": make_chats_db("suggest")})
    chats = next(t for t in r.json()["tables"] if t["name"] == "chats")
    assert chats["suggested"] == MAPPING


async def test_reachability_from_the_bots_records(client, telegram_fake, delivery_engine):
    bot = await connect_bot(client, 0)
    await connect_chats(client, bot["id"], "reach")
    counts = (await client.get(f"/bots/{bot['id']}")).json()["subscribers"]
    assert {k: counts[k] for k in ("active", "blocked", "left", "deleted", "unreachable")} == {
        "active": 3,  # 1, 5 and the supergroup
        "blocked": 1,
        "left": 1,
        "deleted": 1,
        "unreachable": 1,
    }

    # Searching finds people who can't be reached, and says so.
    hits = (await client.get(f"/bots/{bot['id']}/people", params={"q": "bob"})).json()
    assert [(h["chat_id"], h["reachable"]) for h in hits] == [(2, False)]
    groups = (await client.get(f"/bots/{bot['id']}/people", params={"q": "movie"})).json()
    assert [(h["chat_id"], h["first_name"]) for h in groups] == [(-100, "Movie club")]

    # A broadcast only goes to chats that can receive it.
    c = (
        await client.post(
            "/campaigns", json={"name": "x", "bot_ids": [bot["id"]], "message": {"text": "hi"}}
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    assert sorted(m["chat_id"] for m in telegram_fake.sent) == [-100, 1, 5]


async def test_failed_send_is_forgotten_once_the_person_returns(client):
    bot = await connect_bot(client, 0)
    async with SessionLocal() as s:
        s.add_all(
            [  # Orbit saw both fail two days ago; only Dee used the bot since.
                BotSuppression(
                    bot_id=bot["id"], chat_id=5, reason="blocked", created_at=NOW - 2 * DAY
                ),
                BotSuppression(
                    bot_id=bot["id"], chat_id=1, reason="blocked", created_at=NOW - 2 * DAY
                ),
            ]
        )
        await s.commit()
    await connect_chats(client, bot["id"], "returned")

    counts = (await client.get(f"/bots/{bot['id']}")).json()["subscribers"]
    assert counts["active"] == 2  # Dee and the supergroup; Ana is still blocked
    assert counts["blocked"] == 2  # Ana (Orbit's record) and Bob (the bot's)
    async with SessionLocal() as s:
        left = (await s.scalars(select(BotSuppression.chat_id))).all()
    assert left == [1]


async def test_audience_analytics_profile(client):
    _cache.clear()
    bot = await connect_bot(client, 0)
    await connect_chats(client, bot["id"], "analytics")
    r = (await client.get("/analytics/audience", params={"range": "30d"})).json()
    key = str(bot["id"])
    assert r["reach"][key]["deleted"] == 1
    assert r["chat_types"]["per_bot"][key] == {"private": 2, "supergroup": 1}
    assert r["chat_types"]["group_members"][key] == 50
    assert (r["premium"]["premium"][key], r["premium"]["people"][key]) == (1, 2)
    assert r["chat_types"]["missing"] == [] and r["premium"]["missing"] == []


async def test_overview_last_24_hours(client):
    bot = await connect_bot(client, 0)
    await connect_chats(client, bot["id"], "overview")
    line = next(b for b in (await client.get("/overview")).json()["bots"] if b["id"] == bot["id"])
    assert (line["joined_24h"], line["joined_prev_24h"]) == (2, 1)  # Dee, the group; Ana
    assert (line["active_24h"], line["active_7d"]) == (2, 2)  # Ana was 9 days ago
    assert line["lost_24h"] == {"blocked": 1}  # Bob; the group left 3 days ago
    assert line["maps_status"] is True
