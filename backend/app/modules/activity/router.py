from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.core.deps import SessionDep
from app.modules.activity.models import ActivityLog
from app.modules.auth.deps import CurrentAdmin

router = APIRouter(prefix="/activity", tags=["activity"])


class ActivityOut(BaseModel):
    id: int
    actor_email: str | None
    action: str
    entity_type: str
    entity_id: int | None
    details: dict
    created_at: datetime


@router.get("", response_model=list[ActivityOut])
async def list_activity(
    session: SessionDep,
    _: CurrentAdmin,
    entity_type: Literal["bot", "campaign"] | None = None,
    entity_id: int | None = None,
    limit: int = Query(default=50, ge=1, le=200),
):
    stmt = select(ActivityLog).order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc())
    if entity_type:
        stmt = stmt.where(ActivityLog.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(ActivityLog.entity_id == entity_id)
    rows = (await session.scalars(stmt.limit(limit))).all()
    return [
        ActivityOut(
            id=r.id,
            actor_email=r.actor_email,
            action=r.action,
            entity_type=r.entity_type,
            entity_id=r.entity_id,
            details=r.details or {},
            created_at=r.created_at,
        )
        for r in rows
    ]
