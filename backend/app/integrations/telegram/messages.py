"""Platform-wide message model. Any module that sends to Telegram (campaigns now,
automations later) composes a MessageContent rather than raw Bot API payloads."""

import html
import re
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


# ---- personalization ------------------------------------------------------------------
# {first_name}, {last_name}, {full_name}, {username}, each with an optional fallback:
# "Hi {first_name|there}!" -> "Hi Ana!" or "Hi there!".

FIELDS = ("first_name", "last_name", "full_name", "username")
PLACEHOLDER = re.compile(r"\{(" + "|".join(FIELDS) + r")(?:\|([^{}\n]{0,60}))?\}")
_MD_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!|~>])")
_MDV2_SPECIAL = re.compile(r"([_*\[\]()~`>#+\-=|{}.!\\])")


def uses_placeholders(text: str) -> bool:
    return bool(PLACEHOLDER.search(text or ""))


def _escape(value: str, parse_mode: str | None) -> str:
    """A person's name must never be able to change the message's formatting."""
    if parse_mode == "HTML":
        return html.escape(value, quote=False)
    if parse_mode == "Markdown":
        return _MD_SPECIAL.sub(r"\\\1", value)
    if parse_mode == "MarkdownV2":
        return _MDV2_SPECIAL.sub(r"\\\1", value)
    return value


def personalize(content: MessageContent, person: dict | None) -> MessageContent:
    """Fill placeholders for one recipient. Missing values use the fallback, else nothing."""
    if not uses_placeholders(content.text):
        return content
    p = {k: (str(v).strip() if v is not None else "") for k, v in (person or {}).items()}
    p["full_name"] = " ".join(x for x in (p.get("first_name"), p.get("last_name")) if x)

    def fill(m: re.Match) -> str:
        value = p.get(m.group(1), "")
        if value:
            return _escape(value, content.parse_mode)
        return m.group(2) or ""  # the fallback is the author's own text: used as written

    return content.model_copy(update={"text": PLACEHOLDER.sub(fill, content.text)})
