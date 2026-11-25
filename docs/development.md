# Developing Orbit

## Requirements

- Python 3.13 with [uv](https://docs.astral.sh/uv/)
- Node 22+ with [pnpm](https://pnpm.io/)

## Run it locally

```bash
# API on http://localhost:8000
cd backend
cp .env.example .env
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000

# Console on http://localhost:5173 (proxies /api to the API)
cd frontend
pnpm install
pnpm dev
```

SQLite is used by default (`backend/data/orbit.db`). For a bot database to test against,
any SQLite file works locally: `sqlite:///path/to/bot.db` (Postgres only in production).

## Tests and checks

```bash
cd backend
uv run pytest            # API, delivery engine, database sources, sharing
uv run ruff check app tests && uv run ruff format app tests

cd frontend
pnpm exec tsc -b && pnpm build
```

Tests use a fake Telegram API and throwaway SQLite "bot databases", so they need no network.

## Database migrations

Models live in each module's `models.py`. After changing them:

```bash
cd backend
uv run alembic revision --autogenerate -m "what changed"
uv run alembic upgrade head
```

Read the generated file before committing; check drop order on Postgres and give new
non-null columns a `server_default`.

## Where things are

```
backend/app/
  core/                     settings, database, security
  integrations/telegram/    everything that talks to the Telegram Bot API
  modules/                  bots, sources, campaigns, media, auth, overview, activity
backend/migrations/         Alembic
frontend/src/
  app/                      shell, auth, error pages
  components/               UI primitives and brand marks
  features/                 one folder per area (bots, campaigns, sources, ...)
docs/                       architecture, deployment, brand
```

See [architecture.md](architecture.md) for how the pieces fit together.
