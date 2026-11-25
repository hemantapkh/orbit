import json
import os
import re
import tempfile
from collections import defaultdict
from pathlib import Path

import pytest

_tmp = Path(tempfile.mkdtemp(prefix="orbit-test-"))
os.environ.update(
    ORBIT_DATABASE_URL=f"sqlite+aiosqlite:///{_tmp}/test.db",
    ORBIT_MEDIA_DIR=str(_tmp / "media"),
    ORBIT_RUN_WORKER_IN_API="false",
    ORBIT_SEND_RATE_PER_BOT="10000",
    ORBIT_BOOTSTRAP_ADMIN_EMAIL="ops@example.com",
    ORBIT_BOOTSTRAP_ADMIN_PASSWORD="correct-horse-battery",
    ORBIT_TELEGRAM_API_BASE="https://telegram.test",
)

import httpx  # noqa: E402

import app.models  # noqa: E402,F401
from app.core.config import get_settings  # noqa: E402
from app.core.db import Base, SessionLocal, engine  # noqa: E402
from app.integrations.telegram.client import TelegramClient  # noqa: E402
from app.main import app as fastapi_app  # noqa: E402
from app.modules.auth.service import bootstrap_admin  # noqa: E402
from app.modules.campaigns.engine import DeliveryEngine  # noqa: E402

TOKENS = {
    "111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA": {
        "id": 111111,
        "username": "alpha_bot",
        "first_name": "Alpha",
    },
    "222222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB": {
        "id": 222222,
        "username": "beta_bot",
        "first_name": "Beta",
    },
}


class FakeTelegram:
    """Minimal Bot API: getMe plus send* with scripted failures per chat_id."""

    def __init__(self):
        self.sent: list[dict] = []
        self.blocked: set[int] = set()
        self.missing: set[int] = set()
        self.rate_limit_once: set[int] = set()
        self.calls = defaultdict(int)

    def handler(self, request: httpx.Request) -> httpx.Response:
        m = re.match(r"/bot([^/]+)/(\w+)", request.url.path)
        token, method = m.group(1), m.group(2)
        self.calls[method] += 1
        if token not in TOKENS:
            return self._err(401, "Unauthorized")
        if method == "getMe":
            return self._ok({**TOKENS[token], "is_bot": True})

        ctype = request.headers.get("content-type", "")
        if ctype.startswith("multipart/"):
            body = request.content.decode("latin-1")
            chat_id = int(re.search(r'name="chat_id"\r\n\r\n(-?\d+)', body).group(1))
            payload = {"chat_id": chat_id, "_upload": True}
        else:
            payload = json.loads(request.content)
            chat_id = payload["chat_id"]

        if chat_id in self.rate_limit_once:
            self.rate_limit_once.discard(chat_id)
            return self._err(429, "Too Many Requests: retry after 0", retry_after=0)
        if chat_id in self.blocked:
            return self._err(403, "Forbidden: bot was blocked by the user")
        if chat_id in self.missing:
            return self._err(400, "Bad Request: chat not found")

        self.sent.append({"method": method, "token": token, **payload})
        result = {"message_id": len(self.sent), "chat": {"id": chat_id}}
        if method == "sendPhoto":
            result["photo"] = [{"file_id": "small"}, {"file_id": f"photo-{token[:6]}"}]
        return self._ok(result)

    @staticmethod
    def _ok(result):
        return httpx.Response(200, json={"ok": True, "result": result})

    @staticmethod
    def _err(code, description, retry_after=None):
        body = {"ok": False, "error_code": code, "description": description}
        if retry_after is not None:
            body["parameters"] = {"retry_after": retry_after}
        return httpx.Response(code, json=body)


@pytest.fixture
async def telegram_fake():
    return FakeTelegram()


@pytest.fixture(autouse=True)
async def db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    await bootstrap_admin()
    yield


@pytest.fixture
async def tg_client(telegram_fake):
    async with httpx.AsyncClient(transport=httpx.MockTransport(telegram_fake.handler)) as http:
        yield TelegramClient(http, "https://telegram.test")


@pytest.fixture
async def anon(tg_client):
    fastapi_app.state.telegram = tg_client
    transport = httpx.ASGITransport(app=fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sb.test/api") as c:
        yield c


@pytest.fixture
async def client(anon):
    r = await anon.post(
        "/auth/login", json={"email": "ops@example.com", "password": "correct-horse-battery"}
    )
    assert r.status_code == 200, r.text
    return anon


@pytest.fixture
def delivery_engine(tg_client):
    return DeliveryEngine(SessionLocal, tg_client, get_settings())


async def connect_bot(client, token_index=0) -> dict:
    token = list(TOKENS)[token_index]
    r = await client.post("/bots", json={"token": token})
    assert r.status_code == 201, r.text
    return r.json()


async def push(client, api_key: str, chat_ids, **extra) -> httpx.Response:
    return await client.post(
        "/integration/v1/subscribers",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"subscribers": [{"chat_id": c, **extra} for c in chat_ids]},
    )


async def drain(engine: DeliveryEngine, max_ticks: int = 50) -> None:
    for _ in range(max_ticks):
        if not await engine.tick():
            # one more tick lets a campaign with nothing pending flip to completed
            await engine.tick()
            return
    raise AssertionError("engine did not settle")


@pytest.fixture(autouse=True)
async def _reset_source_caches():
    from app.modules.sources.connection import engines
    from app.modules.sources.service import id_cache

    id_cache._data.clear()
    yield
    id_cache._data.clear()
    await engines.dispose_all()
