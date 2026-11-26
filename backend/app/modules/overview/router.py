"""Cross-bot snapshot for the home screen. Grows as modules are added."""

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from app.core.deps import SessionDep
from app.modules.bots.models import Bot
from app.modules.campaigns import service as campaigns
from app.modules.campaigns.models import Campaign
from app.modules.campaigns.schemas import DeliveryStats
from app.modules.orgs.deps import Viewer
from app.modules.overview.service import recent_activity
from app.modules.sources.service import (
    counts_by_bot,
    database_sources,
    spec_of,
    unique_active_people,
)

router = APIRouter(prefix="/overview", tags=["overview"])


class BotLine(BaseModel):
    id: int
    username: str
    display_name: str
    is_active: bool
    token_valid: bool
    avatar_version: str | None
    active: int
    blocked: int
    left: int
    deleted: int
    unreachable: int
    total: int
    connected: bool
    source_error: str | None
    # Last 24 hours (None: the field it needs isn't mapped).
    joined_24h: int | None = None
    joined_prev_24h: int | None = None
    active_24h: int | None = None
    active_7d: int | None = None
    lost_24h: dict[str, int] | None = None
    # Mapping gaps worth pointing out.
    maps_status: bool = False  # status or unreachable reason: blocks show up without sending


class RecentCampaign(BaseModel):
    id: int
    name: str
    status: str
    scheduled_at: datetime | None
    started_at: datetime | None
    finished_at: datetime | None
    stats: DeliveryStats


class Overview(BaseModel):
    bots: list[BotLine]
    total_bots: int
    total_active_subscribers: int
    unique_people: int
    recent_campaigns: list[RecentCampaign]


@router.get("", response_model=Overview)
async def overview(session: SessionDep, m: Viewer):
    bots = (await session.scalars(select(Bot).where(Bot.org_id == m.org_id))).all()
    counts = await counts_by_bot(session, [b.id for b in bots])
    sources = await database_sources(session, [b.id for b in bots])
    recent = await recent_activity(session, sources)
    lines = sorted(
        (
            BotLine(
                id=b.id,
                username=b.username,
                display_name=b.display_name,
                is_active=b.is_active,
                token_valid=b.token_valid,
                avatar_version=b.avatar_version,
                **counts[b.id].model_dump(),
                **_recent_fields(b.id, recent, sources),
            )
            for b in bots
        ),
        key=lambda line: line.active,
        reverse=True,
    )
    campaigns_recent = (
        await session.scalars(
            select(Campaign)
            .where(Campaign.org_id == m.org_id)
            .order_by(Campaign.created_at.desc())
            .limit(6)
        )
    ).all()
    stats = await campaigns.delivery_stats(session, [c.id for c in campaigns_recent])
    return Overview(
        bots=lines,
        total_bots=len(bots),
        total_active_subscribers=sum(line.active for line in lines),
        unique_people=await unique_active_people(session, [b.id for b in bots]),
        recent_campaigns=[
            RecentCampaign(
                id=c.id,
                name=c.name,
                status=c.status,
                scheduled_at=c.scheduled_at,
                started_at=c.started_at,
                finished_at=c.finished_at,
                stats=stats[c.id],
            )
            for c in campaigns_recent
        ],
    )


def _recent_fields(bot_id: int, recent, sources) -> dict:
    if bot_id not in sources:
        return {}
    r = recent[bot_id]
    m = spec_of(sources[bot_id]).column_map
    return {
        "joined_24h": r.joined,
        "joined_prev_24h": r.joined_before,
        "active_24h": r.active,
        "active_7d": r.active_week,
        "lost_24h": r.lost,
        "maps_status": bool(m.status or m.unreachable_reason),
    }
