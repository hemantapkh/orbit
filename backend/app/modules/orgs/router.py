import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.db import utcnow
from app.core.deps import SessionDep
from app.core.security import decode_session_token, hash_password
from app.modules.activity.service import record
from app.modules.auth.deps import SESSION_COOKIE, CurrentAdmin
from app.modules.auth.models import AdminUser
from app.modules.auth.router import set_session_cookie
from app.modules.orgs.deps import Admin, Member, Owner, Viewer
from app.modules.orgs.models import Invite, Membership, Organization, Role

router = APIRouter(prefix="/orgs", tags=["organizations"])
public = APIRouter(prefix="/invites", tags=["invites"])

INVITE_DAYS = 7
_422 = status.HTTP_422_UNPROCESSABLE_CONTENT


class OrgOut(BaseModel):
    id: int
    name: str
    role: Role


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class MemberOut(BaseModel):
    user_id: int
    email: str
    name: str
    role: Role
    joined_at: datetime


class RoleIn(BaseModel):
    role: Role


class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=255, pattern=r"^[^@\s]+@[^@\s]+$")
    role: Role = Role.SENDER


class InviteOut(BaseModel):
    id: int
    email: str
    role: Role
    expires_at: datetime
    token: str | None = None  # only right after creating it


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _owners(session, org_id: int) -> int:
    return await session.scalar(
        select(func.count()).where(Membership.org_id == org_id, Membership.role == Role.OWNER)
    )


async def add_owner_org(session, user: AdminUser, name: str) -> Organization:
    org = Organization(name=name.strip())
    session.add(org)
    await session.flush()
    session.add(Membership(org_id=org.id, user_id=user.id, role=Role.OWNER))
    return org


# ---- your organizations ------------------------------------------------------------------


@router.get("", response_model=list[OrgOut])
async def my_orgs(session: SessionDep, user: CurrentAdmin):
    rows = await session.execute(
        select(Organization, Membership.role)
        .join(Membership, Membership.org_id == Organization.id)
        .where(Membership.user_id == user.id)
        .order_by(Organization.name)
    )
    return [OrgOut(id=o.id, name=o.name, role=r) for o, r in rows]


@router.post("", response_model=OrgOut, status_code=status.HTTP_201_CREATED)
async def create_org(body: OrgIn, session: SessionDep, user: CurrentAdmin):
    """Anyone signed in can start a new organization; they become its owner."""
    org = await add_owner_org(session, user, body.name)
    record(session, user, "org.created", "org", org.id, org_id=org.id, name=org.name)
    await session.commit()
    return OrgOut(id=org.id, name=org.name, role=Role.OWNER)


@router.get("/current", response_model=OrgOut)
async def current_org(m: Viewer):
    return OrgOut(id=m.org_id, name=m.org_name, role=m.role)


@router.patch("/current", response_model=OrgOut)
async def rename_org(body: OrgIn, session: SessionDep, m: Owner):
    org = await session.get(Organization, m.org_id)
    org.name = body.name.strip()
    record(session, m.user, "org.renamed", "org", org.id, org_id=org.id, name=org.name)
    await session.commit()
    return OrgOut(id=org.id, name=org.name, role=m.role)


# ---- members -------------------------------------------------------------------------------


@router.get("/current/members", response_model=list[MemberOut])
async def members(session: SessionDep, m: Viewer):
    rows = await session.execute(
        select(Membership, AdminUser)
        .join(AdminUser, AdminUser.id == Membership.user_id)
        .where(Membership.org_id == m.org_id)
        .order_by(AdminUser.email)
    )
    return [
        MemberOut(user_id=u.id, email=u.email, name=u.name, role=ms.role, joined_at=ms.created_at)
        for ms, u in rows
    ]


async def _membership(session, m: Member, user_id: int) -> Membership:
    ms = await session.scalar(
        select(Membership).where(Membership.org_id == m.org_id, Membership.user_id == user_id)
    )
    if ms is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member of this organization")
    return ms


@router.patch("/current/members/{user_id}", response_model=list[MemberOut])
async def change_role(user_id: int, body: RoleIn, session: SessionDep, m: Admin):
    ms = await _membership(session, m, user_id)
    touches_owner = ms.role == Role.OWNER or body.role == Role.OWNER
    if touches_owner and m.role != Role.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can make or change owners")
    if ms.role == Role.OWNER and body.role != Role.OWNER and await _owners(session, m.org_id) == 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "An organization needs at least one owner")
    ms.role = body.role
    record(
        session,
        m.user,
        "member.role_changed",
        "org",
        m.org_id,
        org_id=m.org_id,
        user_id=user_id,
        role=body.role.value,
    )
    await session.commit()
    return await members(session, m)


@router.delete("/current/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(user_id: int, session: SessionDep, m: Viewer):
    """Admins remove people; anyone can remove themselves (leave)."""
    ms = await _membership(session, m, user_id)
    leaving = user_id == m.user.id
    if not leaving and not m.at_least(Role.ADMIN):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only admins can remove members")
    if ms.role == Role.OWNER and not leaving and m.role != Role.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can remove an owner")
    if ms.role == Role.OWNER and await _owners(session, m.org_id) == 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "An organization needs at least one owner")
    record(
        session,
        m.user,
        "member.left" if leaving else "member.removed",
        "org",
        m.org_id,
        org_id=m.org_id,
        user_id=user_id,
    )
    await session.delete(ms)
    await session.commit()


# ---- invites --------------------------------------------------------------------------------


@router.get("/current/invites", response_model=list[InviteOut])
async def pending_invites(session: SessionDep, m: Admin):
    rows = await session.scalars(
        select(Invite)
        .where(
            Invite.org_id == m.org_id, Invite.accepted_at.is_(None), Invite.expires_at > utcnow()
        )
        .order_by(Invite.created_at.desc())
    )
    return [InviteOut(id=i.id, email=i.email, role=i.role, expires_at=i.expires_at) for i in rows]


@router.post("/current/invites", response_model=InviteOut, status_code=status.HTTP_201_CREATED)
async def invite(body: InviteIn, session: SessionDep, m: Admin):
    if body.role == Role.OWNER and m.role != Role.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only owners can invite owners")
    email = body.email.strip().lower()
    already = await session.scalar(
        select(Membership.id)
        .join(AdminUser, AdminUser.id == Membership.user_id)
        .where(Membership.org_id == m.org_id, func.lower(AdminUser.email) == email)
    )
    if already:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{email} is already a member")
    token = secrets.token_urlsafe(32)
    inv = Invite(
        org_id=m.org_id,
        email=email,
        role=body.role,
        token_hash=_hash(token),
        created_by_id=m.user.id,
        expires_at=utcnow() + timedelta(days=INVITE_DAYS),
    )
    session.add(inv)
    await session.flush()
    record(
        session,
        m.user,
        "member.invited",
        "org",
        m.org_id,
        org_id=m.org_id,
        email=email,
        role=body.role.value,
    )
    await session.commit()
    return InviteOut(id=inv.id, email=email, role=inv.role, expires_at=inv.expires_at, token=token)


@router.delete("/current/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(invite_id: int, session: SessionDep, m: Admin):
    inv = await session.get(Invite, invite_id)
    if inv is None or inv.org_id != m.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invite not found")
    await session.delete(inv)
    await session.commit()


# ---- accepting (no sign-in needed to look) ----------------------------------------------------


class InvitePreview(BaseModel):
    org_name: str
    email: str
    role: Role
    expires_at: datetime
    has_account: bool


class AcceptIn(BaseModel):
    name: str = Field(default="", max_length=120)
    password: str | None = Field(default=None, min_length=10, max_length=255)


class Accepted(BaseModel):
    org_id: int


async def _valid_invite(session, token: str) -> tuple[Invite, Organization]:
    inv = await session.scalar(select(Invite).where(Invite.token_hash == _hash(token)))
    if inv is None or inv.accepted_at is not None or inv.expires_at <= utcnow():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "This invite link is invalid, used or expired"
        )
    return inv, await session.get(Organization, inv.org_id)


@public.get("/{token}", response_model=InvitePreview)
async def preview_invite(token: str, session: SessionDep):
    inv, org = await _valid_invite(session, token)
    has_account = bool(
        await session.scalar(select(AdminUser.id).where(func.lower(AdminUser.email) == inv.email))
    )
    return InvitePreview(
        org_name=org.name,
        email=inv.email,
        role=inv.role,
        expires_at=inv.expires_at,
        has_account=has_account,
    )


@public.post("/{token}/accept", response_model=Accepted)
async def accept_invite(
    token: str, body: AcceptIn, request: Request, response: Response, session: SessionDep
):
    """Signed in as the invited email: join. New email: create the account and join."""
    inv, org = await _valid_invite(session, token)
    existing = await session.scalar(
        select(AdminUser).where(func.lower(AdminUser.email) == inv.email)
    )
    session_user_id = decode_session_token(request.cookies.get(SESSION_COOKIE, "") or "")

    if existing:
        if session_user_id != existing.id:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED, f"Sign in as {inv.email} to accept this invite"
            )
        user = existing
    else:
        if not body.password:
            raise HTTPException(_422, "Choose a password of at least 10 characters")
        user = AdminUser(
            email=inv.email, name=body.name.strip(), password_hash=hash_password(body.password)
        )
        session.add(user)
        await session.flush()
        set_session_cookie(response, user.id)

    session.add(Membership(org_id=org.id, user_id=user.id, role=inv.role))
    inv.accepted_at = utcnow()
    record(session, user, "member.joined", "org", org.id, org_id=org.id, role=inv.role)
    await session.commit()
    return Accepted(org_id=org.id)
