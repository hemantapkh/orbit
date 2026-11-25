"""Audience analytics across bots.

Growth and languages are aggregated inside each bot's own database (read-only, one query
per bot, in parallel). Overlap uses the same live chat-id sets as the subscriber counts.
Blocked counts come from Orbit's own suppression list."""

import asyncio
import time
from collections import Counter, defaultdict
from datetime import UTC, date, datetime, timedelta
from itertools import combinations

from sqlalchemy import DateTime, String, cast, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import dialect_name, utcnow
from app.modules.analytics.schemas import (
    AudienceAnalytics,
    BlockedPoint,
    Breakdown,
    BreakdownItem,
    BroadcastAnalytics,
    BroadcastMarker,
    BroadcastPerformance,
    ColumnChoice,
    Growth,
    GrowthPoint,
    Kpis,
    LanguageCount,
    Languages,
    Overlap,
    OverlapPair,
    Period,
    Range,
    Unit,
)
from app.modules.campaigns.models import (
    Campaign,
    CampaignBot,
    CampaignStatus,
    Delivery,
    DeliveryStatus,
)
from app.modules.sources.connection import SourceError, safe_error
from app.modules.sources.models import BotSource, BotSuppression
from app.modules.sources.query import _value, reflect, where_clause
from app.modules.sources.service import (
    database_sources,
    engine_for,
    live_ids,
    spec_of,
)

CACHE_SECONDS = 120
_cache: dict[tuple, tuple[float, AudienceAnalytics]] = {}


# ---- time ------------------------------------------------------------------------------


def _floor(d: date, unit: Unit) -> date:
    if unit == "week":
        return d - timedelta(days=d.weekday())  # Monday
    if unit == "month":
        return d.replace(day=1)
    return d


def _next(d: date, unit: Unit) -> date:
    if unit == "day":
        return d + timedelta(days=1)
    if unit == "week":
        return d + timedelta(days=7)
    return (d.replace(day=28) + timedelta(days=4)).replace(day=1)


def period(range_: Range, today: date, earliest: date | None = None) -> Period:
    unit: Unit
    match range_:
        case "7d":
            unit, start = "day", today - timedelta(days=6)
        case "30d":
            unit, start = "day", today - timedelta(days=29)
        case "90d":
            unit, start = "week", today - timedelta(days=89)
        case "12m":
            unit, start = "month", (today.replace(day=1) - timedelta(days=330)).replace(day=1)
        case _:
            unit = "month"
            start = (earliest or today - timedelta(days=330)).replace(day=1)
    start = _floor(start, unit)
    buckets, d = [], start
    while d <= today:
        buckets.append(d)
        d = _next(d, unit)
    return Period(range=range_, unit=unit, start=start, end=today, buckets=buckets)


def _bucket(dialect: str, expr, unit: Unit):
    """The bucket a timestamp falls in, as SQL, for the database it runs on."""
    if dialect == "postgresql":
        return func.date_trunc(unit, expr)
    if unit == "week":
        return func.date(expr, "-6 days", "weekday 1")  # Monday on or before
    if unit == "month":
        return func.strftime("%Y-%m-01", expr)
    return func.date(expr)


def _as_date(v) -> date | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def _midnight(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=UTC)


# ---- per bot, inside its own database ----------------------------------------------------


async def _bot_stats(source: BotSource, p: Period | None, prev_start: date | None):
    """(growth rows, joined-before count, previous-period count, languages, earliest join)."""
    spec = spec_of(source)
    m = spec.column_map
    engine = await engine_for(source)
    async with engine.connect() as conn:
        src = await reflect(conn, spec)
        dialect = conn.dialect.name
        where = where_clause(src, spec)
        chat = src.base.c[m.chat_id]
        out = {"growth": [], "before": 0, "previous": 0, "languages": [], "earliest": None}

        if m.joined_at:
            joined = _value(src, m.joined_at)
            col, _ = src.column(m.joined_at)
            try:
                is_time = col.type.python_type in (datetime, date)
            except NotImplementedError:
                is_time = False
            # Compare like with like: timestamptz gets aware UTC values; timestamp without
            # time zone (and text cast to timestamp) gets naive UTC values.
            aware = is_time and bool(getattr(col.type, "timezone", False))
            if dialect == "postgresql" and not is_time:
                joined = cast(joined, DateTime)

            def at(d: date) -> datetime:
                m_ = _midnight(d)
                return m_ if aware or dialect != "postgresql" else m_.replace(tzinfo=None)

            if p is None:  # "all": find where history starts
                out["earliest"] = _as_date(await conn.scalar(select(func.min(joined)).where(where)))
                return out
            start, end = at(p.start), at(p.end) + timedelta(days=1)
            b = _bucket(dialect, joined, p.unit).label("b")
            rows = await conn.execute(
                select(b, func.count(distinct(chat)))
                .where(where, joined >= start, joined < end)
                .group_by(b)
            )
            out["growth"] = [(_as_date(t), n) for t, n in rows]
            out["before"] = await conn.scalar(
                select(func.count(distinct(chat))).where(where, joined < start)
            )
            out["previous"] = await conn.scalar(
                select(func.count(distinct(chat))).where(
                    where, joined >= at(prev_start), joined < start
                )
            )
        if m.language_code and p is not None:
            lang = func.lower(_value(src, m.language_code)).label("lang")
            rows = await conn.execute(
                select(lang, func.count(distinct(chat))).where(where).group_by(lang)
            )
            out["languages"] = [(code, n) for code, n in rows]
        return out


# ---- the whole page --------------------------------------------------------------------------


async def audience(
    session: AsyncSession, range_: Range, bot_ids: list[int] | None
) -> AudienceAnalytics:
    sources = await database_sources(session, bot_ids)
    key = (
        range_,
        tuple(sorted(sources)),
        tuple(sorted((s.id, s.updated_at.isoformat()) for s in sources.values())),
    )
    if (hit := _cache.get(key)) and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]

    today = utcnow().date()
    errors: dict[int, str] = {}

    earliest = None
    if range_ == "all":
        firsts = await asyncio.gather(
            *(_bot_stats(s, None, None) for s in sources.values()), return_exceptions=True
        )
        dates = [f["earliest"] for f in firsts if isinstance(f, dict) and f["earliest"]]
        earliest = min(dates) if dates else None
    p = period(range_, today, earliest)
    prev_start = p.start - (p.end + timedelta(days=1) - p.start)

    results = await asyncio.gather(
        *(_bot_stats(s, p, prev_start) for s in sources.values()), return_exceptions=True
    )
    per_bot: dict[int, dict] = {}
    for (bot_id, _), r in zip(sources.items(), results, strict=True):
        if isinstance(r, BaseException):
            errors[bot_id] = safe_error(r)
        else:
            per_bot[bot_id] = r

    # Overlap from the live reachable sets (suppressions already removed).
    sets: dict[int, frozenset[int]] = {}
    for bot_id, source in sources.items():
        ids = await live_ids(session, source)
        if ids is None:
            errors.setdefault(bot_id, source.last_error or "Couldn't read the bot's database")
        else:
            sets[bot_id] = ids
    seen = Counter(cid for ids in sets.values() for cid in ids)
    by_count = Counter(seen.values())
    pairs = [
        OverlapPair(a=a, b=b, people=len(sets[a] & sets[b]))
        for a, b in combinations(sorted(sets), 2)
    ]

    joined_bots = [b for b, s in sources.items() if spec_of(s).column_map.joined_at]
    lang_bots = [b for b, s in sources.items() if spec_of(s).column_map.language_code]
    growth_points = [
        GrowthPoint(t=t, bot_id=b, count=n)
        for b, r in per_bot.items()
        for t, n in r["growth"]
        if t is not None
    ]
    have_growth = [b for b in joined_bots if b in per_bot]

    langs: Counter = Counter()
    unknown = 0
    for r in per_bot.values():
        for code, n in r["languages"]:
            if code:
                langs[code.split("-")[0]] += n
            else:
                unknown += n
    top = langs.most_common(12)
    rest = sum(langs.values()) - sum(n for _, n in top)
    items = [LanguageCount(code=c, people=n) for c, n in top]
    if rest:
        items.append(LanguageCount(code="other", people=rest))

    # Blocked, from Orbit's own records.
    b = _bucket(dialect_name(), BotSuppression.created_at, p.unit).label("b")
    blocked_rows = await session.execute(
        select(b, func.count())
        .where(
            BotSuppression.bot_id.in_(list(sources)),
            BotSuppression.created_at >= _midnight(p.start),
        )
        .group_by(b)
    )
    blocked = defaultdict(int)
    for t, n in blocked_rows:
        if (d := _as_date(t)) is not None:
            blocked[d] += n

    markers = await _markers(session, p, list(sources))

    result = AudienceAnalytics(
        period=p,
        bots=sorted(sources),
        kpis=Kpis(
            people=len(seen),
            subscriptions=sum(len(s) for s in sets.values()),
            multi_bot_people=sum(n for k, n in by_count.items() if k >= 2),
            new_people=sum(p_.count for p_ in growth_points) if have_growth else None,
            new_people_previous=sum(per_bot[b_]["previous"] for b_ in have_growth)
            if have_growth
            else None,
            blocked=sum(blocked.values()),
        ),
        growth=Growth(
            points=growth_points,
            before_start={b_: per_bot[b_]["before"] for b_ in have_growth},
            missing_joined_at=[b_ for b_ in sources if b_ not in joined_bots],
        ),
        overlap=Overlap(
            by_bot_count=dict(sorted(by_count.items())),
            pairs=pairs,
            per_bot={b_: len(s) for b_, s in sets.items()},
        ),
        languages=Languages(
            items=items,
            unknown=unknown,
            missing_language=[b_ for b_ in sources if b_ not in lang_bots],
        ),
        blocked=[BlockedPoint(t=t, count=n) for t, n in sorted(blocked.items())],
        broadcasts=markers,
        errors=errors,
    )
    _cache[key] = (time.monotonic(), result)
    return result


# ---- broadcasts --------------------------------------------------------------------------


def _started_in(p: Period, bot_ids: list[int]):
    """Broadcasts that started in the period and went through at least one of these bots."""
    return (
        select(Campaign)
        .where(
            Campaign.started_at >= _midnight(p.start),
            Campaign.status != CampaignStatus.DRAFT,
            Campaign.id.in_(select(CampaignBot.campaign_id).where(CampaignBot.bot_id.in_(bot_ids))),
        )
        .order_by(Campaign.started_at)
    )


async def _markers(session: AsyncSession, p: Period, bot_ids: list[int]) -> list[BroadcastMarker]:
    if not bot_ids:
        return []
    rows = (await session.scalars(_started_in(p, bot_ids))).all()
    return [
        BroadcastMarker(
            id=c.id, name=c.name, started=c.started_at, bucket=_floor(c.started_at.date(), p.unit)
        )
        for c in rows
    ]


async def broadcasts(
    session: AsyncSession, range_: Range, bot_ids: list[int] | None
) -> BroadcastAnalytics:
    ids = bot_ids
    p = period(
        range_, utcnow().date(), await _first_broadcast(session) if range_ == "all" else None
    )
    campaigns = (await session.scalars(_started_in(p, ids))).all() if ids else []
    counts: dict[int, Counter] = defaultdict(Counter)
    if campaigns:
        rows = await session.execute(
            select(Delivery.campaign_id, Delivery.status, func.count())
            .where(Delivery.campaign_id.in_([c.id for c in campaigns]), Delivery.bot_id.in_(ids))
            .group_by(Delivery.campaign_id, Delivery.status)
        )
        for cid, st, n in rows:
            counts[cid][st] += n
    items = []
    for c in campaigns:
        k = counts[c.id]
        sent, blocked = k[DeliveryStatus.SENT], k[DeliveryStatus.BLOCKED]
        failed = k[DeliveryStatus.FAILED]
        done = sent + blocked + failed
        items.append(
            BroadcastPerformance(
                id=c.id,
                name=c.name,
                status=c.status,
                started=c.started_at,
                finished=c.finished_at,
                total=sum(k.values()),
                sent=sent,
                blocked=blocked,
                failed=failed,
                delivery_rate=sent / done if done else None,
                block_rate=blocked / done if done else None,
                seconds=int((c.finished_at - c.started_at).total_seconds())
                if c.finished_at
                else None,
            )
        )
    return BroadcastAnalytics(period=p, items=items)


async def _first_broadcast(session: AsyncSession) -> date | None:
    first = await session.scalar(select(func.min(Campaign.started_at)))
    return first.date() if first else None


# ---- breakdown by any column -------------------------------------------------------------

TOP_VALUES = 20


async def columns(session: AsyncSession, bot_id: int) -> list[ColumnChoice]:
    source = (await database_sources(session, [bot_id])).get(bot_id)
    if source is None:
        raise SourceError("Connect this bot's database first")
    spec = spec_of(source)
    async with (await engine_for(source)).connect() as conn:
        src = await reflect(conn, spec)

    def kind(col) -> str:
        try:
            return str(col.type).lower()
        except Exception:
            return col.type.__class__.__name__.lower()

    out = [
        ColumnChoice(ref=c.name, table=src.base.name, name=c.name, type=kind(c)) for c in src.base.c
    ]
    for name, (table, _, _) in src.joins.items():
        out += [
            ColumnChoice(ref=f"{name}.{c.name}", table=name, name=c.name, type=kind(c))
            for c in table.c
        ]
    return out


async def breakdown(session: AsyncSession, bot_id: int, ref: str) -> Breakdown:
    key = ("breakdown", bot_id, ref)
    if (hit := _cache.get(key)) and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    source = (await database_sources(session, [bot_id])).get(bot_id)
    if source is None:
        raise SourceError("Connect this bot's database first")
    spec = spec_of(source)
    async with (await engine_for(source)).connect() as conn:
        src = await reflect(conn, spec)
        col, _ = src.column(ref)  # validates the reference against the real tables
        chat = src.base.c[spec.column_map.chat_id]
        where = where_clause(src, spec)
        value = _value(src, ref)
        try:
            by_month = col.type.python_type in (datetime, date)
        except NotImplementedError:
            by_month = False
        if by_month:
            value = _bucket(conn.dialect.name, value, "month")
        value = cast(value, String).label("v")
        total = await conn.scalar(select(func.count(distinct(chat))).where(where))
        rows = (
            await conn.execute(
                select(value, func.count(distinct(chat)).label("n"))
                .where(where)
                .group_by(value)
                .order_by(func.count(distinct(chat)).desc())
                .limit(TOP_VALUES + 1)
            )
        ).all()
    empty = next((n for v, n in rows if v is None or v == ""), 0)
    named = [(v, n) for v, n in rows if v not in (None, "")][:TOP_VALUES]
    if by_month:
        named = [(str(v)[:7], n) for v, n in named]
    result = Breakdown(
        bot_id=bot_id,
        column=ref,
        total=total,
        items=[BreakdownItem(value=str(v), people=n) for v, n in named],
        other=max(0, total - empty - sum(n for _, n in named)),
        empty=empty,
        grouped_by_month=by_month,
    )
    _cache[key] = (time.monotonic(), result)
    return result
