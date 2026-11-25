import logging

from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.security import hash_password
from app.modules.auth.models import AdminUser

log = logging.getLogger(__name__)


async def create_admin(
    email: str, password: str, name: str = "", org_name: str | None = None
) -> AdminUser:
    """Create an account and make it an owner: of `org_name` (new), or of the first organization."""
    from app.modules.orgs.models import Membership, Organization, Role

    async with SessionLocal() as session:
        user = AdminUser(
            email=email.strip().lower(), name=name, password_hash=hash_password(password)
        )
        session.add(user)
        await session.flush()
        org = None
        if org_name is None:
            org = await session.scalar(select(Organization).order_by(Organization.id).limit(1))
        if org is None:
            org = Organization(name=org_name or "My organization")
            session.add(org)
            await session.flush()
        session.add(Membership(org_id=org.id, user_id=user.id, role=Role.OWNER))
        await session.commit()
        return user


async def bootstrap_admin() -> None:
    """Create the first operator (and organization) from env vars when none exists."""
    settings = get_settings()
    if not (settings.bootstrap_admin_email and settings.bootstrap_admin_password):
        return
    async with SessionLocal() as session:
        if await session.scalar(select(func.count()).select_from(AdminUser)):
            return
    await create_admin(settings.bootstrap_admin_email, settings.bootstrap_admin_password, "Admin")
    log.info("Created bootstrap admin %s", settings.bootstrap_admin_email)
