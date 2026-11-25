from tests.conftest import connect_bot


async def test_test_groups_resolve_and_send(client, telegram_fake):
    a = await connect_bot(client, 0)
    b = await connect_bot(client, 1)

    # resolving checks reachability and returns the real chat name and type
    me = (await client.post("/test-groups/resolve", json={"bot_id": a["id"], "chat_id": 42})).json()
    assert me == {"bot_id": a["id"], "chat_id": 42, "label": "Ana (@ana)", "kind": "private"}
    chan = (
        await client.post(
            "/test-groups/resolve", json={"bot_id": b["id"], "chat_id": -1001234567890}
        )
    ).json()
    assert chan["kind"] == "channel" and chan["label"] == "Release notes"
    telegram_fake.missing.add(77)
    r = await client.post("/test-groups/resolve", json={"bot_id": a["id"], "chat_id": 77})
    assert r.status_code == 422 and "press Start" in r.json()["detail"]

    # first group becomes the default automatically
    blocked = {"bot_id": a["id"], "chat_id": 43, "label": "Old phone"}
    g = (
        await client.post("/test-groups", json={"name": "QA", "members": [me, chan, blocked]})
    ).json()
    assert g["is_default"] is True and len(g["members"]) == 3
    g2 = (
        await client.post(
            "/test-groups", json={"name": "Me only", "members": [me], "is_default": True}
        )
    ).json()
    groups = {x["name"]: x["is_default"] for x in (await client.get("/test-groups")).json()}
    assert groups == {"QA": False, "Me only": True}

    # send an unsaved message; failures are reported per member, not as an error
    c = (await client.post("/campaigns", json={"name": "x", "bot_ids": [a["id"]]})).json()
    telegram_fake.blocked.add(43)
    results = (
        await client.post(
            f"/test-groups/{g['id']}/send",
            json={"message": {"text": "**Preview**"}, "campaign_id": c["id"]},
        )
    ).json()
    assert [(x["chat_id"], x["delivered"]) for x in results] == [
        (42, True),
        (-1001234567890, True),
        (43, False),
    ]
    assert "can't reach" in results[2]["error"]
    sent_via = {(m["token"][:6], m["chat_id"]) for m in telegram_fake.sent}
    assert sent_via == {("111111", 42), ("222222", -1001234567890)}

    log = (
        await client.get("/activity", params={"entity_type": "campaign", "entity_id": c["id"]})
    ).json()
    assert log[0]["action"] == "campaign.test_sent" and log[0]["details"]["delivered"] == 2

    # validation
    empty = (await client.post("/test-groups", json={"name": "Empty"})).json()
    r = await client.post(f"/test-groups/{empty['id']}/send", json={"message": {"text": "hi"}})
    assert r.status_code == 422 and "no members" in r.json()["detail"]
    r = await client.post(f"/test-groups/{g2['id']}/send", json={"message": {"text": " "}})
    assert r.status_code == 422
    bad = await client.post(
        "/test-groups", json={"name": "x", "members": [{"bot_id": 999, "chat_id": 1}]}
    )
    assert bad.status_code == 422
