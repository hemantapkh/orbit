from fastapi import APIRouter, Query

from app.core.deps import SessionDep
from app.modules.analytics import service
from app.modules.analytics.schemas import AudienceAnalytics, Range
from app.modules.auth.deps import CurrentAdmin

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/audience", response_model=AudienceAnalytics)
async def audience(
    session: SessionDep,
    _: CurrentAdmin,
    range_: Range = Query(default="30d", alias="range"),
    bot_ids: list[int] | None = Query(default=None, alias="bot"),
):
    """People across bots: growth, overlap, languages and blocks over a time range."""
    return await service.audience(session, range_, bot_ids or None)
