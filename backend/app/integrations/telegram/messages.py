"""Platform-wide message model. Any module that sends to Telegram (campaigns now,
automations later) composes a MessageContent rather than raw Bot API payloads."""

from typing import Literal, Self

import telegramify_markdown
from pydantic import BaseModel, Field, model_validator
from telegramify_markdown.config import get_runtime_config

MediaKind = Literal["photo", "video", "document", "animation"]

# Our own config (not the library's global one): headings stay plain bold, no emoji.
_MD_CONFIG = get_runtime_config().isolated()
for _level in range(1, 7):
    setattr(_MD_CONFIG.markdown_symbol, f"heading_level_{_level}", "")

TEXT_LIMIT = 4096
CAPTION_LIMIT = 1024


class MessageButton(BaseModel):
    text: str = Field(min_length=1, max_length=64)
    url: str = Field(pattern=r"^(https?|tg)://", max_length=512)


class MessageContent(BaseModel):
    text: str = Field(default="", max_length=TEXT_LIMIT)
    # "Markdown" is standard Markdown, converted to Telegram MarkdownV2 by
    # telegramify-markdown when sent. The other two go to Telegram as-is.
    parse_mode: Literal["Markdown", "HTML", "MarkdownV2"] | None = "Markdown"
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

    def rendered(self) -> tuple[str, str | None]:
        """(text, parse_mode) exactly as Telegram should receive them."""
        if self.parse_mode == "Markdown":
            return telegramify_markdown.markdownify(
                self.text, config=_MD_CONFIG
            ).rstrip(), "MarkdownV2"
        return self.text, self.parse_mode

    @property
    def is_empty(self) -> bool:
        return not self.text.strip() and self.media_id is None
