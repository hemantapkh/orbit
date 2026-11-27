from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy import exists, select

from app.core.db import utcnow
from app.core.deps import SessionDep, TelegramDep
from app.integrations.telegram.bots import (
    BotIdentity,
    TelegramUnavailable,
    TokenRejected,
    identify,
    seal_token,
    unseal_token,
)
from app.integrations.telegram.client import TelegramClient
from app.modules.activity.service import record
from app.modules.bots.models import Bot
from app.modules.bots.profile import avatar_path, sync_profile
from app.modules.bots.schemas import BotCreate, BotOut, BotUpdate
from app.modules.campaigns.models import Delivery
from app.modules.orgs.deps import Admin, Member, Sender, Viewer, get_in_org
from app.modules.sources.schemas import SubscriberCounts
from app.modules.sources.service import counts_by_bot, database_sources, id_cache

router = APIRouter(prefix="/bots", tags=["bots"])


def to_out(bot: Bot, counts: SubscriberCounts) -> BotOut:
    return BotOut(
        id=bot.id,
        telegram_id=bot.telegram_id,
        username=bot.username,
        display_name=bot.display_name,
        is_active=bot.is_active,
        about=bot.about or "",
        telegram_description=bot.telegram_description or "",
        avatar_version=bot.avatar_version,
        token_valid=bot.token_valid,
        last_checked_at=bot.last_checked_at,
        created_at=bot.created_at,
        subscribers=counts,
    )


async def _get_bot(session, bot_id: int, m: Member) -> Bot:
    return await get_in_org(session, Bot, bot_id, m.org_id, "Bot")


async def _identify(telegram: TelegramClient, token: str) -> BotIdentity:
    try:
        return await identify(telegram, token)
    except TokenRejected as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    except TelegramUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc


@router.get("", response_model=list[BotOut])
async def list_bots(session: SessionDep, m: Viewer):
    bots = (
        await session.scalars(select(Bot).where(Bot.org_id == m.org_id).order_by(Bot.display_name))
    ).all()
    counts = await counts_by_bot(session, [b.id for b in bots])
    return [to_out(b, counts[b.id]) for b in bots]


@router.post("", response_model=BotOut, status_code=status.HTTP_201_CREATED)
async def connect_bot(body: BotCreate, session: SessionDep, telegram: TelegramDep, m: Admin):
    me = await _identify(telegram, body.token)
    if await session.scalar(select(Bot.id).where(Bot.telegram_id == me.telegram_id)):
        raise HTTPException(status.HTTP_409_CONFLICT, f"@{me.username} is already connected")
    bot = Bot(
        org_id=m.org_id,
        telegram_id=me.telegram_id,
        username=me.username,
        display_name=me.display_name,
        token_encrypted=seal_token(body.token),
        last_checked_at=utcnow(),
    )
    session.add(bot)
    await session.flush()
    await sync_profile(telegram, bot)
    record(session, m.user, "bot.connected", "bot", bot.id, org_id=m.org_id, username=bot.username)
    await session.commit()
    await session.refresh(bot)
    return to_out(bot, SubscriberCounts())


@router.get("/{bot_id}", response_model=BotOut)
async def get_bot(bot_id: int, session: SessionDep, m: Viewer):
    bot = await _get_bot(session, bot_id, m)
    counts = await counts_by_bot(session, [bot.id])
    return to_out(bot, counts[bot.id])


@router.patch("/{bot_id}", response_model=BotOut)
async def update_bot(
    bot_id: int, body: BotUpdate, session: SessionDep, telegram: TelegramDep, m: Admin
):
    bot = await _get_bot(session, bot_id, m)
    if body.token is not None:
        me = await _identify(telegram, body.token)
        if me.telegram_id != bot.telegram_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "That token belongs to a different bot"
            )
        bot.token_encrypted = seal_token(body.token)
        bot.token_valid = True
        bot.last_checked_at = utcnow()
    if body.is_active is not None:
        bot.is_active = body.is_active
    record(
        session,
        m.user,
        "bot.updated",
        "bot",
        bot.id,
        org_id=m.org_id,
        changed=sorted(body.model_dump(exclude_none=True)),  # field names only, never values
        is_active=body.is_active,
    )
    await session.commit()
    return await get_bot(bot_id, session, m)


async def _recheck(session, telegram, bot: Bot) -> None:
    """Re-check the token, pull name, username, photo and texts, and recount the audience."""
    try:
        me = await identify(telegram, unseal_token(bot.token_encrypted))
        bot.username, bot.display_name, bot.token_valid = me.username, me.display_name, True
        await sync_profile(telegram, bot)
    except TokenRejected:
        bot.token_valid = False
    bot.last_checked_at = utcnow()
    if source := (await database_sources(session, [bot.id])).get(bot.id):
        id_cache.drop(source.id)  # next count reads the bot's database again
        source.cached_count_at = None


@router.post("/refresh", response_model=list[BotOut])
async def refresh_all(session: SessionDep, telegram: TelegramDep, m: Sender):
    """Refresh every bot. One bot failing (e.g. Telegram hiccup) doesn't stop the others."""
    bots = (
        await session.scalars(select(Bot).where(Bot.org_id == m.org_id).order_by(Bot.display_name))
    ).all()
    for bot in bots:
        try:
            await _recheck(session, telegram, bot)
        except TelegramUnavailable:
            pass
    await session.commit()
    counts = await counts_by_bot(session, [b.id for b in bots])
    return [to_out(b, counts[b.id]) for b in bots]


@router.post("/{bot_id}/refresh", response_model=BotOut)
async def refresh_bot(bot_id: int, session: SessionDep, telegram: TelegramDep, m: Sender):
    """Refresh one bot from Telegram and recount its audience."""
    bot = await _get_bot(session, bot_id, m)
    try:
        await _recheck(session, telegram, bot)
    except TelegramUnavailable as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    await session.commit()
    return await get_bot(bot_id, session, m)


@router.get("/{bot_id}/avatar")
async def bot_avatar(bot_id: int, session: SessionDep, m: Viewer):
    """The bot's Telegram profile photo, served by Orbit (Telegram's link holds the token)."""
    bot = await _get_bot(session, bot_id, m)
    path = avatar_path(bot.id)
    if not bot.avatar_version or not path.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No photo")
    # The URL carries ?v=<version>, so it can be cached until the photo changes.
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@router.delete("/{bot_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bot(bot_id: int, session: SessionDep, m: Admin):
    bot = await _get_bot(session, bot_id, m)
    if await session.scalar(select(exists().where(Delivery.bot_id == bot.id))):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This bot has campaign history. Disable it instead to keep the records.",
        )
    record(session, m.user, "bot.removed", "bot", bot.id, org_id=m.org_id, username=bot.username)
    await session.delete(bot)
    await session.commit()
