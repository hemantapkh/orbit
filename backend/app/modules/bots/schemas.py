from datetime import datetime

from pydantic import BaseModel, Field

from app.modules.sources.schemas import SubscriberCounts


class BotCreate(BaseModel):
    token: str = Field(min_length=20, max_length=128, pattern=r"^\d+:[\w-]+$")


class BotUpdate(BaseModel):
    is_active: bool | None = None
    token: str | None = Field(default=None, min_length=20, max_length=128, pattern=r"^\d+:[\w-]+$")


class BotOut(BaseModel):
    id: int
    telegram_id: int
    username: str
    display_name: str
    is_active: bool
    token_valid: bool
    about: str  # Telegram short description ("About")
    telegram_description: str  # shown in an empty chat, before Start
    avatar_version: str | None  # None: no photo; changes when the photo changes
    last_checked_at: datetime | None
    created_at: datetime
    subscribers: SubscriberCounts
