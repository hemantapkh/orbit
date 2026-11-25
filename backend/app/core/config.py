from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_SECRET = "dev-insecure-secret-change-me-before-deploying"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="ORBIT_", extra="ignore")

    environment: str = "development"
    database_url: str = "sqlite+aiosqlite:///./data/orbit.db"
    secret_key: str = DEFAULT_SECRET
    media_dir: Path = Path("./data/media")
    # Built web console (frontend/dist). When set, the API also serves the UI.
    static_dir: Path | None = None
    max_upload_mb: int = 50

    telegram_api_base: str = "https://api.telegram.org"

    # Delivery engine
    run_worker_in_api: bool = True
    send_rate_per_bot: float = 25.0  # Telegram allows ~30 msg/s per bot for broadcasts
    delivery_batch_size: int = 100
    delivery_concurrency: int = 8
    delivery_max_attempts: int = 3
    worker_poll_seconds: float = 2.0

    # Auth
    session_ttl_hours: int = 72
    cookie_secure: bool = False
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.is_production and settings.secret_key == DEFAULT_SECRET:
        raise RuntimeError("ORBIT_SECRET_KEY must be set in production")
    return settings
