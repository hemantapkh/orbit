from datetime import datetime
from enum import StrEnum

from sqlalchemy import JSON, BigInteger, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UTCDateTime, utcnow


class SourceKind(StrEnum):
    DATABASE = "database"  # Orbit reads the bot's own database live


class SourceStatus(StrEnum):
    UNCHECKED = "unchecked"
    HEALTHY = "healthy"
    ERROR = "error"


class BotSource(Base, TimestampMixin):
    """A bot's database connection: where its subscriber list is read from."""

    __tablename__ = "bot_sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int] = mapped_column(ForeignKey("bots.id", ondelete="CASCADE"), unique=True)
    kind: Mapped[str] = mapped_column(String(16), default=SourceKind.DATABASE)
    database_url_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    schema_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    table_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    column_map: Mapped[dict] = mapped_column(JSON, default=dict)
    filters: Mapped[list] = mapped_column(JSON, default=list)
    # Linked tables used by the mapping or filters (see schemas.Join).
    joins: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default=SourceStatus.UNCHECKED)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    cached_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cached_count_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # Why the rest can't be reached, as of cached_count_at: blocked/left/deleted/unreachable.
    cached_breakdown: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # Up to when Orbit has checked whether people it saw fail used the bot again.
    returned_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class BotSuppression(Base):
    """Chats a bot must not message again (learned during delivery). We never write to a
    bot's own database, so Orbit keeps this list."""

    __tablename__ = "bot_suppressions"
    __table_args__ = (UniqueConstraint("bot_id", "chat_id", name="uq_bot_suppressions_bot_chat"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int] = mapped_column(ForeignKey("bots.id", ondelete="CASCADE"))
    chat_id: Mapped[int] = mapped_column(BigInteger)
    reason: Mapped[str] = mapped_column(String(16))  # blocked | unreachable
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
