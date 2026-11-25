import asyncio
import uuid
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.integrations.telegram.client import MediaRef
from app.modules.media.models import MediaAsset, MediaBotFile


def storage_path(storage_key: str) -> Path:
    return get_settings().media_dir / storage_key


def new_storage_key(filename: str) -> str:
    return uuid.uuid4().hex + Path(filename).suffix.lower()[:10]


def infer_kind(content_type: str) -> str:
    if content_type == "image/gif":
        return "animation"
    if content_type in ("image/jpeg", "image/png", "image/webp"):
        return "photo"
    if content_type.startswith("video/"):
        return "video"
    return "document"


async def media_ref_for_bot(session: AsyncSession, asset: MediaAsset, bot_id: int) -> MediaRef:
    """Reuse this bot's cached file_id when we have one; otherwise upload the bytes."""
    cached = await session.get(MediaBotFile, (asset.id, bot_id))
    if cached:
        return MediaRef(kind=asset.kind, file_id=cached.file_id)  # type: ignore[arg-type]
    data = await asyncio.to_thread(storage_path(asset.storage_key).read_bytes)
    return MediaRef(kind=asset.kind, upload=(asset.filename, data, asset.content_type))  # type: ignore[arg-type]


async def remember_file_id(session: AsyncSession, media_id: int, bot_id: int, file_id: str) -> None:
    if await session.get(MediaBotFile, (media_id, bot_id)) is None:
        session.add(MediaBotFile(media_id=media_id, bot_id=bot_id, file_id=file_id))
        await session.commit()
