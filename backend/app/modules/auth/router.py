from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.deps import SessionDep
from app.core.security import create_session_token, verify_password
from app.modules.auth.deps import SESSION_COOKIE, CurrentAdmin
from app.modules.auth.models import AdminUser

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str = Field(max_length=255)
    password: str = Field(max_length=255)


class AdminOut(BaseModel):
    id: int
    email: str
    name: str


@router.post("/login", response_model=AdminOut)
async def login(body: LoginIn, response: Response, session: SessionDep):
    user = await session.scalar(
        select(AdminUser).where(func.lower(AdminUser.email) == body.email.strip().lower())
    )
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        create_session_token(user.id),
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return AdminOut(id=user.id, email=user.email, name=user.name)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/me", response_model=AdminOut)
async def me(admin: CurrentAdmin):
    return AdminOut(id=admin.id, email=admin.email, name=admin.name)
