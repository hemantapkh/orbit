import time
from collections import defaultdict, deque

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.deps import SessionDep
from app.core.security import create_session_token, hash_password, verify_password
from app.modules.auth.deps import SESSION_COOKIE, CurrentAdmin
from app.modules.auth.models import AdminUser

router = APIRouter(prefix="/auth", tags=["auth"])

# Brute-force guard: at most 5 failed sign-ins per email and per IP in 15 minutes.
LOGIN_WINDOW = 15 * 60
LOGIN_MAX_FAILURES = 5
_failures: dict[str, deque[float]] = defaultdict(deque)


def _too_many(*keys: str) -> bool:
    now = time.monotonic()
    for k in keys:
        q = _failures[k]
        while q and now - q[0] > LOGIN_WINDOW:
            q.popleft()
        if len(q) >= LOGIN_MAX_FAILURES:
            return True
    return False


def _fail(*keys: str) -> None:
    now = time.monotonic()
    for k in keys:
        _failures[k].append(now)


class LoginIn(BaseModel):
    email: str = Field(max_length=255)
    password: str = Field(max_length=255)


class OrgMembership(BaseModel):
    id: int
    name: str
    role: str


class AdminOut(BaseModel):
    id: int
    email: str
    name: str
    orgs: list[OrgMembership] = []


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=255)
    new_password: str = Field(min_length=10, max_length=255)


class ProfileIn(BaseModel):
    name: str = Field(max_length=120)


def set_session_cookie(response: Response, user_id: int) -> None:
    settings = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        create_session_token(user_id),
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


async def _out(session, user: AdminUser) -> AdminOut:
    from app.modules.orgs.models import Membership, Organization

    rows = await session.execute(
        select(Organization.id, Organization.name, Membership.role)
        .join(Membership, Membership.org_id == Organization.id)
        .where(Membership.user_id == user.id)
        .order_by(Organization.name)
    )
    return AdminOut(
        id=user.id,
        email=user.email,
        name=user.name,
        orgs=[OrgMembership(id=i, name=n, role=r) for i, n, r in rows],
    )


@router.post("/login", response_model=AdminOut)
async def login(body: LoginIn, request: Request, response: Response, session: SessionDep):
    email = body.email.strip().lower()
    keys = (f"email:{email}", f"ip:{request.client.host if request.client else '?'}")
    if _too_many(*keys):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, "Too many failed sign-ins. Try again in 15 minutes."
        )
    user = await session.scalar(select(AdminUser).where(func.lower(AdminUser.email) == email))
    if user is None or not user.is_active or not verify_password(body.password, user.password_hash):
        _fail(*keys)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    set_session_cookie(response, user.id)
    return await _out(session, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/me", response_model=AdminOut)
async def me(admin: CurrentAdmin, session: SessionDep):
    return await _out(session, admin)


@router.patch("/me", response_model=AdminOut)
async def update_me(body: ProfileIn, admin: CurrentAdmin, session: SessionDep):
    admin.name = body.name.strip()
    await session.commit()
    return await _out(session, admin)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(body: PasswordIn, admin: CurrentAdmin, session: SessionDep):
    if not verify_password(body.current_password, admin.password_hash):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Your current password is wrong")
    admin.password_hash = hash_password(body.new_password)
    await session.commit()
