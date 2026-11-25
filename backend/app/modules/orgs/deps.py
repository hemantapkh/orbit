"""Who is asking, in which organization, with which role.

Every operator endpoint depends on one of Viewer / Sender / Admin / Owner below. The
organization comes from the X-Org-Id header (the console sends the one you picked) and
is only accepted if you're a member; otherwise your first organization is used."""

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select

from app.core.deps import SessionDep
from app.modules.auth.deps import CurrentAdmin
from app.modules.auth.models import AdminUser
from app.modules.orgs.models import Membership, Organization, Role


@dataclass(frozen=True, slots=True)
class Member:
    user: AdminUser
    org_id: int
    org_name: str
    role: Role

    def at_least(self, role: Role) -> bool:
        return self.role.rank >= role.rank


async def current_member(request: Request, session: SessionDep, user: CurrentAdmin) -> Member:
    rows = (
        await session.execute(
            select(Membership, Organization)
            .join(Organization, Organization.id == Membership.org_id)
            .where(Membership.user_id == user.id)
            .order_by(Organization.name, Organization.id)
        )
    ).all()
    if not rows:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You're not a member of any organization")
    wanted = request.headers.get("x-org-id", "")
    chosen = next((r for r in rows if str(r[1].id) == wanted), rows[0])
    membership, org = chosen
    return Member(user=user, org_id=org.id, org_name=org.name, role=Role(membership.role))


def _role(minimum: Role):
    async def check(member: Annotated[Member, Depends(current_member)]) -> Member:
        if not member.at_least(minimum):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"This needs the {minimum.value} role or higher in {member.org_name}",
            )
        return member

    return check


Viewer = Annotated[Member, Depends(_role(Role.VIEWER))]
Sender = Annotated[Member, Depends(_role(Role.SENDER))]
Admin = Annotated[Member, Depends(_role(Role.ADMIN))]
Owner = Annotated[Member, Depends(_role(Role.OWNER))]


async def get_in_org(session, model, obj_id: int, org_id: int, what: str):
    """Fetch by id, but only inside the caller's organization (404 otherwise)."""
    obj = await session.get(model, obj_id)
    if obj is None or obj.org_id != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")
    return obj
