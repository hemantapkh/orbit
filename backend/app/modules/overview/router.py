"""Cross-bot snapshot for the home screen. Grows as modules are added."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from app.core.config import get_settings
from app.core.deps import SessionDep
from app.modules.bots.models import Bot
from app.modules.campaigns import service as campaigns
from app.modules.campaigns.models import Campaign
from app.modules.campaigns.schemas import DeliveryStats
from app.modules.orgs.deps import Viewer
from app.modules.overview.service import recent_activity
from app.modules.sources.service import (
    cached_ids,
    counts_by_bot,
    database_sources,
    live_ids,
    spec_of,
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
    refreshed_at: datetime | None = None
    refreshing: bool = False
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
    recent_campaigns: list[RecentCampaign]


class BotRecent(BaseModel):
    """One bot's last 24 hours, read from its database (None: the field isn't mapped)."""

    joined_24h: int | None = None
    joined_prev_24h: int | None = None
    active_24h: int | None = None
    active_7d: int | None = None
    lost_24h: dict[str, int] | None = None
    error: str | None = None


class Reach(BaseModel):
    """Distinct people across all bots. `pending`: some bots haven't been read yet."""

    unique_people: int
    pending: bool


@router.get("", response_model=Overview)
async def overview(session: SessionDep, m: Viewer):
    """Everything from Orbit's own database, so it answers at once. Each bot's last
    24 hours and the people across bots load separately (see below)."""
    bots = (await session.scalars(select(Bot).where(Bot.org_id == m.org_id))).all()
    counts = await counts_by_bot(session, [b.id for b in bots])
    sources = await database_sources(session, [b.id for b in bots])
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
                maps_status=_maps_status(sources.get(b.id)),
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


def _maps_status(source) -> bool:
    if source is None:
        return False
    m = spec_of(source).column_map
    return bool(m.status or m.unreachable_reason)


@router.get("/bots/{bot_id}/recent", response_model=BotRecent)
async def bot_recent(bot_id: int, session: SessionDep, m: Viewer):
    """One bot's joins, activity and losses in the last 24 hours, from its own database.
    A slow or unreachable database only holds up this bot's numbers."""
    bot = await session.get(Bot, bot_id)
    if bot is None or bot.org_id != m.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bot not found")
    sources = await database_sources(session, [bot_id])
    if bot_id not in sources:
        return BotRecent()
    r = (await recent_activity(session, sources))[bot_id]
    return BotRecent(
        joined_24h=r.joined,
        joined_prev_24h=r.joined_before,
        active_24h=r.active,
        active_7d=r.active_week,
        lost_24h=r.lost,
        error=r.error,
    )


@router.get("/reach", response_model=Reach)
async def reach(session: SessionDep, m: Viewer):
    """Distinct people across the org's bots, from each bot's last read. Never waits on a
    bot's database: bots not read yet are fetched in the background (`pending`)."""
    bot_ids = (await session.scalars(select(Bot.id).where(Bot.org_id == m.org_id))).all()
    people: set[int] = set()
    pending = False
    inline = get_settings().audience_refresh_inline
    for source in (await database_sources(session, list(bot_ids))).values():
        ids = await live_ids(session, source) if inline else cached_ids(source)
        if ids is None:
            pending = True
        else:
            people |= ids
    return Reach(unique_people=len(people), pending=pending)
