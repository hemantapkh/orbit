"""Platform-wide message model. Any module that sends to Telegram (campaigns now,
automations later) composes a MessageContent rather than raw Bot API payloads."""

from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

MediaKind = Literal["photo", "video", "document", "animation"]

TEXT_LIMIT = 4096
CAPTION_LIMIT = 1024


class MessageButton(BaseModel):
    text: str = Field(min_length=1, max_length=64)
    url: str = Field(pattern=r"^(https?|tg)://", max_length=512)


class MessageContent(BaseModel):
    text: str = Field(default="", max_length=TEXT_LIMIT)
    parse_mode: Literal["HTML", "MarkdownV2"] | None = "HTML"
    media_id: int | None = None
    buttons: list[MessageButton] = Field(default_factory=list, max_length=10)
    disable_link_preview: bool = False
    silent: bool = False
    protect_content: bool = False

    @model_validator(mode="after")
    def _caption_limit(self) -> Self:
        if self.media_id is not None and len(self.text) > CAPTION_LIMIT:
            raise ValueError(f"Captions on media are limited to {CAPTION_LIMIT} characters")
        return self

    @property
    def is_empty(self) -> bool:
        return not self.text.strip() and self.media_id is None
