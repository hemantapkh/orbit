"""Read-only public view of a shared broadcast: /share/<token> in the console.

No session needed; the unguessable token is the credential. Only aggregate, non-personal
fields are returned: never chat IDs, names, recipient lists, operators or activity."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.core.config import get_settings
from app.core.deps import SessionDep
from app.integrations.telegram.messages import MessageContent
from app.modules.campaigns import service
from app.modules.campaigns.models import Campaign
from app.modules.campaigns.schemas import Audience, DeliveryStats, ProgressOut
from app.modules.media.models import MediaAsset
from app.modules.media.service import storage_path

router = APIRouter(prefix="/public/shares", tags=["public"])

PRIVATE_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
}
_NOT_FOUND = "This link doesn't exist or is no longer shared"


class PublicBot(BaseModel):
    bot_id: int
    username: str
    display_name: str
    audience: int
    stats: DeliveryStats


class PublicMedia(BaseModel):
    kind: str
    filename: str
    size_bytes: int


class PublicBroadcast(BaseModel):
    name: str
    status: str
    audience_mode: str
    reach: int  # people it was (or will be) sent to; a count only
    scheduled_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    stats: DeliveryStats
    bots: list[PublicBot]
    message: MessageContent | None  # None when the owner hid it
    media: PublicMedia | None
    progress: ProgressOut


async def _shared(session, token: str) -> Campaign:
    c = await session.scalar(select(Campaign).where(Campaign.share_token == token))
    if c is None or len(token) < 20:
        raise HTTPException(404, _NOT_FOUND, headers=PRIVATE_HEADERS)
    return c


@router.get("/{token}", response_model=PublicBroadcast)
async def shared_broadcast(token: str, session: SessionDep, response: Response):
    c = await _shared(session, token)
    response.headers.update(PRIVATE_HEADERS)
    d = await service.detail(session, c)
    audience = Audience.model_validate(c.audience or {})
    reach = (
        len(audience.recipients)
        if audience.mode == "selected"
        else (d.stats.total or sum(b.audience for b in d.bots))
    )
    message = None if c.share_hide_message else d.message
    media = None
    if message and message.media_id and (asset := await session.get(MediaAsset, message.media_id)):
        media = PublicMedia(kind=asset.kind, filename=asset.filename, size_bytes=asset.size_bytes)
    progress = await service.progress(session, c, get_settings().send_rate_per_bot)
    return PublicBroadcast(
        name=c.name,
        status=c.status,
        audience_mode=audience.mode,
        reach=reach,
        scheduled_at=c.scheduled_at,
        started_at=c.started_at,
        finished_at=c.finished_at,
        stats=d.stats,
        bots=[
            PublicBot(
                bot_id=b.bot_id,
                username=b.username,
                display_name=b.display_name,
                audience=b.audience,
                stats=b.stats,
            )
            for b in d.bots
        ],
        message=message.model_copy(update={"media_id": None}) if message else None,
        media=media,
        progress=progress,
    )


@router.get("/{token}/media")
async def shared_media(token: str, session: SessionDep):
    c = await _shared(session, token)
    media_id = (c.message or {}).get("media_id")
    asset = (
        await session.get(MediaAsset, media_id) if media_id and not c.share_hide_message else None
    )
    if asset is None or not storage_path(asset.storage_key).exists():
        raise HTTPException(404, "No media", headers=PRIVATE_HEADERS)
    return FileResponse(
        storage_path(asset.storage_key), media_type=asset.content_type, headers=PRIVATE_HEADERS
    )
