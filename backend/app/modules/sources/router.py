from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import utcnow
from app.core.deps import SessionDep
from app.core.security import encrypt_secret
from app.modules.activity.service import record
from app.modules.auth.deps import CurrentAdmin
from app.modules.bots.models import Bot
from app.modules.sources import service
from app.modules.sources.connection import (
    SourceError,
    describe_url,
    engines,
    normalize_url,
    safe_error,
    temporary_engine,
)
from app.modules.sources.models import BotSource, SourceKind, SourceStatus
from app.modules.sources.query import list_tables, server_version
from app.modules.sources.schemas import (
    ConnectionIn,
    ConnectionOut,
    IntrospectOut,
    PreviewIn,
    PreviewOut,
    SourceOut,
    SourceSaveIn,
    SourceSpec,
)

router = APIRouter(tags=["sources"])

_UNPROCESSABLE = status.HTTP_422_UNPROCESSABLE_CONTENT


def _fail(exc: BaseException, url: URL | None = None) -> HTTPException:
    return HTTPException(_UNPROCESSABLE, safe_error(exc, url))


async def _source_for(session: AsyncSession, bot_id: int) -> BotSource | None:
    return await session.scalar(select(BotSource).where(BotSource.bot_id == bot_id))


async def _resolve_url(session: AsyncSession, body: ConnectionIn) -> URL:
    """A URL typed in the setup flow, or the saved one when editing a bot's source."""
    try:
        if body.database_url:
            return normalize_url(body.database_url)
        if body.bot_id is not None and (src := await _source_for(session, body.bot_id)):
            return service.url_of(src)
    except SourceError as exc:
        raise _fail(exc) from exc
    raise HTTPException(_UNPROCESSABLE, "Enter a database URL")


async def _connection_info(engine, url: URL) -> ConnectionOut:
    async with engine.connect() as conn:
        version = await server_version(conn)
    return ConnectionOut(ok=True, server_version=version, **describe_url(url))


@router.post("/sources/test", response_model=ConnectionOut)
async def test_connection(body: ConnectionIn, session: SessionDep, _: CurrentAdmin):
    url = await _resolve_url(session, body)
    try:
        async with temporary_engine(url) as engine:
            return await _connection_info(engine, url)
    except Exception as exc:
        raise _fail(exc, url) from exc


@router.post("/sources/introspect", response_model=IntrospectOut)
async def introspect(body: ConnectionIn, session: SessionDep, _: CurrentAdmin):
    url = await _resolve_url(session, body)
    try:
        async with temporary_engine(url) as engine:
            info = await _connection_info(engine, url)
            async with engine.connect() as conn:
                tables = await list_tables(conn)
    except Exception as exc:
        raise _fail(exc, url) from exc
    return IntrospectOut(connection=info, tables=tables)


@router.post("/sources/preview", response_model=PreviewOut)
async def preview(body: PreviewIn, session: SessionDep, _: CurrentAdmin):
    url = await _resolve_url(session, body)
    spec = SourceSpec.model_validate(body.model_dump(by_alias=True))
    try:
        async with temporary_engine(url) as engine:
            return await service.preview(engine, spec)
    except Exception as exc:
        raise _fail(exc, url) from exc


# ---- a bot's saved source ----------------------------------------------------------------


def _out(source: BotSource | None) -> SourceOut:
    if source is None:
        return SourceOut(kind="none")
    try:
        where = describe_url(service.url_of(source))
    except SourceError:
        where = {}
    return SourceOut(
        kind="database",
        **where,
        db_schema=source.schema_name,
        table=source.table_name,
        column_map=source.column_map,
        filters=source.filters,
        joins=source.joins or [],
        status=source.status,
        last_error=source.last_error,
        last_checked_at=source.last_checked_at,
        cached_count=source.cached_count,
        cached_count_at=source.cached_count_at,
    )


async def _bot_and_source(session: AsyncSession, bot_id: int) -> tuple[Bot, BotSource | None]:
    bot = await session.get(Bot, bot_id)
    if bot is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Bot not found")
    return bot, await _source_for(session, bot_id)


@router.get("/bots/{bot_id}/source", response_model=SourceOut)
async def get_source(bot_id: int, session: SessionDep, _: CurrentAdmin):
    _, source = await _bot_and_source(session, bot_id)
    if source is not None and source.kind == SourceKind.DATABASE:
        await service.live_ids(session, source)  # refreshes health + cached count if stale
    return _out(source)


@router.put("/bots/{bot_id}/source", response_model=SourceOut)
async def save_source(bot_id: int, body: SourceSaveIn, session: SessionDep, admin: CurrentAdmin):
    _, source = await _bot_and_source(session, bot_id)
    try:
        if body.database_url:
            url = normalize_url(body.database_url)
        elif source is not None and source.database_url_encrypted:
            url = service.url_of(source)
        else:
            raise SourceError("Enter a database URL")
    except SourceError as exc:
        raise _fail(exc) from exc

    spec = SourceSpec.model_validate(body.model_dump(by_alias=True, exclude={"database_url"}))
    try:
        async with temporary_engine(url) as engine:
            result = await service.preview(engine, spec)  # same validation as the live preview
    except Exception as exc:
        raise _fail(exc, url) from exc

    if source is None:
        source = BotSource(bot_id=bot_id)
        session.add(source)
    now = utcnow()
    source.kind = SourceKind.DATABASE
    if body.database_url:
        source.database_url_encrypted = encrypt_secret(url.render_as_string(hide_password=False))
    source.schema_name = spec.db_schema
    source.table_name = spec.table
    source.column_map = spec.column_map.model_dump(exclude_none=True)
    source.filters = [f.model_dump() for f in spec.filters]
    source.joins = [j.model_dump(by_alias=True) for j in spec.joins]
    source.status, source.last_error, source.last_checked_at = SourceStatus.HEALTHY, None, now
    source.cached_count, source.cached_count_at = result.total, now
    record(
        session,
        admin,
        "source.saved",
        "bot",
        bot_id,
        table=f"{spec.db_schema + '.' if spec.db_schema else ''}{spec.table}",
        url_changed=bool(body.database_url),
        reachable=result.total,
    )
    await session.commit()
    await engines.drop(source.id)
    service.id_cache.drop(source.id)
    return _out(source)


@router.delete("/bots/{bot_id}/source", status_code=status.HTTP_204_NO_CONTENT)
async def delete_source(bot_id: int, session: SessionDep, admin: CurrentAdmin):
    """Disconnect the bot's database. Suppressions are kept."""
    _, source = await _bot_and_source(session, bot_id)
    if source is not None:
        await engines.drop(source.id)
        service.id_cache.drop(source.id)
        record(session, admin, "source.removed", "bot", bot_id)
        await session.delete(source)
        await session.commit()


class PersonOut(BaseModel):
    chat_id: int
    username: str | None
    first_name: str | None
    last_name: str | None
    reachable: bool  # False if they blocked the bot or opted out


@router.get("/bots/{bot_id}/people", response_model=list[PersonOut])
async def search_people(
    bot_id: int,
    session: SessionDep,
    _: CurrentAdmin,
    q: str = Query(min_length=1, max_length=100),
):
    """Search a bot's users to hand-pick recipients."""
    await _bot_and_source(session, bot_id)
    try:
        return await service.search_people(session, bot_id, q)
    except Exception as exc:
        raise _fail(exc) from exc
