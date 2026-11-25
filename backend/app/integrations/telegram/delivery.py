"""Send one message and say what happened, in terms the rest of Orbit understands.

Telegram error codes are interpreted here and nowhere else."""

from dataclasses import dataclass
from enum import StrEnum

from app.integrations.telegram.client import MediaRef, TelegramClient, TelegramError
from app.integrations.telegram.messages import MessageContent


class SendStatus(StrEnum):
    DELIVERED = "delivered"
    RECIPIENT_BLOCKED = "recipient_blocked"  # blocked the bot, deactivated, kicked it
    RECIPIENT_UNREACHABLE = "recipient_unreachable"  # chat doesn't exist
    RATE_LIMITED = "rate_limited"  # wait retry_after seconds, then retry
    TRANSIENT = "transient"  # network or server error: worth retrying
    FAILED = "failed"  # anything else (bad markup, file too large, ...)


@dataclass(slots=True)
class SendResult:
    status: SendStatus
    message_id: int | None = None
    file_id: str | None = None  # set when media was uploaded: reuse it for this bot
    retry_after: float | None = None
    error: str | None = None


async def deliver(
    client: TelegramClient,
    token: str,
    chat_id: int,
    content: MessageContent,
    media: MediaRef | None = None,
) -> SendResult:
    try:
        sent = await client.send(token, chat_id, content, media)
    except TelegramError as exc:
        return SendResult(_classify(exc), error=exc.description, retry_after=exc.retry_after)
    return SendResult(SendStatus.DELIVERED, message_id=sent.message_id, file_id=sent.file_id)


def _classify(exc: TelegramError) -> SendStatus:
    if exc.retry_after is not None:
        return SendStatus.RATE_LIMITED
    if exc.error_code == 403:
        return SendStatus.RECIPIENT_BLOCKED
    if exc.error_code == 400 and "chat not found" in exc.description.lower():
        return SendStatus.RECIPIENT_UNREACHABLE
    if exc.error_code == 0 or exc.error_code >= 500 or exc.error_code == 429:
        return SendStatus.TRANSIENT
    return SendStatus.FAILED
