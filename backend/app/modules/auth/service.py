import logging

from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.security import hash_password
from app.modules.auth.models import AdminUser

log = logging.getLogger(__name__)


async def create_admin(email: str, password: str, name: str = "") -> AdminUser:
    async with SessionLocal() as session:
        user = AdminUser(
            email=email.strip().lower(), name=name, password_hash=hash_password(password)
        )
        session.add(user)
        await session.commit()
        return user


async def bootstrap_admin() -> None:
    """Create the first operator from env vars when the platform has none."""
    settings = get_settings()
    if not (settings.bootstrap_admin_email and settings.bootstrap_admin_password):
        return
    async with SessionLocal() as session:
        if await session.scalar(select(func.count()).select_from(AdminUser)):
            return
    await create_admin(settings.bootstrap_admin_email, settings.bootstrap_admin_password, "Admin")
    log.info("Created bootstrap admin %s", settings.bootstrap_admin_email)
