"""Organizations: isolation between them, roles inside them, invites, account security."""

import httpx
import pytest

from app.main import app as fastapi_app
from app.modules.auth.router import _failures
from tests.conftest import attach_users, connect_bot, drain


@pytest.fixture
async def new_client(tg_client):
    clients = []

    async def make() -> httpx.AsyncClient:
        fastapi_app.state.telegram = tg_client
        c = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=fastapi_app), base_url="http://sb.test/api"
        )
        clients.append(c)
        return c

    yield make
    for c in clients:
        await c.aclose()


async def join_via_invite(owner, new_client, email: str, role: str) -> httpx.AsyncClient:
    inv = await owner.post("/orgs/current/invites", json={"email": email, "role": role})
    assert inv.status_code == 201, inv.text
    c = await new_client()
    r = await c.post(
        f"/invites/{inv.json()['token']}/accept", json={"name": "X", "password": "a-long-password"}
    )
    assert r.status_code == 200, r.text
    return c


async def test_other_organizations_see_and_touch_nothing(client, new_client, delivery_engine):
    a = await connect_bot(client)
    await attach_users(client, a["id"], [1, 2])
    c = (
        await client.post(
            "/campaigns", json={"name": "A secret", "bot_ids": [a["id"]], "message": {"text": "hi"}}
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    media = (
        await client.post("/media", files={"file": ("p.png", b"\x89PNG" + b"0" * 32, "image/png")})
    ).json()
    group = (await client.post("/test-groups", json={"name": "QA"})).json()

    # Someone else, in their own organization
    other = await join_via_invite(client, new_client, "eve@example.com", "viewer")
    await other.delete(
        f"/orgs/current/members/{(await other.get('/auth/me')).json()['id']}"
    )  # leaves org A
    created = await other.post("/orgs", json={"name": "Eve Corp"})
    assert created.status_code == 201
    eve_org = created.json()["id"]

    for path in [
        f"/bots/{a['id']}",
        f"/bots/{a['id']}/source",
        f"/bots/{a['id']}/avatar",
        f"/campaigns/{c['id']}",
        f"/campaigns/{c['id']}/progress",
        f"/campaigns/{c['id']}/deliveries",
        f"/media/{media['id']}",
        f"/media/{media['id']}/file",
        f"/analytics/columns?bot={a['id']}",
        f"/analytics/breakdown?bot={a['id']}&column=tg_id",
    ]:
        assert (await other.get(path)).status_code == 404, path
    assert (await other.get("/bots")).json() == []
    assert (await other.get("/campaigns")).json()["total"] == 0
    assert (await other.get("/test-groups")).json() == []
    assert (await other.get("/overview")).json()["total_bots"] == 0
    assert (await other.get("/analytics/audience")).json()["bots"] == []
    assert (await other.get("/activity")).json() == [] or all(
        e["entity_type"] == "org" for e in (await other.get("/activity")).json()
    )
    # writes and side doors
    assert (await other.post(f"/campaigns/{c['id']}/pause")).status_code in (403, 404)
    assert (await other.put(f"/test-groups/{group['id']}", json={"name": "x"})).status_code in (
        403,
        404,
    )
    assert (
        await other.post(
            "/sources/preview",
            json={"bot_id": a["id"], "table": "users", "column_map": {"chat_id": "tg_id"}},
        )
    ).status_code in (403, 404)
    eve_campaign = await other.post("/campaigns", json={"name": "x", "bot_ids": [a["id"]]})
    assert eve_campaign.status_code in (403, 422)

    # forging the organization header doesn't help: not a member -> falls back to Eve Corp
    forged = await other.get("/bots", headers={"X-Org-Id": "1"})
    assert forged.json() == []
    assert (await other.get("/orgs/current", headers={"X-Org-Id": "1"})).json()["id"] == eve_org


async def test_roles(client, new_client):
    bot = await connect_bot(client)
    viewer = await join_via_invite(client, new_client, "v@example.com", "viewer")
    sender = await join_via_invite(client, new_client, "s@example.com", "sender")
    admin = await join_via_invite(client, new_client, "a@example.com", "admin")

    # viewers read, never write
    assert (await viewer.get("/bots")).status_code == 200
    assert (await viewer.post("/campaigns", json={"name": "x"})).status_code == 403
    # senders broadcast, but don't manage bots or people
    assert (
        await sender.post("/campaigns", json={"name": "x", "bot_ids": [bot["id"]]})
    ).status_code == 201
    assert (await sender.patch(f"/bots/{bot['id']}", json={"is_active": False})).status_code == 403
    assert (
        await sender.post("/orgs/current/invites", json={"email": "z@example.com"})
    ).status_code == 403
    # admins manage bots and members, but not owners
    assert (await admin.patch(f"/bots/{bot['id']}", json={"is_active": True})).status_code == 200
    assert (
        await admin.post("/orgs/current/invites", json={"email": "o@example.com", "role": "owner"})
    ).status_code == 403
    members = {m["email"]: m for m in (await admin.get("/orgs/current/members")).json()}
    owner_id = members["ops@example.com"]["user_id"]
    assert (
        await admin.patch(f"/orgs/current/members/{owner_id}", json={"role": "viewer"})
    ).status_code == 403
    assert (await admin.delete(f"/orgs/current/members/{owner_id}")).status_code == 403
    s_id = members["s@example.com"]["user_id"]
    assert (
        await admin.patch(f"/orgs/current/members/{s_id}", json={"role": "viewer"})
    ).status_code == 200
    # the last owner can't step down
    assert (
        await client.patch(f"/orgs/current/members/{owner_id}", json={"role": "admin"})
    ).status_code == 409
    assert (await client.patch("/orgs/current", json={"name": "Renamed"})).json()[
        "name"
    ] == "Renamed"
    assert (await admin.patch("/orgs/current", json={"name": "No"})).status_code == 403


async def test_invites(client, new_client):
    inv = (
        await client.post(
            "/orgs/current/invites", json={"email": "New@Example.com", "role": "sender"}
        )
    ).json()
    token = inv["token"]
    assert inv["email"] == "new@example.com" and len(token) >= 40
    assert [i["email"] for i in (await client.get("/orgs/current/invites")).json()] == [
        "new@example.com"
    ]
    assert (
        "token" not in (await client.get("/orgs/current/invites")).json()[0]
        or (await client.get("/orgs/current/invites")).json()[0]["token"] is None
    )

    guest = await new_client()
    preview = (await guest.get(f"/invites/{token}")).json()
    assert (
        preview["org_name"] == "My organization"
        and preview["role"] == "sender"
        and not preview["has_account"]
    )
    assert (
        await guest.post(f"/invites/{token}/accept", json={})
    ).status_code == 422  # needs a password
    assert (
        await guest.post(f"/invites/{token}/accept", json={"password": "a-long-password"})
    ).status_code == 200
    me = (await guest.get("/auth/me")).json()  # signed in by accepting
    assert me["email"] == "new@example.com" and me["orgs"][0]["role"] == "sender"
    assert (await guest.get(f"/invites/{token}")).status_code == 404  # one-time

    # an existing account must sign in as that email to accept
    again = (await client.post("/orgs", json={"name": "Second"})).json()
    inv2 = (
        await client.post(
            "/orgs/current/invites",
            headers={"X-Org-Id": str(again["id"])},
            json={"email": "new@example.com"},
        )
    ).json()
    stranger = await new_client()
    assert (
        await stranger.post(f"/invites/{inv2['token']}/accept", json={"password": "whatever-long"})
    ).status_code == 401
    assert (await guest.post(f"/invites/{inv2['token']}/accept", json={})).status_code == 200
    assert {o["name"] for o in (await guest.get("/auth/me")).json()["orgs"]} == {
        "My organization",
        "Second",
    }

    revoked = (
        await client.post("/orgs/current/invites", json={"email": "gone@example.com"})
    ).json()
    await client.delete(f"/orgs/current/invites/{revoked['id']}")
    assert (await guest.get(f"/invites/{revoked['token']}")).status_code == 404


async def test_switching_organizations(client):
    a = await connect_bot(client, 0)
    second = (await client.post("/orgs", json={"name": "Side project"})).json()
    h = {"X-Org-Id": str(second["id"])}
    assert (await client.get("/bots", headers=h)).json() == []
    b = (
        await client.post(
            "/bots", headers=h, json={"token": "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
        )
    ).json()
    assert [x["id"] for x in (await client.get("/bots", headers=h)).json()] == [b["id"]]
    assert [x["id"] for x in (await client.get("/bots")).json()] == [a["id"]]  # default: first org


async def test_password_change_and_login_throttle(client, new_client):
    bad = await client.post(
        "/auth/password", json={"current_password": "nope", "new_password": "another-long-one"}
    )
    assert bad.status_code == 422
    ok = await client.post(
        "/auth/password",
        json={"current_password": "correct-horse-battery", "new_password": "another-long-one"},
    )
    assert ok.status_code == 204

    _failures.clear()
    c = await new_client()
    for _ in range(5):
        assert (
            await c.post("/auth/login", json={"email": "ops@example.com", "password": "wrong"})
        ).status_code == 401
    blocked = await c.post(
        "/auth/login", json={"email": "ops@example.com", "password": "another-long-one"}
    )
    assert blocked.status_code == 429
    _failures.clear()
    assert (
        await c.post(
            "/auth/login", json={"email": "ops@example.com", "password": "another-long-one"}
        )
    ).status_code == 200
