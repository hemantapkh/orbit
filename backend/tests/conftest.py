import itertools
import json
import os
import re
import sqlite3
import tempfile
from collections import defaultdict
from pathlib import Path

import pytest

_tmp = Path(tempfile.mkdtemp(prefix="orbit-test-"))
os.environ.update(
    # ORBIT_TEST_DATABASE_URL runs the suite against another database, e.g. Postgres.
    ORBIT_DATABASE_URL=os.environ.get(
        "ORBIT_TEST_DATABASE_URL", f"sqlite+aiosqlite:///{_tmp}/test.db"
    ),
    ORBIT_MEDIA_DIR=str(_tmp / "media"),
    ORBIT_RUN_WORKER_IN_API="false",
    ORBIT_SEND_RATE_PER_BOT="10000",
    ORBIT_AUDIENCE_REFRESH_INLINE="true",
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
        self.rejected: set[int] = set()  # Telegram refuses the message itself
        self.rate_limit_once: set[int] = set()
        self.calls = defaultdict(int)
        self.with_photo = True
        self.photo_version = 1

    PHOTO = b"\xff\xd8\xff\xe0fake-jpeg"

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/file/bot"):
            self.calls["download"] += 1
            return httpx.Response(200, content=self.PHOTO)
        m = re.match(r"/bot([^/]+)/(\w+)", request.url.path)
        token, method = m.group(1), m.group(2)
        self.calls[method] += 1
        if token not in TOKENS:
            return self._err(401, "Unauthorized")
        if method == "getMe":
            return self._ok({**TOKENS[token], "is_bot": True})
        if method == "getMyShortDescription":
            return self._ok({"short_description": f"About {TOKENS[token]['first_name']}"})
        if method == "getMyDescription":
            return self._ok({"description": "Press Start to begin."})
        if method == "getUserProfilePhotos":
            if not self.with_photo:
                return self._ok({"total_count": 0, "photos": []})
            sizes = [
                {
                    "file_id": f"small-{token[:6]}",
                    "file_unique_id": "s1",
                    "width": 160,
                    "height": 160,
                },
                {
                    "file_id": f"big-{token[:6]}",
                    "file_unique_id": f"v{self.photo_version}",
                    "width": 640,
                    "height": 640,
                },
                {"file_id": "huge", "file_unique_id": "h1", "width": 1280, "height": 1280},
            ]
            return self._ok({"total_count": 1, "photos": [sizes]})
        if method == "getFile":
            return self._ok(
                {"file_id": "x", "file_size": len(self.PHOTO), "file_path": "photos/p.jpg"}
            )
        if method == "getChat":
            chat_id = json.loads(request.content)["chat_id"]
            if chat_id in self.missing:
                return self._err(400, "Bad Request: chat not found")
            if chat_id < -1_000_000_000_000:
                return self._ok({"id": chat_id, "type": "channel", "title": "Release notes"})
            if chat_id < 0:
                return self._ok({"id": chat_id, "type": "group", "title": "QA team"})
            return self._ok(
                {"id": chat_id, "type": "private", "first_name": "Ana", "username": "ana"}
            )

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
        if chat_id in self.rejected:
            return self._err(400, "Bad Request: can't parse entities")

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


def make_user_db(path: Path, users) -> str:
    """A tiny "bot database": users(tg_id, username, first_name, active).

    `users` holds chat ids or (chat_id, username, first_name[, active]) tuples."""
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE IF NOT EXISTS users "
        "(tg_id INTEGER, username TEXT, first_name TEXT, active INTEGER DEFAULT 1)"
    )
    rows = [(u, None, None, 1) if isinstance(u, int) else (tuple(u) + (1,))[:4] for u in users]
    con.executemany("INSERT INTO users VALUES (?, ?, ?, ?)", rows)
    con.commit()
    con.close()
    return f"sqlite:///{path}"


USERS_MAPPING = {
    "chat_id": "tg_id",
    "username": "username",
    "first_name": "first_name",
    "is_active": "active",
}


_db_counter = itertools.count()


async def attach_users(client, bot_id: int, users) -> Path:
    """Connect a fresh bot database holding `users` to the bot. Returns its file path."""
    path = _tmp / f"bot{bot_id}-{next(_db_counter)}.sqlite"
    url = make_user_db(path, users)
    r = await client.put(
        f"/bots/{bot_id}/source",
        json={"database_url": url, "table": "users", "column_map": USERS_MAPPING},
    )
    assert r.status_code == 200, r.text
    return path


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


@pytest.fixture(autouse=True)
def _reset_login_throttle():
    from app.modules.auth.router import _failures

    _failures.clear()
