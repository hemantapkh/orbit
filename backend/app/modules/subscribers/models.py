from datetime import datetime
from enum import StrEnum

from sqlalchemy import JSON, BigInteger, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UTCDateTime


class SubscriberStatus(StrEnum):
    ACTIVE = "active"
    BLOCKED = "blocked"  # user blocked the bot / deactivated (learned from delivery)
    UNSUBSCRIBED = "unsubscribed"  # bot reported the user opted out
    UNREACHABLE = "unreachable"  # Telegram says the chat doesn't exist


class Subscriber(Base, TimestampMixin):
    """A Telegram chat subscribed to one bot. The same person across bots shares chat_id."""

    __tablename__ = "subscribers"
    __table_args__ = (
        UniqueConstraint("bot_id", "chat_id", name="uq_subscribers_bot_chat"),
        Index("ix_subscribers_bot_status", "bot_id", "status"),
        Index("ix_subscribers_chat_id", "chat_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int] = mapped_column(ForeignKey("bots.id", ondelete="CASCADE"))
    chat_id: Mapped[int] = mapped_column(BigInteger)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    language_code: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=SubscriberStatus.ACTIVE)
    subscribed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    attributes: Mapped[dict] = mapped_column(JSON, default=dict)
