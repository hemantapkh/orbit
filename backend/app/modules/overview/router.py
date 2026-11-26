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
from app.modules.sources.service import counts_by_bot, unique_active_people

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
            )
            for b in bots
        ),
        key=lambda line: line.active,
        reverse=True,
    )
    recent = (
        await session.scalars(
            select(Campaign)
            .where(Campaign.org_id == m.org_id)
            .order_by(Campaign.created_at.desc())
            .limit(6)
        )
    ).all()
    stats = await campaigns.delivery_stats(session, [c.id for c in recent])
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
            for c in recent
        ],
    )
