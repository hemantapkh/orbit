from datetime import datetime

from sqlalchemy import BigInteger, Boolean, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UTCDateTime


class Bot(Base, TimestampMixin):
    """An independent Telegram bot connected to the platform."""

    __tablename__ = "bots"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True)
    username: Mapped[str] = mapped_column(String(64))
    display_name: Mapped[str] = mapped_column(String(128))
    token_encrypted: Mapped[str] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # From Telegram (refreshed on connect and "Check now"): profile texts and photo.
    about: Mapped[str] = mapped_column(Text, default="")
    telegram_description: Mapped[str] = mapped_column(Text, default="")
    avatar_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    token_valid: Mapped[bool] = mapped_column(Boolean, default=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
