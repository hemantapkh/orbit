"""Delivery engine: turns running campaigns into Telegram messages.

Every tick it starts campaigns whose scheduled time has arrived, then sends one batch per
(campaign, bot) and writes the outcomes back. Campaign status is re-read every tick, so
pause and cancel take effect within one batch. All progress lives in `deliveries`, so a
restarted worker resumes where it stopped.
"""

import asyncio
import logging
import time
from dataclasses import dataclass

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.db import utcnow
from app.integrations.telegram.bots import unseal_token
from app.integrations.telegram.client import MediaRef, TelegramClient
from app.integrations.telegram.delivery import SendStatus, deliver
from app.integrations.telegram.messages import MessageContent
from app.modules.activity.service import record
from app.modules.bots.models import Bot
from app.modules.campaigns.models import (
    Campaign,
    CampaignBot,
    CampaignStatus,
    Delivery,
    DeliveryStatus,
)
from app.modules.campaigns.schemas import Audience
from app.modules.campaigns.service import skip_pending
from app.modules.media.models import MediaAsset
from app.modules.media.service import media_ref_for_bot, remember_file_id
from app.modules.sources.service import (
    database_sources,
    iter_audience,
    mark_error,
    suppress,
    suppressed_ids,
)

log = logging.getLogger("orbit.engine")


class RateLimiter:
    """Spaces out calls to at most `rate` per second; `pause` honours Telegram's retry_after."""

    def __init__(self, rate: float):
        self._interval = 1.0 / rate
        self._next = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            start = max(self._next, now)
            self._next = start + self._interval
        if (wait := start - now) > 0:
            await asyncio.sleep(wait)

    def pause(self, seconds: float) -> None:
        self._next = max(self._next, time.monotonic() + seconds)


@dataclass(slots=True)
class Outcome:
    delivery_id: int
    chat_id: int
    status: DeliveryStatus
    attempts: int
    error: str | None = None
    message_id: int | None = None
    file_id: str | None = None
    suppress_reason: str | None = None  # blocked | unreachable: don't message again


class DeliveryEngine:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        telegram: TelegramClient,
        settings: Settings,
    ):
        self._sm = sessionmaker
        self._tg = telegram
        self._s = settings
        self._limiters: dict[int, RateLimiter] = {}

    # ---- loop -------------------------------------------------------------------------

    async def run(self, stop: asyncio.Event) -> None:
        log.info("Delivery engine started")
        while not stop.is_set():
            try:
                busy = await self.tick()
            except Exception:
                log.exception("Delivery engine tick failed")
                busy = False
            if not busy:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=self._s.worker_poll_seconds)
                except TimeoutError:
                    pass
        log.info("Delivery engine stopped")

    async def tick(self) -> bool:
        """One pass. Returns True if anything was sent (so the loop shouldn't sleep)."""
        await self._start_due_campaigns()
        async with self._sm() as s:
            running = (
                await s.scalars(
                    select(Campaign.id).where(Campaign.status == CampaignStatus.RUNNING)
                )
            ).all()
        if not running:
            return False
        results = await asyncio.gather(*(self._process_campaign(cid) for cid in running))
        return any(results)

    # ---- campaign lifecycle -----------------------------------------------------------

    async def _start_due_campaigns(self) -> None:
        async with self._sm() as s:
            due = (
                await s.scalars(
                    select(Campaign.id).where(
                        Campaign.status == CampaignStatus.SCHEDULED,
                        Campaign.scheduled_at <= utcnow(),
                    )
                )
            ).all()
        for cid in due:
            async with self._sm() as s:
                # Conditional update: only one worker can claim the start.
                claimed = await s.execute(
                    update(Campaign)
                    .where(Campaign.id == cid, Campaign.status == CampaignStatus.SCHEDULED)
                    .values(status=CampaignStatus.RUNNING, started_at=utcnow())
                )
                if claimed.rowcount != 1:
                    continue
                # Claim, snapshot, then commit: other workers never see a running campaign
                # whose recipient list is still being written.
                campaign = await s.get(Campaign, cid)
                audience = Audience.model_validate(campaign.audience or {})
                if audience.mode == "selected":
                    await self._snapshot_selected(s, cid, audience)
                else:
                    await self._snapshot_database_audiences(s, cid)
                record(s, None, "campaign.started", "campaign", cid, audience=audience.mode)
                await s.commit()
                log.info("Campaign %s started", cid)

    @staticmethod
    async def _snapshot_selected(s: AsyncSession, campaign_id: int, audience: Audience) -> None:
        """Hand-picked recipients. People who blocked the bot are still skipped."""
        bot_ids = set(
            (
                await s.scalars(
                    select(CampaignBot.bot_id)
                    .join(Bot, Bot.id == CampaignBot.bot_id)
                    .where(CampaignBot.campaign_id == campaign_id, Bot.is_active.is_(True))
                )
            ).all()
        )
        by_bot: dict[int, list[int]] = {}
        for r in audience.recipients:
            if r.bot_id in bot_ids and r.chat_id not in by_bot.setdefault(r.bot_id, []):
                by_bot[r.bot_id].append(r.chat_id)
        rows = []
        for bot_id, chat_ids in by_bot.items():
            skip = await suppressed_ids(s, bot_id)
            rows += [
                {
                    "campaign_id": campaign_id,
                    "bot_id": bot_id,
                    "chat_id": cid,
                    "status": DeliveryStatus.PENDING,
                    "attempts": 0,
                }
                for cid in chat_ids
                if cid not in skip
            ]
        if rows:
            await s.execute(insert(Delivery), rows)

    @staticmethod
    async def _snapshot_database_audiences(s: AsyncSession, campaign_id: int) -> None:
        """Read each database-source bot's recipients from its own database.

        A bot's list is read completely before anything is inserted, so a failure midway
        leaves no partial audience. One failing database doesn't stop the other bots."""
        bot_ids = (
            await s.scalars(
                select(CampaignBot.bot_id)
                .join(Bot, Bot.id == CampaignBot.bot_id)
                .where(CampaignBot.campaign_id == campaign_id, Bot.is_active.is_(True))
            )
        ).all()
        for bot_id, source in (await database_sources(s, bot_ids)).items():
            chat_ids: list[int] = []
            try:
                async for chunk in iter_audience(s, source):
                    chat_ids.extend(chunk)
            except Exception as exc:
                mark_error(source, exc)
                record(
                    s,
                    None,
                    "source.failed",
                    "bot",
                    bot_id,
                    campaign_id=campaign_id,
                    error=source.last_error,
                )
                await s.execute(
                    update(CampaignBot)
                    .where(CampaignBot.campaign_id == campaign_id, CampaignBot.bot_id == bot_id)
                    .values(error=f"Couldn't read the bot's database: {source.last_error}")
                )
                log.error("Campaign %s: source for bot %s failed", campaign_id, bot_id)
                continue
            for i in range(0, len(chat_ids), 5000):
                await s.execute(
                    insert(Delivery),
                    [
                        {
                            "campaign_id": campaign_id,
                            "bot_id": bot_id,
                            "chat_id": cid,
                            "status": DeliveryStatus.PENDING,
                            "attempts": 0,
                        }
                        for cid in chat_ids[i : i + 5000]
                    ],
                )

    async def _process_campaign(self, campaign_id: int) -> bool:
        async with self._sm() as s:
            c = await s.get(Campaign, campaign_id)
            if c is None or c.status != CampaignStatus.RUNNING:
                return False
            content = MessageContent.model_validate(c.message)
            asset = await s.get(MediaAsset, content.media_id) if content.media_id else None
            bots = (
                await s.scalars(
                    select(Bot).where(
                        Bot.id.in_(
                            select(Delivery.bot_id)
                            .where(
                                Delivery.campaign_id == campaign_id,
                                Delivery.status == DeliveryStatus.PENDING,
                            )
                            .distinct()
                        )
                    )
                )
            ).all()

            if not bots:
                done = await s.execute(
                    update(Campaign)
                    .where(Campaign.id == campaign_id, Campaign.status == CampaignStatus.RUNNING)
                    .values(status=CampaignStatus.COMPLETED, finished_at=utcnow())
                )
                if done.rowcount == 1:
                    record(s, None, "campaign.completed", "campaign", campaign_id)
                await s.commit()
                log.info("Campaign %s completed", campaign_id)
                return False

            if content.media_id and asset is None:
                await self._abort(s, campaign_id, "attached media was deleted")
                return False

            batches: list[tuple[Bot, list[Delivery]]] = []
            for bot in bots:
                rows = (
                    await s.scalars(
                        select(Delivery)
                        .where(
                            Delivery.campaign_id == campaign_id,
                            Delivery.bot_id == bot.id,
                            Delivery.status == DeliveryStatus.PENDING,
                        )
                        .order_by(Delivery.id)
                        .limit(self._s.delivery_batch_size)
                    )
                ).all()
                if not bot.is_active or not bot.token_valid:
                    await s.execute(
                        update(Delivery)
                        .where(
                            Delivery.campaign_id == campaign_id,
                            Delivery.bot_id == bot.id,
                            Delivery.status == DeliveryStatus.PENDING,
                        )
                        .values(status=DeliveryStatus.SKIPPED, error="bot disabled during campaign")
                    )
                    continue
                batches.append((bot, list(rows)))
            await s.commit()

        await asyncio.gather(
            *(self._send_batch(bot, rows, content, asset) for bot, rows in batches)
        )
        return True

    async def _abort(self, s: AsyncSession, campaign_id: int, reason: str) -> None:
        log.error("Campaign %s cancelled: %s", campaign_id, reason)
        await s.execute(
            update(Campaign)
            .where(Campaign.id == campaign_id)
            .values(status=CampaignStatus.CANCELLED, finished_at=utcnow())
        )
        await s.execute(
            update(Delivery)
            .where(Delivery.campaign_id == campaign_id, Delivery.status == DeliveryStatus.PENDING)
            .values(error=reason)
        )
        await skip_pending(s, campaign_id)
        await s.commit()

    # ---- sending ----------------------------------------------------------------------

    def _limiter(self, bot_id: int) -> RateLimiter:
        if bot_id not in self._limiters:
            self._limiters[bot_id] = RateLimiter(self._s.send_rate_per_bot)
        return self._limiters[bot_id]

    async def _send_batch(
        self,
        bot: Bot,
        rows: list[Delivery],
        content: MessageContent,
        asset: MediaAsset | None,
    ) -> None:
        token = unseal_token(bot.token_encrypted)
        queue = list(rows)
        outcomes: list[Outcome] = []
        media: MediaRef | None = None

        if asset is not None:
            async with self._sm() as s:
                media = await media_ref_for_bot(s, asset, bot.id)
            # First upload to this bot goes alone; everyone after reuses its file_id.
            while media.file_id is None and queue:
                out = await self._deliver(token, bot.id, queue.pop(0), content, media)
                outcomes.append(out)
                if out.file_id:
                    media = MediaRef(kind=media.kind, file_id=out.file_id)
                    async with self._sm() as s:
                        await remember_file_id(s, asset.id, bot.id, out.file_id)

        sem = asyncio.Semaphore(self._s.delivery_concurrency)

        async def one(d: Delivery) -> Outcome:
            async with sem:
                return await self._deliver(token, bot.id, d, content, media)

        outcomes += await asyncio.gather(*(one(d) for d in queue))
        await self._record(bot.id, outcomes)

    async def _deliver(
        self,
        token: str,
        bot_id: int,
        d: Delivery,
        content: MessageContent,
        media: MediaRef | None,
    ) -> Outcome:
        limiter = self._limiter(bot_id)
        await limiter.acquire()
        attempts = d.attempts + 1
        try:
            r = await deliver(self._tg, token, d.chat_id, content, media)
        except Exception as exc:  # never let one bad send kill the batch
            log.exception("Unexpected error delivering %s", d.id)
            return Outcome(d.id, d.chat_id, DeliveryStatus.FAILED, attempts, repr(exc)[:500])

        base = (d.id, d.chat_id)
        match r.status:
            case SendStatus.DELIVERED:
                return Outcome(
                    *base,
                    DeliveryStatus.SENT,
                    attempts,
                    message_id=r.message_id,
                    file_id=r.file_id,
                )
            case SendStatus.RATE_LIMITED:
                limiter.pause(r.retry_after or 1)
                # Not the recipient's fault: retry without spending an attempt.
                return Outcome(*base, DeliveryStatus.PENDING, d.attempts, r.error)
            case SendStatus.RECIPIENT_BLOCKED:
                return Outcome(
                    *base,
                    DeliveryStatus.BLOCKED,
                    attempts,
                    r.error,
                    suppress_reason="blocked",
                )
            case SendStatus.RECIPIENT_UNREACHABLE:
                return Outcome(
                    *base,
                    DeliveryStatus.FAILED,
                    attempts,
                    r.error,
                    suppress_reason="unreachable",
                )
            case SendStatus.TRANSIENT if attempts < self._s.delivery_max_attempts:
                return Outcome(*base, DeliveryStatus.PENDING, attempts, r.error)
        return Outcome(*base, DeliveryStatus.FAILED, attempts, r.error)

    async def _record(self, bot_id: int, outcomes: list[Outcome]) -> None:
        if not outcomes:
            return
        now = utcnow()
        async with self._sm() as s:
            await s.execute(
                update(Delivery),
                [
                    {
                        "id": o.delivery_id,
                        "status": o.status,
                        "attempts": o.attempts,
                        "error": o.error,
                        "telegram_message_id": o.message_id,
                        "sent_at": now if o.status == DeliveryStatus.SENT else None,
                        "processed_at": None if o.status == DeliveryStatus.PENDING else now,
                    }
                    for o in outcomes
                ],
            )
            # We never write to a bot's database, so blocked chats are remembered here.
            await suppress(
                s, bot_id, [(o.chat_id, o.suppress_reason) for o in outcomes if o.suppress_reason]
            )
            await s.commit()
