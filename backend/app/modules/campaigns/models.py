from datetime import datetime
from enum import StrEnum

from sqlalchemy import JSON, BigInteger, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin, UTCDateTime

# BIGINT doesn't auto-increment on SQLite; fall back to INTEGER there.
BigId = BigInteger().with_variant(Integer, "sqlite")


class CampaignStatus(StrEnum):
    DRAFT = "draft"
    SCHEDULED = "scheduled"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class DeliveryStatus(StrEnum):
    PENDING = "pending"
    SENDING = "sending"  # claimed by a delivery engine; back to pending if it never reports
    SENT = "sent"
    FAILED = "failed"
    BLOCKED = "blocked"
    SKIPPED = "skipped"  # campaign cancelled or bot disabled before this one went out


class Campaign(Base, TimestampMixin):
    __tablename__ = "campaigns"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(160))
    status: Mapped[str] = mapped_column(String(16), default=CampaignStatus.DRAFT, index=True)
    message: Mapped[dict] = mapped_column(JSON, default=dict)
    scheduled_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True
    )
    # {"mode": "all"} or {"mode": "selected", "recipients": [{bot_id, chat_id, label}]}
    audience: Mapped[dict] = mapped_column(JSON, default=lambda: {"mode": "all"})
    # Resends point at the first broadcast of the same message, so sends can be grouped.
    source_campaign_id: Mapped[int | None] = mapped_column(
        ForeignKey("campaigns.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Read-only public link (/share/<token>). None = not shared.
    share_token: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    share_hide_message: Mapped[bool] = mapped_column(default=False)


class TestGroup(Base, TimestampMixin):
    """Saved recipients for test sends: people, groups or channels, each via one bot."""

    __test__ = False  # not a pytest test class
    __tablename__ = "test_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    # [{bot_id, chat_id, label, kind}]
    members: Mapped[list] = mapped_column(JSON, default=list)
    is_default: Mapped[bool] = mapped_column(default=False)


class CampaignBot(Base):
    """Audience selection: which bots a campaign goes out through."""

    __tablename__ = "campaign_bots"

    campaign_id: Mapped[int] = mapped_column(
        ForeignKey("campaigns.id", ondelete="CASCADE"), primary_key=True
    )
    bot_id: Mapped[int] = mapped_column(ForeignKey("bots.id", ondelete="CASCADE"), primary_key=True)
    # Why this bot sent nothing, e.g. its database couldn't be read at campaign start.
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class Delivery(Base):
    """One message to one subscriber. Rows are snapshotted when the campaign starts."""

    __tablename__ = "deliveries"
    __table_args__ = (
        Index("ix_deliveries_campaign_status", "campaign_id", "status"),
        Index("ix_deliveries_campaign_bot_status", "campaign_id", "bot_id", "status"),
        Index("ix_deliveries_campaign_processed", "campaign_id", "processed_at"),
        Index("ix_deliveries_status_claimed", "status", "claimed_at"),
    )

    id: Mapped[int] = mapped_column(BigId, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(ForeignKey("campaigns.id", ondelete="CASCADE"))
    bot_id: Mapped[int] = mapped_column(ForeignKey("bots.id", ondelete="CASCADE"))
    chat_id: Mapped[int] = mapped_column(BigInteger)
    # Values for {first_name} etc., read from the bot's database when sending started.
    # Only stored when the message is personalized.
    vars: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=DeliveryStatus.PENDING)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # When an engine claimed it for sending (status "sending").
    claimed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    # When the outcome was final (sent, failed or blocked): drives the progress timeline.
    processed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
