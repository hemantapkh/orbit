"""People across an org's bots: a filtered list, and one person's full record."""

from fastapi import APIRouter, Query

from app.core.deps import SessionDep
from app.modules.orgs.deps import Viewer
from app.modules.people import service
from app.modules.people.schemas import (
    Activity,
    Category,
    ChatKind,
    Joined,
    Order,
    PeoplePage,
    PeopleQuery,
    PersonDetail,
    Sort,
)

router = APIRouter(prefix="/people", tags=["people"])


@router.get("", response_model=PeoplePage)
async def list_people(
    session: SessionDep,
    m: Viewer,
    bot: list[int] = Query(default=[]),
    q: str | None = Query(default=None, max_length=100),
    kind: list[ChatKind] = Query(default=[]),
    status: list[Category] = Query(default=[]),
    active: Activity | None = None,
    joined: Joined | None = None,
    language: list[str] = Query(default=[], max_length=20),
    premium: bool | None = None,
    multi: bool = False,
    sort: Sort = "last_active",
    order: Order | None = None,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=50, ge=10, le=200),
):
    f = PeopleQuery(
        bots=bot,
        q=q,
        kinds=kind,
        statuses=status,
        active=active,
        joined=joined,
        languages=language,
        premium=premium,
        multi=multi,
        sort=sort,
        order=order,
    )
    return await service.people_page(session, m.org_id, f, page, size)


@router.get("/{chat_id}", response_model=PersonDetail)
async def get_person(chat_id: int, session: SessionDep, m: Viewer):
    return await service.person_detail(session, m.org_id, chat_id)
