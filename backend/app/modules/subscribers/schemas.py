from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, computed_field

from app.modules.subscribers.models import SubscriberStatus


class SubscriberCounts(BaseModel):
    active: int = 0
    blocked: int = 0
    unsubscribed: int = 0
    unreachable: int = 0
    source: Literal["integration", "database"] = "integration"
    # Set when the bot's database couldn't be read; `active` is then the last cached count.
    source_error: str | None = None

    @computed_field
    @property
    def total(self) -> int:
        return self.active + self.blocked + self.unsubscribed + self.unreachable


class SubscriberIn(BaseModel):
    chat_id: int
    username: str | None = Field(default=None, max_length=64)
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    language_code: str | None = Field(default=None, max_length=16)
    status: SubscriberStatus = SubscriberStatus.ACTIVE
    subscribed_at: datetime | None = None
    attributes: dict = Field(default_factory=dict)


class SubscriberBatchIn(BaseModel):
    subscribers: list[SubscriberIn] = Field(min_length=1, max_length=1000)


class SubscriberBatchOut(BaseModel):
    received: int


class SubscriberOut(BaseModel):
    chat_id: int
    username: str | None
    first_name: str | None
    last_name: str | None
    language_code: str | None
    status: str
    subscribed_at: datetime | None
    last_seen_at: datetime | None
