from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.activity.models import ActivityLog
from app.modules.auth.models import AdminUser


def record(
    session: AsyncSession,
    actor: AdminUser | None,
    action: str,
    entity_type: str,
    entity_id: int | None,
    **details,
) -> None:
    """Add a log entry to the session; it's saved with the caller's commit."""
    session.add(
        ActivityLog(
            actor_id=actor.id if actor else None,
            actor_email=actor.email if actor else None,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
        )
    )
