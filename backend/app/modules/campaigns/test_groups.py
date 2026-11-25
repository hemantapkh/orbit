"""Test groups: saved recipients that receive a draft before it goes to everyone."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from app.core.deps import SessionDep, TelegramDep
from app.integrations.telegram.bots import (
    ChatUnreachable,
    TelegramUnavailable,
    look_up_chat,
    unseal_token,
)
from app.integrations.telegram.delivery import SendStatus
from app.integrations.telegram.messages import MessageContent
from app.modules.activity.service import record
from app.modules.auth.deps import CurrentAdmin
from app.modules.bots.models import Bot
from app.modules.campaigns.models import Campaign, TestGroup
from app.modules.campaigns.service import send_once

router = APIRouter(prefix="/test-groups", tags=["test groups"])

_422 = status.HTTP_422_UNPROCESSABLE_CONTENT


class Member(BaseModel):
    bot_id: int
    chat_id: int
    label: str = Field(default="", max_length=200)
    kind: str = Field(default="private", max_length=16)  # private | group | supergroup | channel


class TestGroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    members: list[Member] = Field(default_factory=list, max_length=50)
    is_default: bool = False


class TestGroupOut(TestGroupIn):
    id: int
    updated_at: datetime


class ResolveIn(BaseModel):
    bot_id: int
    chat_id: int


class SendIn(BaseModel):
    message: MessageContent
    campaign_id: int | None = None  # log the test on this broadcast's activity


class SendResultOut(BaseModel):
    bot_id: int
    chat_id: int
    label: str
    delivered: bool
    error: str | None = None


def _out(g: TestGroup) -> TestGroupOut:
    return TestGroupOut(
        id=g.id,
        name=g.name,
        members=g.members or [],
        is_default=g.is_default,
        updated_at=g.updated_at,
    )


async def _get(session, group_id: int) -> TestGroup:
    g = await session.get(TestGroup, group_id)
    if g is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Test group not found")
    return g


async def _apply(session, g: TestGroup, body: TestGroupIn) -> None:
    bot_ids = {m.bot_id for m in body.members}
    if bot_ids:
        known = set((await session.scalars(select(Bot.id).where(Bot.id.in_(bot_ids)))).all())
        if bot_ids - known:
            raise HTTPException(_422, "Some members use a bot that no longer exists")
    unique = {(m.bot_id, m.chat_id): m for m in body.members}
    g.name = body.name.strip()
    g.members = [m.model_dump() for m in unique.values()]
    g.is_default = body.is_default
    if body.is_default:
        await session.execute(
            update(TestGroup).where(TestGroup.id != g.id).values(is_default=False)
        )


@router.get("", response_model=list[TestGroupOut])
async def list_groups(session: SessionDep, _: CurrentAdmin):
    groups = (await session.scalars(select(TestGroup).order_by(TestGroup.name))).all()
    return [_out(g) for g in groups]


@router.post("", response_model=TestGroupOut, status_code=status.HTTP_201_CREATED)
async def create_group(body: TestGroupIn, session: SessionDep, _: CurrentAdmin):
    first = not await session.scalar(select(TestGroup.id).limit(1))
    g = TestGroup(name=body.name.strip(), members=[])
    session.add(g)
    await session.flush()
    await _apply(session, g, body.model_copy(update={"is_default": body.is_default or first}))
    await session.commit()
    await session.refresh(g)
    return _out(g)


@router.put("/{group_id}", response_model=TestGroupOut)
async def update_group(group_id: int, body: TestGroupIn, session: SessionDep, _: CurrentAdmin):
    g = await _get(session, group_id)
    await _apply(session, g, body)
    await session.commit()
    await session.refresh(g)
    return _out(g)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(group_id: int, session: SessionDep, _: CurrentAdmin):
    g = await _get(session, group_id)
    await session.delete(g)
    await session.commit()


@router.post("/resolve", response_model=Member)
async def resolve_chat(
    body: ResolveIn, session: SessionDep, telegram: TelegramDep, _: CurrentAdmin
):
    """Check that a bot can reach a chat ID and return its name and type."""
    bot = await session.get(Bot, body.bot_id)
    if bot is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bot not found")
    try:
        chat = await look_up_chat(telegram, unseal_token(bot.token_encrypted), body.chat_id)
    except ChatUnreachable as exc:
        raise HTTPException(_422, str(exc)) from exc
    except TelegramUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    return Member(bot_id=bot.id, chat_id=chat.chat_id, label=chat.title, kind=chat.kind)


@router.post("/{group_id}/send", response_model=list[SendResultOut])
async def send_to_group(
    group_id: int, body: SendIn, session: SessionDep, telegram: TelegramDep, admin: CurrentAdmin
):
    """Send a (possibly unsaved) message to every member. Failures are reported per member."""
    g = await _get(session, group_id)
    if body.message.is_empty:
        raise HTTPException(_422, "The message is empty")
    if not g.members:
        raise HTTPException(_422, f"{g.name} has no members yet")
    bots = {
        b.id: b
        for b in (
            await session.scalars(select(Bot).where(Bot.id.in_({m["bot_id"] for m in g.members})))
        ).all()
    }
    results: list[SendResultOut] = []
    for m in (Member.model_validate(x) for x in g.members):
        bot = bots.get(m.bot_id)
        if bot is None or not bot.is_active or not bot.token_valid:
            results.append(
                SendResultOut(
                    **m.model_dump(exclude={"kind"}),
                    delivered=False,
                    error="The bot is disabled or its token is invalid",
                )
            )
            continue
        sent = await send_once(session, telegram, bot, m.chat_id, body.message)
        error = None
        if sent.status != SendStatus.DELIVERED:
            error = sent.error or "Not delivered"
            if sent.status in (SendStatus.RECIPIENT_BLOCKED, SendStatus.RECIPIENT_UNREACHABLE):
                error += ". The bot can't reach this chat anymore."
        results.append(
            SendResultOut(**m.model_dump(exclude={"kind"}), delivered=error is None, error=error)
        )
    if body.campaign_id and await session.get(Campaign, body.campaign_id):
        record(
            session,
            admin,
            "campaign.test_sent",
            "campaign",
            body.campaign_id,
            group=g.name,
            delivered=sum(r.delivered for r in results),
            total=len(results),
        )
        await session.commit()
    return results
