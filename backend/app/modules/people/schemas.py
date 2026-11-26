from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ChatKind = Literal["people", "groups", "channels"]
Category = Literal["can_receive", "blocked", "left", "deleted", "unreachable"]
Activity = Literal["24h", "7d", "30d", "90d", "dormant_30d", "dormant_90d", "never"]
Joined = Literal["24h", "7d", "30d", "90d"]
Sort = Literal["last_active", "joined", "name", "kind", "language", "bots"]
Order = Literal["asc", "desc"]


class PeopleQuery(BaseModel):
    """Filters for the People list. Every filter is optional."""

    bots: list[int] = Field(default_factory=list)  # empty: every bot with a database
    q: str | None = Field(default=None, max_length=100)
    kinds: list[ChatKind] = Field(default_factory=list)  # any of these
    statuses: list[Category] = Field(default_factory=list)  # any of these
    active: Activity | None = None
    joined: Joined | None = None
    languages: list[str] = Field(default_factory=list, max_length=20)  # code prefixes
    premium: bool | None = None
    multi: bool = False  # on two or more of the bots
    sort: Sort = "last_active"
    order: Order | None = (
        None  # None: the column's natural order (dates and bots newest/most first)
    )


class BotRecord(BaseModel):
    """What one bot's database says about a chat."""

    bot_id: int
    category: str  # can_receive / blocked / left / deleted / unreachable / excluded
    joined_at: datetime | None = None
    last_active_at: datetime | None = None
    language_code: str | None = None


class Person(BaseModel):
    chat_id: int
    name: str | None  # first and last name, or a group's title
    username: str | None
    kind: str | None  # private / group / supergroup / channel, when mapped
    language_code: str | None
    is_premium: bool | None
    joined_at: datetime | None  # earliest across bots
    last_active_at: datetime | None  # latest across bots
    bots: list[BotRecord]


class PeoplePage(BaseModel):
    total: int
    page: int
    size: int
    items: list[Person]
    # Bots left out because a filter needs a field they don't map: bot_id -> field labels.
    skipped: dict[int, list[str]]
    errors: dict[int, str]  # bots whose database couldn't be read


class Received(BaseModel):
    campaign_id: int
    campaign_name: str
    bot_id: int
    status: str
    at: datetime | None
    error: str | None


class PersonDetail(BaseModel):
    person: Person | None  # None: no bot's database knows this chat
    received: list[Received]  # broadcasts Orbit sent them, newest first
