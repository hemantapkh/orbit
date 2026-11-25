"""Run the delivery engine as its own process (set ORBIT_RUN_WORKER_IN_API=false)."""

import asyncio
import logging
import signal

import httpx

import app.models  # noqa: F401
from app.core.config import get_settings
from app.core.db import SessionLocal
from app.integrations.telegram.client import TelegramClient
from app.modules.campaigns.engine import DeliveryEngine


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    settings = get_settings()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as http:
        engine = DeliveryEngine(
            SessionLocal, TelegramClient(http, settings.telegram_api_base), settings
        )
        await engine.run(stop)


if __name__ == "__main__":
    asyncio.run(main())
