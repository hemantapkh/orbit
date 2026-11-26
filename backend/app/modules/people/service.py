"""The People list: everyone across an org's bots, filtered in each bot's database.

Each bot's database applies the filters and returns only matching chat ids with their sort
key. Orbit merges them by chat id (the same person on two bots is one row), sorts, counts and
pages in memory, then reads the full record for just the page shown. The merged list is
cached for a minute per filter, so paging and the person view stay quick."""

import asyncio
import time
from datetime import datetime, timedelta

from sqlalchemy import String, cast, false, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import utcnow
from app.modules.campaigns.models import Campaign, Delivery
from app.modules.people.schemas import (
    BotRecord,
    PeoplePage,
    PeopleQuery,
    Person,
    PersonDetail,
    Received,
)
from app.modules.sources.connection import safe_error
from app.modules.sources.models import BotSource, BotSuppression
from app.modules.sources.query import (
    CHAT_KINDS,
    Resolved,
    _chat,
    _on_related,
    _truthy,
    _value,
    as_chat_id,
    at_or_after,
    before,
    category_clause,
    detail_query,
    known_clause,
    reflect,
    row_category,
    search_conditions,
)
from app.modules.sources.service import _as_utc, database_sources, engine_for, spec_of

CACHE_SECONDS = 60
CHUNK = 1000
DAY = timedelta(days=1)
WINDOWS = {"24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY}

# (time, merged rows sorted, skipped, errors) per (org, filters)
_cache: dict[tuple, tuple[float, list[tuple[int, list[int], datetime | None]], dict, dict]] = {}


def _conditions(
    src: Resolved, spec, f: PeopleQuery, orbit: dict[str, list[int]], dialect: str, now
):
    """SQL conditions for the filters, or the field labels this bot is missing."""
    m = spec.column_map
    conds = [known_clause(src, spec)]
    missing: list[str] = []

    if f.q and f.q.strip():
        found = search_conditions(src, spec, f.q)
        conds.append(or_(*found) if found else false())
    if f.kinds:
        if m.chat_type:
            kind = func.lower(cast(_value(src, m.chat_type), String))
            conds.append(kind.in_([t for k in f.kinds for t in CHAT_KINDS[k]]))
        elif f.kinds != ["people"]:  # without a type every chat is taken to be a person
            missing.append("Chat type")
    if f.statuses:
        # Categories this bot can tell; it's left out only if it can tell none of them.
        clauses = [
            c for st in f.statuses if (c := category_clause(src, spec, st, orbit)) is not None
        ]
        if clauses:
            conds.append(or_(*clauses))
        else:
            missing.append("Bot's status")
    if f.active:
        if not m.last_active_at:
            missing.append("Last active")
        elif f.active == "never":
            conds.append(_value(src, m.last_active_at).is_(None))
        elif f.active.startswith("dormant_"):
            since = now - WINDOWS[f.active.removeprefix("dormant_")]
            value = _value(src, m.last_active_at)
            conds.append(or_(value.is_(None), before(src, m.last_active_at, dialect, since)))
        else:
            conds.append(at_or_after(src, m.last_active_at, dialect, now - WINDOWS[f.active]))
    if f.joined:
        if not m.joined_at:
            missing.append("Joined at")
        else:
            conds.append(at_or_after(src, m.joined_at, dialect, now - WINDOWS[f.joined]))
    codes = [c.strip().lower() for c in f.languages if c.strip()]
    if codes:
        if not m.language_code:
            missing.append("Language")
        else:
            lang = func.lower(cast(_value(src, m.language_code), String))
            conds.append(or_(*(lang.like(f"{code}%") for code in codes)))
    if f.premium is not None:
        if not m.is_premium:
            missing.append("Premium")
        else:
            flag = _on_related(src, m.is_premium, _truthy)
            conds.append(flag if f.premium else ~flag)
    return conds, missing


async def _orbit_failures(session: AsyncSession, bot_id: int) -> dict[str, list[int]]:
    """Chats Orbit saw fail while sending: blocked / unreachable -> chat ids."""
    out: dict[str, list[int]] = {}
    rows = await session.execute(
        select(BotSuppression.chat_id, BotSuppression.reason).where(BotSuppression.bot_id == bot_id)
    )
    for cid, reason in rows:
        out.setdefault("blocked" if reason == "blocked" else "unreachable", []).append(cid)
    return out


# Types in a fixed order rather than alphabetical: people, then groups, then channels.
KIND_ORDER = {"private": 0, "group": 1, "supergroup": 2, "channel": 3}
DESCENDING_FIRST = {"last_active", "joined", "bots"}


def _sort_value(src: Resolved, spec, sort: str):
    """SQL for the value a text/date column sorts by, or None (bots, last_active: no extra)."""
    m = spec.column_map
    if sort == "joined" and m.joined_at:
        return _value(src, m.joined_at)
    text = {"kind": m.chat_type, "language": m.language_code}.get(sort)
    if sort == "name":
        parts = [_value(src, ref) for ref in (m.first_name, m.title, m.username) if ref]
        text_expr = func.coalesce(*parts) if len(parts) > 1 else (parts[0] if parts else None)
        return func.lower(cast(text_expr, String)) if text_expr is not None else None
    return func.lower(cast(_value(src, text), String)) if text else None


async def _matches(source: BotSource, f: PeopleQuery, orbit: dict[str, list[int]], now):
    """(chat_id, last active, sort value) for this bot's matching chats, or the fields it's
    missing."""
    spec = spec_of(source)
    m = spec.column_map
    async with (await engine_for(source)).connect() as conn:
        src = await reflect(conn, spec)
        conds, missing = _conditions(src, spec, f, orbit, conn.dialect.name, now)
        if missing:
            return None, missing
        cols = [_chat(src, spec)]
        cols.append(_value(src, m.last_active_at) if m.last_active_at else literal(None))
        value = _sort_value(src, spec, f.sort)
        cols.append(value if value is not None else literal(None))
        out: list[tuple[int, datetime | None, object]] = []
        result = await conn.stream(select(*cols).where(*conds).execution_options(yield_per=5000))
        async for part in result.partitions(5000):
            for cid_raw, seen, v in part:
                if (cid := as_chat_id(cid_raw)) is not None:
                    out.append((cid, _as_utc(seen), _as_utc(v) if f.sort == "joined" else v))
        return out, []


def _ordered(rows: list[list], f: PeopleQuery) -> list[tuple[int, list[int], datetime | None]]:
    """Sort merged rows [chat_id, bots, last active, value]. Empty values go last whichever
    way; ties keep most recently active first."""
    rows.sort(key=lambda r: (r[2] is None, -(r[2].timestamp() if r[2] else 0), r[0]))

    def primary(r):
        match f.sort:
            case "last_active":
                return r[2]
            case "bots":
                return len(r[1])
            case "kind":
                return KIND_ORDER.get(r[3], len(KIND_ORDER)) if r[3] else None
            case _:
                return r[3] or None

    order = f.order or ("desc" if f.sort in DESCENDING_FIRST else "asc")
    present = [r for r in rows if primary(r) is not None]
    present.sort(key=primary, reverse=order == "desc")  # stable: ties keep the order above
    return [(r[0], r[1], r[2]) for r in present + [r for r in rows if primary(r) is None]]


async def _merged(session: AsyncSession, org_id: int, f: PeopleQuery):
    org_bots = await _org_bots(session, org_id)
    sources = await database_sources(session, f.bots or None)
    sources = {b: s for b, s in sources.items() if b in org_bots}
    key = (
        org_id,
        f.model_dump_json(),
        tuple(sorted((s.id, str(s.updated_at)) for s in sources.values())),
    )
    if (hit := _cache.get(key)) and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1], hit[2], hit[3], sources

    now = utcnow()
    orbit = {b: await _orbit_failures(session, b) for b in sources}
    results = await asyncio.gather(
        *(_matches(s, f, orbit[b], now) for b, s in sources.items()), return_exceptions=True
    )
    people: dict[int, list] = {}
    skipped: dict[int, list[str]] = {}
    errors: dict[int, str] = {}
    for bot_id, r in zip(sources, results, strict=True):
        if isinstance(r, BaseException):
            errors[bot_id] = safe_error(r)
            continue
        rows, missing = r
        if missing:
            skipped[bot_id] = missing
            continue
        # Orbit's own failures override the bot's "can receive": keep a chat Orbit saw fail
        # only if that failure is one of the statuses asked for.
        if f.statuses:
            failed = {c: why for why, ids in orbit[bot_id].items() for c in ids}
            rows = [r for r in rows if r[0] not in failed or failed[r[0]] in f.statuses]
        for cid, seen, value in rows:
            entry = people.setdefault(cid, [cid, [], None, None])
            entry[1].append(bot_id)
            if seen is not None and (entry[2] is None or seen > entry[2]):
                entry[2] = seen  # latest activity across bots
            if (
                value is not None
                and entry[3] is None
                or (
                    isinstance(value, datetime)
                    and isinstance(entry[3], datetime)
                    and value < entry[3]
                )
            ):
                entry[3] = value  # first known name/type/language; earliest join

    merged = _ordered([r for r in people.values() if not f.multi or len(r[1]) > 1], f)
    if len(_cache) > 64:
        _cache.clear()
    _cache[key] = (time.monotonic(), merged, skipped, errors)
    return merged, skipped, errors, sources


async def _org_bots(session: AsyncSession, org_id: int) -> set[int]:
    from app.modules.bots.models import Bot

    return set((await session.scalars(select(Bot.id).where(Bot.org_id == org_id))).all())


async def _records(
    session: AsyncSession, sources: dict[int, BotSource], wanted: dict[int, list[int]]
) -> dict[int, dict[int, dict]]:
    """chat_id -> bot_id -> mapped row, for the chats each bot should be asked about."""
    out: dict[int, dict[int, dict]] = {}

    async def one(bot_id: int, ids: list[int]):
        spec = spec_of(sources[bot_id])
        rows = []
        async with (await engine_for(sources[bot_id])).connect() as conn:
            src = await reflect(conn, spec)
            for i in range(0, len(ids), CHUNK):
                rows += (
                    (await conn.execute(detail_query(src, spec, ids[i : i + CHUNK])))
                    .mappings()
                    .all()
                )
        return bot_id, rows

    results = await asyncio.gather(
        *(one(b, ids) for b, ids in wanted.items() if ids), return_exceptions=True
    )
    for r in results:
        if isinstance(r, BaseException):
            continue
        bot_id, rows = r
        orbit = await _orbit_failures(session, bot_id)
        failed = {c: why for why, ids in orbit.items() for c in ids}
        for row in rows:
            if (cid := as_chat_id(row["chat_id"])) is None:
                continue
            row = dict(row)
            category = row_category(row)
            if category == "can_receive" and cid in failed:
                category = failed[cid]
            row["category"] = category
            out.setdefault(cid, {})[bot_id] = row
    return out


def _person(cid: int, by_bot: dict[int, dict]) -> Person:
    rows = list(by_bot.values())

    def first(field: str):
        return next((r[field] for r in rows if r.get(field) not in (None, "")), None)

    names = [
        " ".join(p for p in (r.get("first_name"), r.get("last_name")) if p) or r.get("title")
        for r in rows
    ]
    joined = [t for r in rows if (t := _as_utc(r.get("joined_at")))]
    active = [t for r in rows if (t := _as_utc(r.get("last_active_at")))]
    premium = [r.get("is_premium") for r in rows if r.get("is_premium") is not None]
    kind = first("chat_type")
    return Person(
        chat_id=cid,
        name=next((n for n in names if n), None),
        username=first("username"),
        kind=str(kind).lower() if kind else None,
        language_code=first("language_code"),
        is_premium=any(bool(p) for p in premium) if premium else None,
        joined_at=min(joined) if joined else None,
        last_active_at=max(active) if active else None,
        bots=[
            BotRecord(
                bot_id=b,
                category=r["category"],
                joined_at=_as_utc(r.get("joined_at")),
                last_active_at=_as_utc(r.get("last_active_at")),
                language_code=r.get("language_code"),
            )
            for b, r in sorted(by_bot.items())
        ],
    )


async def people_page(
    session: AsyncSession, org_id: int, f: PeopleQuery, page: int, size: int
) -> PeoplePage:
    merged, skipped, errors, sources = await _merged(session, org_id, f)
    shown = merged[(page - 1) * size : page * size]
    wanted: dict[int, list[int]] = {}
    for cid, bots, _ in shown:
        for b in bots:
            wanted.setdefault(b, []).append(cid)
    records = await _records(session, sources, wanted)
    return PeoplePage(
        total=len(merged),
        page=page,
        size=size,
        items=[_person(cid, records[cid]) for cid, _, _ in shown if cid in records],
        skipped=skipped,
        errors=errors,
    )


async def person_detail(session: AsyncSession, org_id: int, chat_id: int) -> PersonDetail:
    sources = await database_sources(session, None)
    org_bots = await _org_bots(session, org_id)
    sources = {b: s for b, s in sources.items() if b in org_bots}
    records = await _records(session, sources, {b: [chat_id] for b in sources})
    rows = await session.execute(
        select(
            Delivery.campaign_id,
            Campaign.name,
            Delivery.bot_id,
            Delivery.status,
            func.coalesce(Delivery.processed_at, Delivery.sent_at),
            Delivery.error,
        )
        .join(Campaign, Campaign.id == Delivery.campaign_id)
        .where(Delivery.chat_id == chat_id, Campaign.org_id == org_id)
        .order_by(func.coalesce(Delivery.processed_at, Delivery.sent_at).desc().nulls_last())
        .limit(50)
    )
    return PersonDetail(
        person=_person(chat_id, records[chat_id]) if chat_id in records else None,
        received=[
            Received(campaign_id=c, campaign_name=n, bot_id=b, status=s, at=t, error=e)
            for c, n, b, s, t, e in rows
        ],
    )
