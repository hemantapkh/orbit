import pytest
from sqlalchemy import select

from app.core.db import SessionLocal
from app.integrations.telegram.messages import MessageContent, personalize
from app.modules.campaigns.models import Delivery
from tests.conftest import attach_users, connect_bot, drain


@pytest.mark.parametrize(
    ("text", "person", "mode", "out"),
    [
        ("Hi {first_name|there}!", {"first_name": "Ana"}, "Markdown", "Hi Ana!"),
        ("Hi {first_name|there}!", {}, "Markdown", "Hi there!"),
        ("Hi {first_name}!", None, "Markdown", "Hi !"),
        (
            "{full_name} @{username}",
            {"first_name": "Ana", "last_name": "Rai", "username": "ana"},
            None,
            "Ana Rai @ana",
        ),
        ("Hi {first_name}", {"first_name": "*_Bo_*"}, "Markdown", "Hi \\*\\_Bo\\_\\*"),
        ("<b>{first_name}</b>", {"first_name": "<i>x</i>"}, "HTML", "<b>&lt;i&gt;x&lt;/i&gt;</b>"),
        ("Hi {first_name}", {"first_name": "a.b!"}, "MarkdownV2", "Hi a\\.b\\!"),
        ("Hi {first_name|**friend**}", {}, "Markdown", "Hi **friend**"),  # fallback is the author's
        ("Braces {like_this} stay", {"first_name": "A"}, "Markdown", "Braces {like_this} stay"),
    ],
)
def test_personalize(text, person, mode, out):
    assert personalize(MessageContent(text=text, parse_mode=mode), person).text == out


async def test_personalized_broadcast(client, telegram_fake, delivery_engine):
    a = await connect_bot(client)
    await attach_users(
        client, a["id"], [(101, "ana", "Ana"), (102, "bo", None), (103, None, "C*y")]
    )
    c = (
        await client.post(
            "/campaigns",
            json={
                "name": "x",
                "bot_ids": [a["id"]],
                "message": {"text": "Hi {first_name|there}!", "parse_mode": None},
            },
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    sent = {m["chat_id"]: m["text"] for m in telegram_fake.sent}
    assert sent == {101: "Hi Ana!", 102: "Hi there!", 103: "Hi C*y!"}


async def test_markdown_names_are_escaped_end_to_end(client, telegram_fake, delivery_engine):
    a = await connect_bot(client)
    await attach_users(client, a["id"], [(201, "x", "*Bold*")])
    c = (
        await client.post(
            "/campaigns",
            json={"name": "x", "bot_ids": [a["id"]], "message": {"text": "Hi **{first_name}**"}},
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    (m,) = telegram_fake.sent
    assert m["parse_mode"] == "MarkdownV2" and m["text"] == "Hi *\\*Bold\\**"


async def test_plain_broadcasts_store_no_values(client, delivery_engine):
    a = await connect_bot(client)
    await attach_users(client, a["id"], [(301, "ana", "Ana")])
    c = (
        await client.post(
            "/campaigns", json={"name": "x", "bot_ids": [a["id"]], "message": {"text": "Hello"}}
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    async with SessionLocal() as s:
        assert (await s.scalars(select(Delivery.vars))).all() == [None]


async def test_selected_people_and_test_sends_are_personalized(
    client, telegram_fake, delivery_engine
):
    a = await connect_bot(client)
    await attach_users(client, a["id"], [(401, "ana", "Ana"), (402, "bo", "Bo")])
    c = (
        await client.post(
            "/campaigns",
            json={
                "name": "x",
                "bot_ids": [a["id"]],
                "message": {"text": "Hey {first_name|you}", "parse_mode": None},
                "audience": {
                    "mode": "selected",
                    "recipients": [{"bot_id": a["id"], "chat_id": 402}],
                },
            },
        )
    ).json()
    await client.post(f"/campaigns/{c['id']}/launch", json={})
    await drain(delivery_engine)
    assert [(m["chat_id"], m["text"]) for m in telegram_fake.sent] == [(402, "Hey Bo")]

    telegram_fake.sent.clear()
    msg = {"text": "Test for {first_name|you}", "parse_mode": None}
    await client.post(
        "/campaigns/test-send", json={"bot_id": a["id"], "chat_id": 401, "message": msg}
    )
    await client.post(
        "/campaigns/test-send", json={"bot_id": a["id"], "chat_id": 999, "message": msg}
    )
    assert [m["text"] for m in telegram_fake.sent] == ["Test for Ana", "Test for you"]
