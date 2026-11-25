from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FilterOp = Literal["eq", "neq", "is_null", "not_null", "is_true", "is_false"]
MAPPED_FIELDS = (
    "chat_id",
    "username",
    "first_name",
    "last_name",
    "language_code",
    "joined_at",
    "is_active",
)


class ColumnMap(BaseModel):
    chat_id: str = Field(min_length=1, max_length=128)
    username: str | None = Field(default=None, max_length=128)
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    language_code: str | None = Field(default=None, max_length=128)
    joined_at: str | None = Field(default=None, max_length=128)
    is_active: str | None = Field(default=None, max_length=128)

    def mapped(self) -> dict[str, str]:
        return {k: v for k, v in self.model_dump().items() if v}


class SourceFilter(BaseModel):
    column: str = Field(min_length=1, max_length=128)
    op: FilterOp
    value: str | int | float | bool | None = None


class SourceSpec(BaseModel):
    """Which rows of which table are this bot's subscribers."""

    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    table: str = Field(min_length=1, max_length=128)
    db_schema: str | None = Field(default=None, alias="schema", max_length=128)
    column_map: ColumnMap
    filters: list[SourceFilter] = Field(default_factory=list, max_length=20)


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


class TableInfo(BaseModel):
    schema_: str | None = Field(serialization_alias="schema")
    name: str
    kind: Literal["table", "view"]
    row_estimate: int | None
    columns: list[ColumnInfo]
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

    kind: Literal["integration", "database"]
    driver: str | None = None
    host: str | None = None
    database: str | None = None
    db_schema: str | None = Field(default=None, serialization_alias="schema")
    table: str | None = None
    column_map: dict = Field(default_factory=dict)
    filters: list = Field(default_factory=list)
    status: str | None = None
    last_error: str | None = None
    last_checked_at: datetime | None = None
    cached_count: int | None = None
    cached_count_at: datetime | None = None
