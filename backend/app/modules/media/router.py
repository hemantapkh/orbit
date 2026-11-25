from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.deps import SessionDep
from app.modules.media.models import MediaAsset
from app.modules.media.service import infer_kind, new_storage_key, storage_path
from app.modules.orgs.deps import Sender, Viewer, get_in_org

router = APIRouter(prefix="/media", tags=["media"])

_CHUNK = 1024 * 1024


class MediaOut(BaseModel):
    id: int
    kind: str
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime


def to_out(a: MediaAsset) -> MediaOut:
    return MediaOut(
        id=a.id,
        kind=a.kind,
        filename=a.filename,
        content_type=a.content_type,
        size_bytes=a.size_bytes,
        created_at=a.created_at,
    )


@router.post("", response_model=MediaOut, status_code=status.HTTP_201_CREATED)
async def upload_media(
    session: SessionDep,
    m: Sender,
    file: UploadFile,
    kind: Literal["photo", "video", "document", "animation"] | None = Form(default=None),
):
    settings = get_settings()
    limit = settings.max_upload_mb * _CHUNK
    content_type = file.content_type or "application/octet-stream"
    filename = (file.filename or "upload").rsplit("/", 1)[-1][:255]
    key = new_storage_key(filename)
    path = storage_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)

    size = 0
    with path.open("wb") as out:
        while chunk := await file.read(_CHUNK):
            size += len(chunk)
            if size > limit:
                out.close()
                path.unlink(missing_ok=True)
                raise HTTPException(
                    status.HTTP_413_CONTENT_TOO_LARGE,
                    f"Files are limited to {settings.max_upload_mb} MB",
                )
            out.write(chunk)

    asset = MediaAsset(
        org_id=m.org_id,
        kind=kind or infer_kind(content_type),
        filename=filename,
        content_type=content_type,
        size_bytes=size,
        storage_key=key,
    )
    session.add(asset)
    await session.commit()
    return to_out(asset)


@router.get("/{media_id}", response_model=MediaOut)
async def get_media(media_id: int, session: SessionDep, m: Viewer):
    asset = await get_in_org(session, MediaAsset, media_id, m.org_id, "Media")
    return to_out(asset)


@router.get("/{media_id}/file")
async def media_file(media_id: int, session: SessionDep, m: Viewer):
    asset = await get_in_org(session, MediaAsset, media_id, m.org_id, "Media")
    if not storage_path(asset.storage_key).exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    return FileResponse(
        storage_path(asset.storage_key), media_type=asset.content_type, filename=asset.filename
    )
