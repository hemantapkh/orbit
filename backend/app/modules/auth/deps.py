from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from app.core.deps import SessionDep
from app.core.security import decode_session_token
from app.modules.auth.models import AdminUser

SESSION_COOKIE = "orbit_session"


async def current_admin(request: Request, session: SessionDep) -> AdminUser:
    token = request.cookies.get(SESSION_COOKIE)
    user_id = decode_session_token(token) if token else None
    user = await session.get(AdminUser, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in")
    return user


CurrentAdmin = Annotated[AdminUser, Depends(current_admin)]
