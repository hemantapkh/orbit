"""Database sources whose user data is spread over linked tables (like the real bots)."""

import sqlite3

import pytest

from tests.conftest import connect_bot


@pytest.fixture
def linked_db(tmp_path):
    path = tmp_path / "linked.sqlite"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY, telegram_id INTEGER NOT NULL, username TEXT);
        CREATE TABLE settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id), language TEXT, muted INTEGER
        );
        CREATE TABLE accounts (
            id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), is_premium INTEGER,
            password TEXT
        );
        INSERT INTO users VALUES
            (1, 9001, 'ana'), (2, 9002, 'bo'), (3, 9003, 'cy'), (4, 9004, 'di');
        INSERT INTO settings VALUES (1, 'ne', 0), (2, 'en', 1), (3, 'ne', 0);
        -- ana has two premium accounts (must still count once), bo one free, di none
        INSERT INTO accounts VALUES (1, 1, 1, 's'), (2, 1, 1, 's'), (3, 2, 0, 's'), (4, 3, 1, 's');
        """
    )
    con.commit()
    con.close()
    return f"sqlite:///{path}"


SETTINGS = {"table": "settings", "base_column": "id", "related_column": "user_id"}
ACCOUNTS = {"table": "accounts", "base_column": "id", "related_column": "user_id"}


async def test_introspect_finds_links_and_suggests_across_them(client, linked_db):
    data = (await client.post("/sources/introspect", json={"database_url": linked_db})).json()
    users = next(t for t in data["tables"] if t["name"] == "users")
    rels = {r["table"]: r for r in users["relations"]}
    assert rels["settings"] == {
        "table": "settings",
        "schema": None,
        "base_column": "id",
        "related_column": "user_id",
        "cardinality": "one",
    }
    assert rels["accounts"]["cardinality"] == "many"
    assert users["suggested"]["chat_id"] == "telegram_id"
    assert users["suggested"]["language_code"] == "settings.language"


async def test_preview_maps_and_filters_through_linked_tables(client, linked_db):
    body = {
        "database_url": linked_db,
        "table": "users",
        "column_map": {
            "chat_id": "telegram_id",
            "username": "username",
            "language_code": "settings.language",
        },
        "joins": [SETTINGS, ACCOUNTS],
    }
    r = (await client.post("/sources/preview", json=body)).json()
    assert r["total"] == 4
    assert [(x["chat_id"], x["language_code"]) for x in r["rows"]] == [
        (9001, "ne"),
        (9002, "en"),
        (9003, "ne"),
        (9004, None),  # di has no settings row: still included
    ]

    # one-to-one filter
    nepali = {**body, "filters": [{"column": "settings.language", "op": "eq", "value": "ne"}]}
    assert (await client.post("/sources/preview", json=nepali)).json()["total"] == 2

    # one-to-many filter = "has any premium account"; ana's two accounts don't double-count
    premium = {**body, "filters": [{"column": "accounts.is_premium", "op": "is_true"}]}
    r = (await client.post("/sources/preview", json=premium)).json()
    assert r["total"] == 2 and [x["chat_id"] for x in r["rows"]] == [9001, 9003]

    # active flag on a linked table: muted users excluded via settings.muted is false
    both = {
        **nepali,
        "filters": nepali["filters"] + [{"column": "settings.muted", "op": "is_false"}],
    }
    assert (await client.post("/sources/preview", json=both)).json()["total"] == 2


async def test_linked_references_are_validated(client, linked_db):
    base = {"database_url": linked_db, "table": "users", "joins": [SETTINGS]}
    r = await client.post(
        "/sources/preview",
        json={
            **base,
            "column_map": {"chat_id": "telegram_id", "language_code": "accounts.password"},
        },
    )
    assert r.status_code == 422 and r.json()["detail"] == "Table accounts isn't linked to users"

    r = await client.post(
        "/sources/preview",
        json={**base, "column_map": {"chat_id": "telegram_id", "language_code": "settings.nope"}},
    )
    assert r.json()["detail"] == "Column nope doesn't exist in settings"

    r = await client.post(
        "/sources/preview", json={**base, "column_map": {"chat_id": "settings.user_id"}}
    )
    assert "main table" in r.json()["detail"]

    bad_join = {
        **base,
        "joins": [{**SETTINGS, "related_column": "ghost"}],
        "column_map": {"chat_id": "telegram_id"},
    }
    assert (await client.post("/sources/preview", json=bad_join)).json()["detail"] == (
        "Column ghost doesn't exist in settings"
    )


async def test_saved_source_with_links_counts_and_searches(client, linked_db):
    bot = await connect_bot(client)
    body = {
        "database_url": linked_db,
        "table": "users",
        "column_map": {
            "chat_id": "telegram_id",
            "username": "username",
            "language_code": "settings.language",
        },
        "filters": [{"column": "accounts.is_premium", "op": "is_true"}],
        "joins": [SETTINGS, ACCOUNTS],
    }
    saved = (await client.put(f"/bots/{bot['id']}/source", json=body)).json()
    assert saved["cached_count"] == 2 and len(saved["joins"]) == 2
    assert (await client.get(f"/bots/{bot['id']}")).json()["subscribers"]["active"] == 2
    hits = (await client.get(f"/bots/{bot['id']}/people", params={"q": "ana"})).json()
    assert [h["chat_id"] for h in hits] == [9001]
