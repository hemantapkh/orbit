"""Bot identity and credentials. The bot token is a Telegram secret: it's sealed and
unsealed here, so nothing else needs to know how it's stored."""

from dataclasses import dataclass

from app.core.security import decrypt_secret, encrypt_secret
from app.integrations.telegram.client import TelegramClient, TelegramError


class TokenRejected(Exception):
    """Telegram says the token is invalid, revoked, or not a bot token."""


class TelegramUnavailable(Exception):
    """Telegram couldn't be asked right now (network error, outage)."""


@dataclass(frozen=True, slots=True)
class BotIdentity:
    telegram_id: int
    username: str
    display_name: str


async def identify(client: TelegramClient, token: str) -> BotIdentity:
    try:
        me = await client.get_me(token)
    except TelegramError as exc:
        if exc.error_code in (401, 404):
            raise TokenRejected("Telegram rejected this token") from exc
        raise TelegramUnavailable(f"Telegram: {exc.description}") from exc
    if not me.get("is_bot"):
        raise TokenRejected("Token is not a bot token")
    username = me.get("username", "")
    return BotIdentity(
        telegram_id=me["id"], username=username, display_name=me.get("first_name", username)
    )


def seal_token(token: str) -> str:
    return encrypt_secret(token)


def unseal_token(sealed: str) -> str:
    return decrypt_secret(sealed)
