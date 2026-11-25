import json
from dataclasses import dataclass
from typing import Any

import httpx

from app.integrations.telegram.messages import MediaKind, MessageContent

_MEDIA_METHOD: dict[str, tuple[str, str]] = {
    "photo": ("sendPhoto", "photo"),
    "video": ("sendVideo", "video"),
    "document": ("sendDocument", "document"),
    "animation": ("sendAnimation", "animation"),
}


class TelegramError(Exception):
    def __init__(self, error_code: int, description: str, retry_after: float | None = None):
        super().__init__(f"{error_code}: {description}")
        self.error_code = error_code
        self.description = description
        self.retry_after = retry_after


@dataclass(slots=True)
class MediaRef:
    kind: MediaKind
    file_id: str | None = None  # reuse a file already uploaded to this bot
    upload: tuple[str, bytes, str] | None = None  # (filename, content, content_type)


@dataclass(slots=True)
class SentMessage:
    message_id: int
    file_id: str | None = None


class TelegramClient:
    def __init__(self, http: httpx.AsyncClient, api_base: str = "https://api.telegram.org"):
        self._http = http
        self._base = api_base.rstrip("/")

    async def call(
        self,
        token: str,
        method: str,
        params: dict[str, Any] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> Any:
        url = f"{self._base}/bot{token}/{method}"
        try:
            if files:
                form = {
                    k: v if isinstance(v, str) else json.dumps(v) for k, v in (params or {}).items()
                }
                resp = await self._http.post(url, data=form, files=files)
            else:
                resp = await self._http.post(url, json=params or {})
        except httpx.HTTPError as exc:
            raise TelegramError(0, f"network error: {exc.__class__.__name__}") from exc

        try:
            body = resp.json()
        except ValueError as exc:
            raise TelegramError(resp.status_code, "invalid response from Telegram") from exc
        if not body.get("ok"):
            params_ = body.get("parameters") or {}
            raise TelegramError(
                body.get("error_code", resp.status_code),
                body.get("description", "unknown error"),
                retry_after=params_.get("retry_after"),
            )
        return body["result"]

    async def get_me(self, token: str) -> dict[str, Any]:
        return await self.call(token, "getMe")

    async def send(
        self, token: str, chat_id: int, content: MessageContent, media: MediaRef | None = None
    ) -> SentMessage:
        text, parse_mode = content.rendered()
        params: dict[str, Any] = {"chat_id": chat_id}
        if parse_mode:
            params["parse_mode"] = parse_mode
        if content.silent:
            params["disable_notification"] = True
        if content.protect_content:
            params["protect_content"] = True
        if content.buttons:
            params["reply_markup"] = {
                "inline_keyboard": [[{"text": b.text, "url": b.url}] for b in content.buttons]
            }

        if media is None:
            params["text"] = text
            if content.disable_link_preview:
                params["link_preview_options"] = {"is_disabled": True}
            result = await self.call(token, "sendMessage", params)
            return SentMessage(message_id=result["message_id"])

        method, field = _MEDIA_METHOD[media.kind]
        if text:
            params["caption"] = text
        files = None
        if media.file_id:
            params[field] = media.file_id
        elif media.upload:
            files = {field: media.upload}
        else:
            raise ValueError("MediaRef needs a file_id or an upload")
        result = await self.call(token, method, params, files)
        return SentMessage(message_id=result["message_id"], file_id=_extract_file_id(result, field))


def _extract_file_id(message: dict[str, Any], field: str) -> str | None:
    value = message.get(field)
    if field == "photo" and isinstance(value, list) and value:
        return value[-1].get("file_id")
    if isinstance(value, dict):
        return value.get("file_id")
    # Telegram sometimes files GIFs under "document"
    doc = message.get("document")
    return doc.get("file_id") if isinstance(doc, dict) else None
