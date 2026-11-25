"""Keep a bot's Telegram profile (photo, about, description) mirrored in Orbit."""

import asyncio
import logging
from pathlib import Path

from app.core.config import get_settings
from app.integrations.telegram.bots import fetch_profile, unseal_token
from app.integrations.telegram.client import TelegramClient
from app.modules.bots.models import Bot

log = logging.getLogger("orbit.bots")


def avatar_path(bot_id: int) -> Path:
    return get_settings().media_dir / "avatars" / f"bot-{bot_id}.jpg"


async def sync_profile(telegram: TelegramClient, bot: Bot) -> None:
    """Best effort: a Telegram hiccup here must never block connecting or checking a bot."""
    try:
        p = await fetch_profile(telegram, unseal_token(bot.token_encrypted), bot.telegram_id)
    except Exception:
        log.warning("Couldn't fetch the Telegram profile of bot %s", bot.id, exc_info=True)
        return
    bot.about, bot.telegram_description = p.about, p.description
    path = avatar_path(bot.id)
    if p.photo:
        path.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, p.photo)
        bot.avatar_version = p.photo_unique_id or "1"
    else:
        path.unlink(missing_ok=True)
        bot.avatar_version = None
