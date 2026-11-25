"""Connections to bots' own databases: URL rules, engine cache, safe error messages.

Everything here is dialect-agnostic SQLAlchemy; adding MySQL etc. later means a driver
plus an entry in _DRIVERS and _connect_args."""

import asyncio
import hashlib
from contextlib import asynccontextmanager

from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError, DBAPIError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings

STATEMENT_TIMEOUT_MS = 15_000


class SourceError(Exception):
    """A problem with a bot's database, phrased for the operator."""


# scheme -> async driver URL scheme
_DRIVERS = {
    "postgres": "postgresql+asyncpg",
    "postgresql": "postgresql+asyncpg",
    "postgresql+asyncpg": "postgresql+asyncpg",
}
_DEV_ONLY = {"sqlite": "sqlite+aiosqlite", "sqlite+aiosqlite": "sqlite+aiosqlite"}


def normalize_url(raw: str) -> URL:
    raw = raw.strip()
    scheme = raw.split("://", 1)[0].lower() if "://" in raw else ""
    drivers = dict(_DRIVERS)
    if not get_settings().is_production:
        drivers |= _DEV_ONLY  # tests and local demos use a SQLite file as the "bot database"
    if scheme not in drivers:
        raise SourceError(
            "Only PostgreSQL is supported right now. Use a URL like "
            "postgresql://user:password@host:5432/dbname"
        )
    try:
        url = make_url(raw)
    except ArgumentError as exc:
        raise SourceError("That doesn't look like a valid database URL") from exc
    url = url.set(drivername=drivers[scheme])
    if not url.database:
        raise SourceError("The URL needs a database name")
    return url


def describe_url(url: URL) -> dict:
    """Safe-to-show parts of a URL. Never the password, never the full string."""
    backend = url.get_backend_name()
    return {
        "driver": {"postgresql": "Postgres", "sqlite": "SQLite"}.get(backend, backend),
        "host": url.host or None,
        "database": url.database.rsplit("/", 1)[-1] if backend == "sqlite" else url.database,
    }


def _connect_args(url: URL) -> dict:
    if url.get_backend_name() == "postgresql":
        return {
            "timeout": 10,
            "server_settings": {
                "statement_timeout": str(STATEMENT_TIMEOUT_MS),
                "default_transaction_read_only": "on",
                "application_name": "orbit",
            },
        }
    return {}


def _make_engine(url: URL, *, pooled: bool) -> AsyncEngine:
    kwargs: dict = {"connect_args": _connect_args(url)}
    if not pooled:
        kwargs["poolclass"] = NullPool
    elif url.get_backend_name() != "sqlite":
        kwargs |= {"pool_size": 2, "max_overflow": 0, "pool_pre_ping": True}
    return create_async_engine(url, **kwargs)


def safe_error(exc: BaseException, url: URL | None = None) -> str:
    """Turn a driver exception into one readable line without credentials or SQL."""
    if isinstance(exc, SourceError):
        return str(exc)
    if isinstance(exc, TimeoutError | asyncio.TimeoutError):
        return "The database didn't respond in time"
    inner = exc.orig if isinstance(exc, DBAPIError) and exc.orig is not None else exc
    msg = str(inner).strip().splitlines()[0] if str(inner).strip() else inner.__class__.__name__
    if isinstance(inner, OSError) or "connect call failed" in msg.lower():
        msg = f"Couldn't reach the database server ({msg})"
    if url is not None and url.password:
        msg = msg.replace(str(url.password), "***")
    return msg[:300]


@asynccontextmanager
async def temporary_engine(url: URL):
    """Unpooled engine for one-off checks from the setup flow."""
    eng = _make_engine(url, pooled=False)
    try:
        yield eng
    finally:
        await eng.dispose()


class EngineCache:
    """One small pool per saved source, rebuilt when its URL changes."""

    def __init__(self):
        self._engines: dict[int, tuple[str, AsyncEngine]] = {}
        self._lock = asyncio.Lock()

    async def get(self, source_id: int, url: URL) -> AsyncEngine:
        fp = hashlib.sha256(url.render_as_string(hide_password=False).encode()).hexdigest()
        async with self._lock:
            current = self._engines.get(source_id)
            if current and current[0] == fp:
                return current[1]
            if current:
                await current[1].dispose()
            eng = _make_engine(url, pooled=True)
            self._engines[source_id] = (fp, eng)
            return eng

    async def drop(self, source_id: int) -> None:
        async with self._lock:
            if current := self._engines.pop(source_id, None):
                await current[1].dispose()

    async def dispose_all(self) -> None:
        async with self._lock:
            for _, eng in self._engines.values():
                await eng.dispose()
            self._engines.clear()


engines = EngineCache()

__all__ = ["SQLAlchemyError", "SourceError", "engines", "normalize_url", "temporary_engine"]
