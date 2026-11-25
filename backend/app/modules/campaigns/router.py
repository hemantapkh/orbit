import math
import secrets

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.db import utcnow
from app.core.deps import SessionDep, TelegramDep
from app.integrations.telegram.delivery import SendStatus
from app.integrations.telegram.messages import MessageContent
from app.modules.activity.service import record
from app.modules.bots.models import Bot
from app.modules.campaigns import service
from app.modules.campaigns.models import Campaign, CampaignStatus, Delivery, DeliveryStatus
from app.modules.campaigns.schemas import (
    Audience,
    CampaignDetail,
    CampaignIn,
    CampaignPage,
    CampaignUpdate,
    DeliveryOut,
    DeliveryPage,
    EstimateBot,
    EstimateOut,
    LaunchIn,
    ProgressOut,
    ShareIn,
    TestSendIn,
    TestSendOut,
)
from app.modules.media.models import MediaAsset
from app.modules.orgs.deps import Member, Sender, Viewer, get_in_org
from app.modules.sources.service import counts_by_bot

router = APIRouter(prefix="/campaigns", tags=["campaigns"])

S = CampaignStatus
EDITABLE = {S.DRAFT, S.SCHEDULED}


async def _get(session, campaign_id: int, m: Member) -> Campaign:
    return await get_in_org(session, Campaign, campaign_id, m.org_id, "Campaign")


def _require(c: Campaign, allowed: set[CampaignStatus], action: str) -> None:
    if c.status not in allowed:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Cannot {action} a {c.status} campaign")


async def _validate_bots(session, bot_ids: list[int], m: Member, *, for_launch: bool) -> None:
    if not bot_ids:
        if for_launch:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Pick at least one bot")
        return
    bots = (
        await session.scalars(select(Bot).where(Bot.id.in_(bot_ids), Bot.org_id == m.org_id))
    ).all()
    missing = set(bot_ids) - {b.id for b in bots}
    if missing:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown bots: {missing}")
    if for_launch:
        unusable = [f"@{b.username}" for b in bots if not b.is_active or not b.token_valid]
        if unusable:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"These bots are disabled or have an invalid token: {', '.join(unusable)}",
            )


async def _validate_message(session, msg: MessageContent, m: Member, *, for_launch: bool) -> None:
    media = await session.get(MediaAsset, msg.media_id) if msg.media_id is not None else None
    if msg.media_id is not None and (media is None or media.org_id != m.org_id):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Attached media no longer exists"
        )
    if for_launch and msg.is_empty:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The message is empty")


def _validate_audience(audience: Audience, bot_ids: list[int], *, for_launch: bool) -> None:
    if audience.mode != "selected":
        return
    stray = {r.bot_id for r in audience.recipients} - set(bot_ids)
    if stray:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Some selected people belong to bots that aren't in this broadcast",
        )
    if for_launch and not audience.recipients:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Pick at least one person")


@router.get("", response_model=CampaignPage)
async def list_campaigns(
    session: SessionDep,
    m: Viewer,
    status_: list[CampaignStatus] | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None, max_length=160),
    group: bool = Query(default=False, description="Only the latest send of each message"),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    family = func.coalesce(Campaign.source_campaign_id, Campaign.id)
    conds = [Campaign.org_id == m.org_id]
    if status_:
        conds.append(Campaign.status.in_(status_))
    if q and q.strip():
        conds.append(func.lower(Campaign.name).like(f"%{q.strip().lower()}%"))
    base = select(Campaign).where(*conds)
    if group:
        latest = select(func.max(Campaign.id)).where(*conds).group_by(family)
        base = select(Campaign).where(Campaign.id.in_(latest))
    total = await session.scalar(select(func.count()).select_from(base.subquery()))
    items = (
        await session.scalars(
            base.order_by(Campaign.created_at.desc(), Campaign.id.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    ids = [c.id for c in items]
    bots = await service.bot_ids_for(session, ids)
    stats = await service.delivery_stats(session, ids)
    roots = {c.id: c.source_campaign_id or c.id for c in items}
    sends = dict(
        (
            await session.execute(
                select(family, func.count()).where(family.in_(set(roots.values()))).group_by(family)
            )
        ).all()
    )
    return CampaignPage(
        items=[
            service.to_out(c, bots[c.id], stats[c.id]).model_copy(
                update={"send_count": sends.get(roots[c.id], 1)}
            )
            for c in items
        ],
        total=total,
    )


@router.get("/estimate", response_model=EstimateOut)
async def estimate(session: SessionDep, m: Viewer, bot_ids: list[int] = Query(default=[])):
    """Who a broadcast to these bots would reach, and roughly how long sending takes."""
    allowed = set(
        (
            await session.scalars(select(Bot.id).where(Bot.id.in_(bot_ids), Bot.org_id == m.org_id))
        ).all()
    )
    bot_ids = [b for b in bot_ids if b in allowed]
    counts = await counts_by_bot(session, bot_ids)
    per_bot = [EstimateBot(bot_id=b, recipients=counts[b].active) for b in dict.fromkeys(bot_ids)]
    slowest = max((b.recipients for b in per_bot), default=0)
    return EstimateOut(
        recipients=sum(b.recipients for b in per_bot),
        seconds=math.ceil(slowest / get_settings().send_rate_per_bot),
        bots=per_bot,
    )


@router.post("", response_model=CampaignDetail, status_code=status.HTTP_201_CREATED)
async def create_campaign(body: CampaignIn, session: SessionDep, m: Sender):
    await _validate_bots(session, body.bot_ids, m, for_launch=False)
    await _validate_message(session, body.message, m, for_launch=False)
    _validate_audience(body.audience, body.bot_ids, for_launch=False)
    c = Campaign(
        org_id=m.org_id,
        name=body.name.strip(),
        message=body.message.model_dump(mode="json"),
        audience=body.audience.model_dump(mode="json"),
        created_by_id=m.user.id,
    )
    session.add(c)
    await session.flush()
    await service.set_bots(session, c.id, body.bot_ids)
    record(session, m.user, "campaign.created", "campaign", c.id, org_id=m.org_id, name=c.name)
    await session.commit()
    await session.refresh(c)
    return await service.detail(session, c)


@router.get("/{campaign_id}", response_model=CampaignDetail)
async def get_campaign(campaign_id: int, session: SessionDep, m: Viewer):
    return await service.detail(session, await _get(session, campaign_id, m))


@router.patch("/{campaign_id}", response_model=CampaignDetail)
async def update_campaign(campaign_id: int, body: CampaignUpdate, session: SessionDep, m: Sender):
    c = await _get(session, campaign_id, m)
    # Renaming is always allowed; the message and audience are locked once sending starts.
    if body.model_dump(exclude_none=True, exclude={"name"}):
        _require(c, EDITABLE, "edit")
    if body.name is not None and body.name.strip() != c.name:
        record(
            session,
            m.user,
            "campaign.renamed",
            "campaign",
            c.id,
            org_id=m.org_id,
            name=body.name.strip(),
        )
        c.name = body.name.strip()
    if body.message is not None:
        await _validate_message(session, body.message, m, for_launch=c.status == S.SCHEDULED)
        c.message = body.message.model_dump(mode="json")
    if body.bot_ids is not None:
        await _validate_bots(session, body.bot_ids, m, for_launch=c.status == S.SCHEDULED)
        await service.set_bots(session, c.id, body.bot_ids)
    if body.audience is not None:
        bot_ids = body.bot_ids
        if bot_ids is None:
            bot_ids = (await service.bot_ids_for(session, [c.id]))[c.id]
        _validate_audience(body.audience, bot_ids, for_launch=c.status == S.SCHEDULED)
        c.audience = body.audience.model_dump(mode="json")
    c.updated_at = utcnow()
    await session.commit()
    await session.refresh(c)
    return await service.detail(session, c)


@router.delete("/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_campaign(campaign_id: int, session: SessionDep, m: Sender):
    """Delete a broadcast and its delivery history. Not while it's sending: pause or stop first."""
    c = await _get(session, campaign_id, m)
    if c.status == S.RUNNING:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This broadcast is sending. Pause or stop it first."
        )
    # Keep resends grouped: if this is the original, the oldest resend becomes the new one.
    if c.source_campaign_id is None:
        resends = (
            await session.scalars(
                select(Campaign)
                .where(Campaign.source_campaign_id == c.id)
                .order_by(Campaign.created_at, Campaign.id)
            )
        ).all()
        if resends:
            new_root = resends[0]
            new_root.source_campaign_id = None
            for r in resends[1:]:
                r.source_campaign_id = new_root.id
    record(
        session,
        m.user,
        "campaign.deleted",
        "campaign",
        c.id,
        org_id=m.org_id,
        name=c.name,
        status=c.status,
    )
    await session.delete(c)  # deliveries and bot links go with it (ON DELETE CASCADE)
    await session.commit()


@router.post("/{campaign_id}/duplicate", response_model=CampaignDetail, status_code=201)
async def duplicate_campaign(campaign_id: int, session: SessionDep, m: Sender):
    src = await _get(session, campaign_id, m)
    bot_ids = (await service.bot_ids_for(session, [src.id]))[src.id]
    root = src.source_campaign_id or src.id
    copy = Campaign(
        org_id=src.org_id,
        name=src.name,
        message=src.message,
        audience=src.audience,
        created_by_id=m.user.id,
        source_campaign_id=root,
    )
    session.add(copy)
    await session.flush()
    await service.set_bots(session, copy.id, bot_ids)
    record(
        session,
        m.user,
        "campaign.resend_created",
        "campaign",
        copy.id,
        org_id=m.org_id,
        source_campaign_id=root,
    )
    await session.commit()
    await session.refresh(copy)
    return await service.detail(session, copy)


@router.post("/{campaign_id}/launch", response_model=CampaignDetail)
async def launch_campaign(campaign_id: int, body: LaunchIn, session: SessionDep, m: Sender):
    """Send now (scheduled_at omitted) or schedule for later. The delivery engine picks it up."""
    c = await _get(session, campaign_id, m)
    _require(c, {S.DRAFT, S.SCHEDULED}, "launch")
    bot_ids = (await service.bot_ids_for(session, [c.id]))[c.id]
    await _validate_bots(session, bot_ids, m, for_launch=True)
    await _validate_message(session, MessageContent.model_validate(c.message), m, for_launch=True)
    _validate_audience(Audience.model_validate(c.audience or {}), bot_ids, for_launch=True)

    when = body.scheduled_at
    if when is not None:
        if when.tzinfo is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "scheduled_at must include a timezone"
            )
        if when <= utcnow():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Scheduled time is in the past"
            )
    c.status = S.SCHEDULED
    c.scheduled_at = when or utcnow()
    record(
        session,
        m.user,
        "campaign.scheduled" if when else "campaign.launched",
        "campaign",
        c.id,
        org_id=m.org_id,
        scheduled_at=when.isoformat() if when else None,
    )
    await session.commit()
    return await service.detail(session, c)


@router.post("/{campaign_id}/unschedule", response_model=CampaignDetail)
async def unschedule_campaign(campaign_id: int, session: SessionDep, m: Sender):
    c = await _get(session, campaign_id, m)
    _require(c, {S.SCHEDULED}, "unschedule")
    c.status, c.scheduled_at = S.DRAFT, None
    record(session, m.user, "campaign.unscheduled", "campaign", c.id, org_id=m.org_id)
    await session.commit()
    return await service.detail(session, c)


@router.post("/{campaign_id}/pause", response_model=CampaignDetail)
async def pause_campaign(campaign_id: int, session: SessionDep, m: Sender):
    c = await _get(session, campaign_id, m)
    _require(c, {S.RUNNING}, "pause")
    c.status = S.PAUSED
    record(session, m.user, "campaign.paused", "campaign", c.id, org_id=m.org_id)
    await session.commit()
    return await service.detail(session, c)


@router.post("/{campaign_id}/resume", response_model=CampaignDetail)
async def resume_campaign(campaign_id: int, session: SessionDep, m: Sender):
    c = await _get(session, campaign_id, m)
    _require(c, {S.PAUSED}, "resume")
    c.status = S.RUNNING
    record(session, m.user, "campaign.resumed", "campaign", c.id, org_id=m.org_id)
    await session.commit()
    return await service.detail(session, c)


@router.post("/{campaign_id}/cancel", response_model=CampaignDetail)
async def cancel_campaign(campaign_id: int, session: SessionDep, m: Sender):
    c = await _get(session, campaign_id, m)
    _require(c, {S.SCHEDULED, S.RUNNING, S.PAUSED}, "cancel")
    c.status, c.finished_at = S.CANCELLED, utcnow()
    record(session, m.user, "campaign.cancelled", "campaign", c.id, org_id=m.org_id)
    await service.skip_pending(session, c.id)
    await session.commit()
    return await service.detail(session, c)


@router.get("/{campaign_id}/progress", response_model=ProgressOut)
async def campaign_progress(campaign_id: int, session: SessionDep, m: Viewer):
    """Timeline, speed, time remaining and grouped errors for the broadcast page."""
    c = await _get(session, campaign_id, m)
    return await service.progress(session, c, get_settings().send_rate_per_bot)


@router.put("/{campaign_id}/share", response_model=CampaignDetail)
async def share_campaign(campaign_id: int, body: ShareIn, session: SessionDep, m: Sender):
    """Turn on (or update) the read-only public link. regenerate=true kills the old link."""
    c = await _get(session, campaign_id, m)
    if c.status == S.DRAFT:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Drafts can't be shared. Schedule or send it first."
        )
    action = "campaign.share_updated"
    if c.share_token is None or body.regenerate:
        action = "campaign.share_regenerated" if c.share_token else "campaign.shared"
        c.share_token = secrets.token_urlsafe(32)
    c.share_hide_message = body.hide_message
    record(
        session, m.user, action, "campaign", c.id, org_id=m.org_id, hide_message=body.hide_message
    )
    await session.commit()
    return await service.detail(session, c)


@router.delete("/{campaign_id}/share", response_model=CampaignDetail)
async def unshare_campaign(campaign_id: int, session: SessionDep, m: Sender):
    c = await _get(session, campaign_id, m)
    if c.share_token:
        c.share_token = None
        record(session, m.user, "campaign.unshared", "campaign", c.id, org_id=m.org_id)
        await session.commit()
    return await service.detail(session, c)


@router.get("/{campaign_id}/deliveries", response_model=DeliveryPage)
async def list_deliveries(
    campaign_id: int,
    session: SessionDep,
    m: Viewer,
    status_: DeliveryStatus | None = Query(default=None, alias="status"),
    bot_id: int | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    await _get(session, campaign_id, m)
    base = select(Delivery).where(Delivery.campaign_id == campaign_id)
    if status_:
        base = base.where(Delivery.status == status_)
    if bot_id:
        base = base.where(Delivery.bot_id == bot_id)
    total = await session.scalar(select(func.count()).select_from(base.subquery()))
    rows = (await session.scalars(base.order_by(Delivery.id).limit(limit).offset(offset))).all()
    return DeliveryPage(
        items=[
            DeliveryOut(
                id=d.id,
                bot_id=d.bot_id,
                chat_id=d.chat_id,
                status=d.status,
                attempts=d.attempts,
                error=d.error,
                sent_at=d.sent_at,
            )
            for d in rows
        ],
        total=total,
    )


@router.post("/test-send", response_model=TestSendOut)
async def test_send(body: TestSendIn, session: SessionDep, telegram: TelegramDep, m: Sender):
    """Send a message to one chat (usually your own) to preview it in Telegram."""
    bot = await get_in_org(session, Bot, body.bot_id, m.org_id, "Bot")
    await _validate_message(session, body.message, m, for_launch=True)
    sent = await service.send_once(session, telegram, bot, body.chat_id, body.message)
    if sent.status != SendStatus.DELIVERED:
        hint = ""
        if sent.status in (SendStatus.RECIPIENT_BLOCKED, SendStatus.RECIPIENT_UNREACHABLE):
            hint = " Open the bot in Telegram and press Start first."
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Telegram: {sent.error}.{hint}")
    return TestSendOut(message_id=sent.message_id)
