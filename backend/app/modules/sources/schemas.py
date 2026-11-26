from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field

FilterOp = Literal["eq", "neq", "is_null", "not_null", "is_true", "is_false"]
MAPPED_FIELDS = (
    "chat_id",
    "username",
    "first_name",
    "last_name",
    "language_code",
    "joined_at",
    "is_active",
    "chat_type",
    "status",
    "unreachable_reason",
    "last_active_at",
    "is_premium",
    "title",
    "member_count",
    "status_changed_at",
    "unreachable_at",
)


class ColumnMap(BaseModel):
    chat_id: str = Field(min_length=1, max_length=128)
    username: str | None = Field(default=None, max_length=128)
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    language_code: str | None = Field(default=None, max_length=128)
    joined_at: str | None = Field(default=None, max_length=128)
    is_active: str | None = Field(default=None, max_length=128)
    # Optional reachability and profile fields. Values follow Telegram's vocabulary
    # (chat type: private/group/supergroup/channel; status: ChatMember.status).
    chat_type: str | None = Field(default=None, max_length=128)
    status: str | None = Field(default=None, max_length=128)
    unreachable_reason: str | None = Field(default=None, max_length=128)
    last_active_at: str | None = Field(default=None, max_length=128)
    is_premium: str | None = Field(default=None, max_length=128)
    title: str | None = Field(default=None, max_length=128)
    member_count: str | None = Field(default=None, max_length=128)
    # When the status last changed / the chat became unreachable: dates the losses.
    status_changed_at: str | None = Field(default=None, max_length=128)
    unreachable_at: str | None = Field(default=None, max_length=128)

    def mapped(self) -> dict[str, str]:
        return {k: v for k, v in self.model_dump().items() if v}


class SourceFilter(BaseModel):
    column: str = Field(min_length=1, max_length=128)
    op: FilterOp
    value: str | int | float | bool | None = None


class Join(BaseModel):
    """A table linked to the main table: related.related_column = main.base_column.

    Columns on it are referenced as "table.column" in the mapping and filters."""

    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    table: str = Field(min_length=1, max_length=128)
    db_schema: str | None = Field(default=None, alias="schema", max_length=128)
    base_column: str = Field(min_length=1, max_length=128)
    related_column: str = Field(min_length=1, max_length=128)


class SourceSpec(BaseModel):
    """Which rows of which table are this bot's subscribers."""

    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    table: str = Field(min_length=1, max_length=128)
    db_schema: str | None = Field(default=None, alias="schema", max_length=128)
    column_map: ColumnMap
    filters: list[SourceFilter] = Field(default_factory=list, max_length=20)
    joins: list[Join] = Field(default_factory=list, max_length=10)


class ConnectionIn(BaseModel):
    """Either a new URL, or bot_id to reuse that bot's saved connection."""

    database_url: str | None = Field(default=None, max_length=2048)
    bot_id: int | None = None


class PreviewIn(ConnectionIn, SourceSpec):
    pass


class SourceSaveIn(SourceSpec):
    database_url: str | None = Field(default=None, max_length=2048)


class ConnectionOut(BaseModel):
    ok: bool
    driver: str
    host: str | None
    database: str | None
    server_version: str | None = None


class ColumnInfo(BaseModel):
    name: str
    type: str
    nullable: bool


class RelationInfo(BaseModel):
    """A table linked to this one by a foreign key, in either direction."""

    table: str
    schema_: str | None = Field(serialization_alias="schema")
    base_column: str
    related_column: str
    # one: at most one related row per row here (e.g. settings); many: any number.
    cardinality: Literal["one", "many"]


class TableInfo(BaseModel):
    schema_: str | None = Field(serialization_alias="schema")
    name: str
    kind: Literal["table", "view"]
    row_estimate: int | None
    columns: list[ColumnInfo]
    relations: list[RelationInfo] = Field(default_factory=list)
    suggested: dict[str, str]


class IntrospectOut(BaseModel):
    connection: ConnectionOut
    tables: list[TableInfo]


class PreviewOut(BaseModel):
    rows: list[dict]
    total: int
    warnings: list[str]


class SourceOut(BaseModel):
    model_config = ConfigDict(serialize_by_alias=True)

    kind: Literal["none", "database"]
    driver: str | None = None
    host: str | None = None
    database: str | None = None
    db_schema: str | None = Field(default=None, serialization_alias="schema")
    table: str | None = None
    column_map: dict = Field(default_factory=dict)
    filters: list = Field(default_factory=list)
    joins: list = Field(default_factory=list)
    status: str | None = None
    last_error: str | None = None
    last_checked_at: datetime | None = None
    cached_count: int | None = None
    cached_count_at: datetime | None = None


class SubscriberCounts(BaseModel):
    """Who a bot can reach. Counted live from its database, minus suppressions."""

    active: int = 0
    # Who can't be reached, from the bot's own records (when mapped) and Orbit's sends.
    blocked: int = 0  # blocked the bot
    left: int = 0  # the bot was removed from a group or channel
    deleted: int = 0  # the Telegram account was deleted
    unreachable: int = 0  # Telegram says the chat doesn't exist (or another reason)
    connected: bool = False  # False: the bot has no database connected yet
    # Set when the bot's database couldn't be read; `active` is then the last cached count.
    source_error: str | None = None

    @computed_field
    @property
    def total(self) -> int:
        return self.active + self.blocked + self.left + self.deleted + self.unreachable
