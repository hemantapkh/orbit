import math
from collections import defaultdict
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from sqlalchemy import BigInteger, Integer, case, cast, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import dialect_name, utcnow
from app.integrations.telegram.bots import unseal_token
from app.integrations.telegram.client import TelegramClient
from app.integrations.telegram.delivery import SendResult, deliver
from app.integrations.telegram.messages import MessageContent
from app.modules.bots.models import Bot
from app.modules.campaigns.models import (
    Campaign,
    CampaignBot,
    CampaignStatus,
    Delivery,
    DeliveryStatus,
)
from app.modules.campaigns.schemas import (
    Audience,
    CampaignBotStats,
    CampaignDetail,
    CampaignOut,
    DeliveryStats,
    ErrorGroup,
    ProgressOut,
    RelatedSend,
    ShareOut,
    TimelinePoint,
)
from app.modules.media.models import MediaAsset
from app.modules.media.service import media_ref_for_bot, remember_file_id
from app.modules.sources.service import counts_by_bot


def _stats(counts: dict[str, int]) -> DeliveryStats:
    return DeliveryStats(**counts, total=sum(counts.values()))


async def bot_ids_for(session: AsyncSession, campaign_ids: Iterable[int]) -> dict[int, list[int]]:
    out: dict[int, list[int]] = defaultdict(list)
    rows = await session.execute(
        select(CampaignBot.campaign_id, CampaignBot.bot_id).where(
            CampaignBot.campaign_id.in_(list(campaign_ids))
        )
    )
    for cid, bid in rows:
        out[cid].append(bid)
    return out


async def delivery_stats(
    session: AsyncSession, campaign_ids: Iterable[int]
) -> dict[int, DeliveryStats]:
    raw: dict[int, dict[str, int]] = defaultdict(dict)
    rows = await session.execute(
        select(Delivery.campaign_id, Delivery.status, func.count())
        .where(Delivery.campaign_id.in_(list(campaign_ids)))
        .group_by(Delivery.campaign_id, Delivery.status)
    )
    for cid, st, n in rows:
        raw[cid][st] = n
    return defaultdict(DeliveryStats, {cid: _stats(c) for cid, c in raw.items()})


async def set_bots(session: AsyncSession, campaign_id: int, bot_ids: list[int]) -> None:
    await session.execute(delete(CampaignBot).where(CampaignBot.campaign_id == campaign_id))
    for bid in dict.fromkeys(bot_ids):
        session.add(CampaignBot(campaign_id=campaign_id, bot_id=bid))


def to_out(c: Campaign, bot_ids: list[int], stats: DeliveryStats) -> CampaignOut:
    return CampaignOut(
        id=c.id,
        name=c.name,
        status=c.status,
        message=MessageContent.model_validate(c.message or {}),
        bot_ids=sorted(bot_ids),
        audience=Audience.model_validate(c.audience or {}),
        source_campaign_id=c.source_campaign_id,
        scheduled_at=c.scheduled_at,
        started_at=c.started_at,
        finished_at=c.finished_at,
        created_at=c.created_at,
        updated_at=c.updated_at,
        stats=stats,
    )


async def detail(session: AsyncSession, c: Campaign) -> CampaignDetail:
    bot_ids = (await bot_ids_for(session, [c.id]))[c.id]
    stats = (await delivery_stats(session, [c.id]))[c.id]

    per_bot: dict[int, dict[str, int]] = defaultdict(dict)
    rows = await session.execute(
        select(Delivery.bot_id, Delivery.status, func.count())
        .where(Delivery.campaign_id == c.id)
        .group_by(Delivery.bot_id, Delivery.status)
    )
    for bid, st, n in rows:
        per_bot[bid][st] = n
    # Include bots that have history even if later removed from the selection.
    all_ids = set(bot_ids) | set(per_bot)
    bots = (await session.scalars(select(Bot).where(Bot.id.in_(all_ids)))).all()
    counts = await counts_by_bot(session, all_ids)

    errors = dict(
        (
            await session.execute(
                select(CampaignBot.bot_id, CampaignBot.error).where(
                    CampaignBot.campaign_id == c.id, CampaignBot.error.is_not(None)
                )
            )
        ).all()
    )
    root = c.source_campaign_id or c.id
    family = (
        await session.scalars(
            select(Campaign)
            .where((Campaign.id == root) | (Campaign.source_campaign_id == root))
            .order_by(Campaign.created_at, Campaign.id)
        )
    ).all()
    fam_ids = [f.id for f in family]
    fam_stats = await delivery_stats(session, fam_ids)
    fam_bots = await bot_ids_for(session, fam_ids)

    out = to_out(c, bot_ids, stats)
    return CampaignDetail(
        **out.model_dump(),
        share=ShareOut(token=c.share_token, hide_message=c.share_hide_message)
        if c.share_token
        else None,
        sends=[
            RelatedSend(
                id=f.id,
                name=f.name,
                status=f.status,
                created_at=f.created_at,
                started_at=f.started_at,
                audience_mode=(f.audience or {}).get("mode", "all"),
                bot_ids=sorted(fam_bots[f.id]),
                stats=fam_stats[f.id],
            )
            for f in family
        ],
        bots=[
            CampaignBotStats(
                bot_id=b.id,
                username=b.username,
                display_name=b.display_name,
                audience=counts[b.id].active,
                stats=_stats(per_bot.get(b.id, {})),
                error=errors.get(b.id),
            )
            for b in sorted(bots, key=lambda b: b.display_name.lower())
        ],
    )


async def skip_pending(session: AsyncSession, campaign_id: int) -> None:
    await session.execute(
        update(Delivery)
        .where(Delivery.campaign_id == campaign_id, Delivery.status == DeliveryStatus.PENDING)
        .values(status=DeliveryStatus.SKIPPED)
    )


async def send_once(
    session: AsyncSession,
    telegram: TelegramClient,
    bot: Bot,
    chat_id: int,
    message: MessageContent,
) -> SendResult:
    """Send one message outside a campaign (test sends). Reuses this bot's media upload."""
    asset = None
    media = None
    if message.media_id is not None:
        asset = await session.get(MediaAsset, message.media_id)
        media = await media_ref_for_bot(session, asset, bot.id)
    result = await deliver(telegram, unseal_token(bot.token_encrypted), chat_id, message, media)
    if asset and result.file_id:
        await remember_file_id(session, asset.id, bot.id, result.file_id)
    return result


# ---- live progress ---------------------------------------------------------------------

# Final outcome of a message, in the words the broadcast page uses. Rate limits never
# appear here: those messages are retried, not failed.
_OUTCOME = case(
    (Delivery.status == DeliveryStatus.SENT, "delivered"),
    (Delivery.status == DeliveryStatus.BLOCKED, "blocked"),
    (func.lower(Delivery.error).like("%chat not found%"), "unreachable"),
    else_="failed",
).label("outcome")

_BUCKETS = (5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400)


def _bucket_expr(column, seconds: int):
    """Floor a timestamp to `seconds`-wide buckets, as epoch seconds (portable SQL)."""
    if dialect_name() == "postgresql":
        epoch = cast(func.floor(func.extract("epoch", column)), BigInteger)
    else:
        epoch = cast(func.strftime("%s", column), Integer)
    return (epoch // seconds) * seconds  # `//` renders as floor division on every dialect


async def progress(session: AsyncSession, c: Campaign, rate_per_bot: float) -> ProgressOut:
    now = utcnow()
    start = c.started_at
    end = c.finished_at or now
    elapsed = int((end - start).total_seconds()) if start else None
    size = next((b for b in _BUCKETS if (elapsed or 0) / b <= 60), _BUCKETS[-1])

    points: list[TimelinePoint] = []
    first = last = None
    if start:
        bucket = _bucket_expr(Delivery.processed_at, size).label("b")
        rows = await session.execute(
            select(bucket, Delivery.bot_id, _OUTCOME, func.count())
            .where(Delivery.campaign_id == c.id, Delivery.processed_at.is_not(None))
            .group_by(bucket, Delivery.bot_id, _OUTCOME)
        )
        points = [
            TimelinePoint(t=datetime.fromtimestamp(int(b), UTC), bot_id=bot, outcome=o, count=n)
            for b, bot, o, n in rows
        ]
        first = datetime.fromtimestamp(int(start.timestamp()) // size * size, UTC)
        last = datetime.fromtimestamp(int(end.timestamp()) // size * size, UTC)

    window = now - timedelta(seconds=120)
    recent = await session.scalar(
        select(func.count()).where(Delivery.campaign_id == c.id, Delivery.processed_at >= window)
    )
    per_minute = (recent or 0) / 2 if c.status == CampaignStatus.RUNNING else 0.0

    pending_by_bot = dict(
        (
            await session.execute(
                select(Delivery.bot_id, func.count())
                .where(Delivery.campaign_id == c.id, Delivery.status == DeliveryStatus.PENDING)
                .group_by(Delivery.bot_id)
            )
        ).all()
    )
    pending = sum(pending_by_bot.values())
    eta = None
    if pending:
        if per_minute > 0:
            eta = math.ceil(pending / per_minute * 60)
        else:  # not measured yet (or paused): assume Telegram's rate, bots in parallel
            eta = math.ceil(max(pending_by_bot.values()) / rate_per_bot)

    err_rows = await session.execute(
        select(Delivery.bot_id, Delivery.status, Delivery.error, func.count())
        .where(
            Delivery.campaign_id == c.id,
            Delivery.status.in_([DeliveryStatus.FAILED, DeliveryStatus.BLOCKED]),
        )
        .group_by(Delivery.bot_id, Delivery.status, Delivery.error)
        .order_by(func.count().desc())
        .limit(200)
    )
    return ProgressOut(
        bucket_seconds=size,
        start=first,
        end=last,
        points=points,
        per_minute=per_minute,
        eta_seconds=eta,
        elapsed_seconds=elapsed,
        errors=[
            ErrorGroup(bot_id=bot, status=st, error=err or "Unknown error", count=n)
            for bot, st, err, n in err_rows
        ],
    )
