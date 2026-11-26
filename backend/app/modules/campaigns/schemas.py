from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.integrations.telegram.messages import MessageContent


class Recipient(BaseModel):
    bot_id: int
    chat_id: int
    label: str = Field(default="", max_length=200)


class Audience(BaseModel):
    """Everyone active on the chosen bots, or only hand-picked people (e.g. a test group)."""

    mode: Literal["all", "selected"] = "all"
    recipients: list[Recipient] = Field(default_factory=list, max_length=500)
    # With mode "all": only these kinds of chat. Empty means every kind.
    kinds: list[Literal["people", "groups", "channels"]] = Field(default_factory=list, max_length=3)


class CampaignIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    bot_ids: list[int] = Field(default_factory=list, max_length=200)
    message: MessageContent = Field(default_factory=MessageContent)
    audience: Audience = Field(default_factory=Audience)


class CampaignUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    bot_ids: list[int] | None = Field(default=None, max_length=200)
    message: MessageContent | None = None
    audience: Audience | None = None


class LaunchIn(BaseModel):
    scheduled_at: datetime | None = None  # None = send now


class DeliveryStats(BaseModel):
    pending: int = 0
    sent: int = 0
    failed: int = 0
    blocked: int = 0
    skipped: int = 0
    total: int = 0


class CampaignBotStats(BaseModel):
    bot_id: int
    username: str
    display_name: str
    audience: int  # active subscribers right now (meaningful before launch)
    stats: DeliveryStats
    error: str | None = None


class CampaignOut(BaseModel):
    id: int
    name: str
    status: str
    message: MessageContent
    bot_ids: list[int]
    audience: Audience
    source_campaign_id: int | None  # the broadcast this one was copied from
    scheduled_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime
    stats: DeliveryStats


class RelatedCampaign(BaseModel):
    """A broadcast this one was copied from, or a copy of it."""

    id: int
    name: str
    status: str
    created_at: datetime
    started_at: datetime | None
    audience_mode: str
    bot_ids: list[int]
    stats: DeliveryStats


class ShareOut(BaseModel):
    token: str
    hide_message: bool


class ShareIn(BaseModel):
    hide_message: bool = False
    regenerate: bool = False


class CampaignDetail(CampaignOut):
    share: ShareOut | None = None
    bots: list[CampaignBotStats]
    copied_from: RelatedCampaign | None = None
    copies: list[RelatedCampaign] = []  # made from this one, oldest first


class CampaignPage(BaseModel):
    items: list[CampaignOut]
    total: int


class DeliveryOut(BaseModel):
    id: int
    bot_id: int
    chat_id: int
    status: str
    attempts: int
    error: str | None
    sent_at: datetime | None


class DeliveryPage(BaseModel):
    items: list[DeliveryOut]
    total: int


class TestSendIn(BaseModel):
    bot_id: int
    chat_id: int
    message: MessageContent


class TestSendOut(BaseModel):
    message_id: int


Outcome = Literal["delivered", "blocked", "unreachable", "failed"]


class TimelinePoint(BaseModel):
    """Messages with one final outcome, from one bot, in one time slice."""

    t: datetime  # slice start
    bot_id: int
    outcome: Outcome
    count: int


class ErrorGroup(BaseModel):
    bot_id: int
    status: str
    error: str
    count: int


class ProgressOut(BaseModel):
    """Live numbers for the broadcast page. The client filters by bot and outcome."""

    bucket_seconds: int
    start: datetime | None  # first slice (None before sending starts)
    end: datetime | None  # last slice
    points: list[TimelinePoint]
    per_minute: float  # observed over the last 2 minutes; 0 when idle
    eta_seconds: int | None  # None when nothing is pending
    elapsed_seconds: int | None
    errors: list[ErrorGroup]


class EstimateBot(BaseModel):
    bot_id: int
    recipients: int


class EstimateOut(BaseModel):
    recipients: int
    seconds: int  # at Telegram's broadcast rate, bots sending in parallel
    bots: list[EstimateBot]
