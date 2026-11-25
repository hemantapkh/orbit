from fastapi import APIRouter, HTTPException, Query, status

from app.core.deps import SessionDep
from app.modules.analytics import service
from app.modules.analytics.schemas import (
    AudienceAnalytics,
    Breakdown,
    BroadcastAnalytics,
    ColumnChoice,
    Range,
)
from app.modules.auth.deps import CurrentAdmin
from app.modules.sources.connection import safe_error

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


@router.get("/broadcasts", response_model=BroadcastAnalytics)
async def broadcasts(
    session: SessionDep,
    _: CurrentAdmin,
    range_: Range = Query(default="30d", alias="range"),
    bot_ids: list[int] | None = Query(default=None, alias="bot"),
):
    """Delivery and block rate of every broadcast that started in the period."""
    return await service.broadcasts(session, range_, bot_ids or None)


@router.get("/columns", response_model=list[ColumnChoice])
async def columns(session: SessionDep, _: CurrentAdmin, bot_id: int = Query(alias="bot")):
    """Columns a bot's people can be broken down by: its main table and linked tables."""
    try:
        return await service.columns(session, bot_id)
    except Exception as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, safe_error(exc)) from exc


@router.get("/breakdown", response_model=Breakdown)
async def breakdown(
    session: SessionDep,
    _: CurrentAdmin,
    bot_id: int = Query(alias="bot"),
    column: str = Query(min_length=1, max_length=260),
):
    """How a bot's reachable people split by the values of one column."""
    try:
        return await service.breakdown(session, bot_id, column)
    except Exception as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, safe_error(exc)) from exc
