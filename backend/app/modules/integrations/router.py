"""Public API for connected bots. Authenticated with the bot's integration key, never with
admin sessions. Bots push their state here instead of exposing their own databases."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select

from app.core.db import utcnow
from app.core.deps import SessionDep
from app.core.security import API_KEY_PREFIX, hash_api_key
from app.modules.bots.models import Bot
from app.modules.subscribers.schemas import SubscriberBatchIn, SubscriberBatchOut
from app.modules.subscribers.service import upsert_subscribers

router = APIRouter(prefix="/integration/v1", tags=["integration"])


async def integration_bot(request: Request, session: SessionDep) -> Bot:
    auth = request.headers.get("authorization", "")
    scheme, _, key = auth.partition(" ")
    if scheme.lower() != "bearer" or not key.startswith(API_KEY_PREFIX):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing integration key")

    bot = await session.scalar(select(Bot).where(Bot.api_key_hash == hash_api_key(key)))
    if bot is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid integration key")
    if not bot.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Bot is disabled on the platform")
    return bot


IntegrationBot = Annotated[Bot, Depends(integration_bot)]


class BotIdentity(BaseModel):
    id: int
    telegram_id: int
    username: str


@router.get("/bot", response_model=BotIdentity)
async def whoami(bot: IntegrationBot):
    return BotIdentity(id=bot.id, telegram_id=bot.telegram_id, username=bot.username)


@router.post("/subscribers", response_model=SubscriberBatchOut)
async def push_subscribers(body: SubscriberBatchIn, bot: IntegrationBot, session: SessionDep):
    """Upsert up to 1000 subscribers. Send status=unsubscribed when a user opts out."""
    received = await upsert_subscribers(session, bot.id, body.subscribers)
    bot.last_ingest_at = utcnow()
    await session.commit()
    return SubscriberBatchOut(received=received)
