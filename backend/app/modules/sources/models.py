from datetime import datetime
from enum import StrEnum

from sqlalchemy import JSON, BigInteger, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UTCDateTime, utcnow


class SourceKind(StrEnum):
    INTEGRATION = "integration"  # the bot pushes subscribers to the integration API
    DATABASE = "database"  # Orbit reads the bot's own database live


class SourceStatus(StrEnum):
    UNCHECKED = "unchecked"
    HEALTHY = "healthy"
    ERROR = "error"


class BotSource(Base, TimestampMixin):
    """Where a bot's subscriber list comes from. No row means the integration API."""

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


class BotSuppression(Base):
    """Chats a database-source bot must not message again (learned during delivery).

    Integration bots record this on subscribers.status instead; we can't write to a bot's
    own database, so the platform keeps the list."""

    __tablename__ = "bot_suppressions"
    __table_args__ = (UniqueConstraint("bot_id", "chat_id", name="uq_bot_suppressions_bot_chat"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    bot_id: Mapped[int] = mapped_column(ForeignKey("bots.id", ondelete="CASCADE"))
    chat_id: Mapped[int] = mapped_column(BigInteger)
    reason: Mapped[str] = mapped_column(String(16))  # blocked | unreachable
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
