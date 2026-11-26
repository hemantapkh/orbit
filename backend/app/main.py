import asyncio
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import FileResponse

import app.models  # noqa: F401  (register all tables)
from app.core.config import get_settings
from app.core.db import SessionLocal
from app.integrations.telegram.client import TelegramClient
from app.modules.activity.router import router as activity_router
from app.modules.analytics.router import router as analytics_router
from app.modules.auth.router import router as auth_router
from app.modules.auth.service import bootstrap_admin
from app.modules.bots.router import router as bots_router
from app.modules.campaigns.engine import DeliveryEngine
from app.modules.campaigns.public import PRIVATE_HEADERS
from app.modules.campaigns.public import router as public_shares_router
from app.modules.campaigns.router import router as campaigns_router
from app.modules.campaigns.test_groups import router as test_groups_router
from app.modules.media.router import router as media_router
from app.modules.orgs.router import public as invites_router
from app.modules.orgs.router import router as orgs_router
from app.modules.overview.router import router as overview_router
from app.modules.people.router import router as people_router
from app.modules.sources.connection import engines as source_engines
from app.modules.sources.router import router as sources_router

ADMIN_ROUTERS = [
    auth_router,
    orgs_router,
    overview_router,
    bots_router,
    sources_router,
    campaigns_router,
    test_groups_router,
    media_router,
    activity_router,
    analytics_router,
    people_router,
]

# No session; the share token in the URL is the credential (see campaigns/public.py).
PUBLIC_ROUTERS = [public_shares_router, invites_router]


class _HideShareTokens(logging.Filter):
    """Keep share tokens out of access logs: /share/<token> -> /share/***."""

    _pattern = re.compile(r"(/(?:api/public/)?shares?/)[A-Za-z0-9_-]{20,}")

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(
                self._pattern.sub(r"\1***", a) if isinstance(a, str) else a for a in record.args
            )
        return True


logging.getLogger("uvicorn.access").addFilter(_HideShareTokens())

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.media_dir.mkdir(parents=True, exist_ok=True)
    http = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10))
    app.state.telegram = TelegramClient(http, settings.telegram_api_base)
    await bootstrap_admin()

    stop = asyncio.Event()
    worker = None
    if settings.run_worker_in_api:
        engine = DeliveryEngine(SessionLocal, app.state.telegram, settings)
        worker = asyncio.create_task(engine.run(stop))
    yield
    stop.set()
    if worker:
        await worker
    await source_engines.dispose_all()
    await http.aclose()


def create_app() -> FastAPI:
    app = FastAPI(title="Orbit", version="0.1.0", lifespan=lifespan)
    api = APIRouter(prefix="/api")
    for r in ADMIN_ROUTERS + PUBLIC_ROUTERS:
        api.include_router(r)

    @api.get("/health", tags=["system"])
    async def health():
        return {"status": "ok"}

    app.include_router(api)
    if get_settings().static_dir:
        _serve_console(app, get_settings().static_dir.resolve())
    return app


def _serve_console(app: FastAPI, root: Path) -> None:
    """Serve the built React console. Unknown paths get index.html (client-side routes)."""
    index = root / "index.html"
    if not index.is_file():
        raise RuntimeError(f"ORBIT_STATIC_DIR has no index.html: {root}")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def console(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "Not found")
        file = (root / path).resolve()
        if path and file.is_file() and file.is_relative_to(root):
            # Vite fingerprints everything in assets/, so it can be cached forever.
            immutable = path.startswith("assets/")
            headers = {"Cache-Control": "public, max-age=31536000, immutable"} if immutable else {}
            return FileResponse(file, headers=headers)
        if path.startswith("share/"):
            return FileResponse(index, headers=PRIVATE_HEADERS)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()
