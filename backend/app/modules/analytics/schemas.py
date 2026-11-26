from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

from app.modules.sources.schemas import SubscriberCounts

Range = Literal["7d", "30d", "90d", "12m", "all"]
Unit = Literal["day", "week", "month"]


class Period(BaseModel):
    range: Range
    unit: Unit
    start: date
    end: date
    buckets: list[date]  # first day of every bucket, oldest first


class Kpis(BaseModel):
    people: int  # unique across the selected bots
    subscriptions: int  # sum over bots (a person on two bots counts twice)
    multi_bot_people: int  # on two or more of the selected bots
    new_people: int | None  # joined in the period (None: no bot has "Joined at" mapped)
    new_people_previous: int | None  # same length, just before
    blocked: int  # learned while sending, in the period


class GrowthPoint(BaseModel):
    t: date
    bot_id: int
    count: int


class Growth(BaseModel):
    points: list[GrowthPoint]
    before_start: dict[int, int]  # per bot: people who joined before the period
    missing_joined_at: list[int]  # bots without "Joined at" mapped


class OverlapPair(BaseModel):
    a: int
    b: int
    people: int


class Overlap(BaseModel):
    by_bot_count: dict[int, int]  # number of bots -> people on exactly that many
    pairs: list[OverlapPair]
    per_bot: dict[int, int]  # reachable people per bot


class LanguageCount(BaseModel):
    code: str
    people: int


class Languages(BaseModel):
    items: list[LanguageCount]
    unknown: int  # people with no language recorded
    missing_language: list[int]  # bots without "Language" mapped


class ChatTypes(BaseModel):
    per_bot: dict[int, dict[str, int]]  # reachable chats per type (private, group, ...)
    group_members: dict[int, int]  # members of reachable groups and channels, summed
    missing: list[int]  # bots without "Chat type" mapped


class Premium(BaseModel):
    premium: dict[int, int]  # reachable people with Telegram Premium
    people: dict[int, int]  # reachable people (private chats), the base for the share
    missing: list[int]  # bots without "Premium" mapped


class BlockedPoint(BaseModel):
    t: date
    count: int


class BroadcastMarker(BaseModel):
    id: int
    name: str
    started: datetime
    bucket: date  # the chart bucket it falls in


class AudienceAnalytics(BaseModel):
    period: Period
    bots: list[int]
    kpis: Kpis
    growth: Growth
    overlap: Overlap
    languages: Languages
    reach: dict[int, SubscriberCounts]  # per bot: who can receive, and why the rest can't
    chat_types: ChatTypes
    premium: Premium
    blocked: list[BlockedPoint]
    broadcasts: list[BroadcastMarker]  # started in the period, through any selected bot
    errors: dict[int, str]  # bots whose database couldn't be read


class BroadcastPerformance(BaseModel):
    id: int
    name: str
    status: str
    started: datetime
    finished: datetime | None
    total: int  # messages to the selected bots
    sent: int
    blocked: int
    failed: int  # failed + unreachable
    delivery_rate: float | None
    block_rate: float | None
    seconds: int | None


class BroadcastAnalytics(BaseModel):
    period: Period
    items: list[BroadcastPerformance]


class ColumnChoice(BaseModel):
    ref: str  # "column" or "linked_table.column"
    table: str
    name: str
    type: str


class BreakdownItem(BaseModel):
    value: str
    people: int


class Breakdown(BaseModel):
    bot_id: int
    column: str
    total: int
    items: list[BreakdownItem]  # top values, most people first
    other: int  # people in values beyond the top
    empty: int  # people with no value
    grouped_by_month: bool
