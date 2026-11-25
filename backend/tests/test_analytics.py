import sqlite3
from datetime import UTC, datetime, timedelta

from app.core.db import SessionLocal
from app.modules.analytics.service import _cache, period
from app.modules.sources.models import BotSuppression
from tests.conftest import _tmp, connect_bot

MAP = {"chat_id": "tg_id", "joined_at": "joined", "language_code": "lang"}


def bot_db(name, users):
    """users: (chat_id, days_ago, lang)"""
    path = _tmp / f"analytics-{name}-{datetime.now().timestamp()}.sqlite"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE users (tg_id INTEGER, joined TEXT, lang TEXT)")
    now = datetime.now(UTC)
    con.executemany(
        "INSERT INTO users VALUES (?, ?, ?)",
        [(c, (now - timedelta(days=d)).isoformat(sep=" "), lang) for c, d, lang in users],
    )
    con.commit()
    con.close()
    return f"sqlite:///{path}"


async def attach(client, bot_id, url, mapping=MAP):
    r = await client.put(
        f"/bots/{bot_id}/source",
        json={"database_url": url, "table": "users", "column_map": mapping},
    )
    assert r.status_code == 200, r.text


async def test_audience_growth_overlap_languages_blocked(client):
    _cache.clear()
    a = await connect_bot(client, 0)
    b = await connect_bot(client, 1)
    await attach(
        client,
        a["id"],
        bot_db(
            "a",
            [
                (1, 1, "en"),
                (2, 3, "ne"),
                (3, 10, "ne"),
                (4, 45, "en-US"),
                (5, 200, None),
            ],
        ),
    )
    await attach(client, b["id"], bot_db("b", [(3, 2, "ne"), (4, 5, "en"), (9, 40, "hi")]))
    async with SessionLocal() as s:
        s.add(BotSuppression(bot_id=a["id"], chat_id=5, reason="blocked"))
        await s.commit()

    r = (await client.get("/analytics/audience", params={"range": "30d"})).json()
    assert r["period"]["unit"] == "day" and len(r["period"]["buckets"]) == 30
    k = r["kpis"]
    # reachable: a = {1,2,3,4} (5 blocked), b = {3,4,9}
    assert k["people"] == 5 and k["subscriptions"] == 7 and k["multi_bot_people"] == 2
    # joined in last 30 days: a {1,2,3} + b {3,4} -> 5 sign-ups (subscriptions, per bot)
    assert k["new_people"] == 5
    assert k["new_people_previous"] == 2  # a:4 (45d), b:9 (40d)
    assert k["blocked"] == 1

    by_bot = {}
    for pt in r["growth"]["points"]:
        by_bot[pt["bot_id"]] = by_bot.get(pt["bot_id"], 0) + pt["count"]
    assert by_bot == {a["id"]: 3, b["id"]: 2}
    assert r["growth"]["before_start"] == {str(a["id"]): 2, str(b["id"]): 1}

    ov = r["overlap"]
    assert ov["by_bot_count"] == {"1": 3, "2": 2}
    assert ov["pairs"] == [{"a": a["id"], "b": b["id"], "people": 2}]

    langs = {x["code"]: x["people"] for x in r["languages"]["items"]}
    assert langs == {"ne": 3, "en": 3, "hi": 1} and r["languages"]["unknown"] == 1

    # one bot only, longer range
    one = (await client.get("/analytics/audience", params={"range": "12m", "bot": a["id"]})).json()
    assert one["bots"] == [a["id"]] and one["period"]["unit"] == "month"
    assert one["kpis"]["new_people"] == 5 and one["overlap"]["pairs"] == []


async def test_missing_mappings_and_all_time(client):
    _cache.clear()
    a = await connect_bot(client, 0)
    await attach(
        client, a["id"], bot_db("plain", [(1, 400, "en"), (2, 3, "en")]), {"chat_id": "tg_id"}
    )
    r = (await client.get("/analytics/audience", params={"range": "all"})).json()
    assert r["kpis"]["new_people"] is None
    assert r["growth"]["missing_joined_at"] == [a["id"]]
    assert r["languages"]["missing_language"] == [a["id"]]
    assert r["kpis"]["people"] == 2

    await attach(client, a["id"], bot_db("dated", [(1, 400, "en"), (2, 3, "en")]))
    _cache.clear()
    r = (await client.get("/analytics/audience", params={"range": "all"})).json()
    assert r["period"]["unit"] == "month" and len(r["period"]["buckets"]) >= 13
    assert r["kpis"]["new_people"] == 2


def test_period_buckets_align():
    from datetime import date

    p = period("90d", date(2026, 11, 25))
    assert p.unit == "week" and p.buckets[0].weekday() == 0 and p.buckets[-1] <= date(2026, 11, 25)
    m = period("12m", date(2026, 11, 25))
    assert m.buckets[0] == date(2025, 12, 1) and m.buckets[-1] == date(2026, 11, 1)
