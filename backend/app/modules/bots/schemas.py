from datetime import datetime

from pydantic import BaseModel, Field

from app.modules.subscribers.schemas import SubscriberCounts


class BotCreate(BaseModel):
    token: str = Field(min_length=20, max_length=128, pattern=r"^\d+:[\w-]+$")
    description: str = Field(default="", max_length=500)


class BotUpdate(BaseModel):
    description: str | None = Field(default=None, max_length=500)
    is_active: bool | None = None
    token: str | None = Field(default=None, min_length=20, max_length=128, pattern=r"^\d+:[\w-]+$")


class BotOut(BaseModel):
    id: int
    telegram_id: int
    username: str
    display_name: str
    description: str
    is_active: bool
    token_valid: bool
    api_key_prefix: str
    last_checked_at: datetime | None
    last_ingest_at: datetime | None
    created_at: datetime
    subscribers: SubscriberCounts


class BotWithKey(BotOut):
    api_key: str  # shown exactly once
