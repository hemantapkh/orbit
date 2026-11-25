# Orbit

**Everything connected. One place.**

Orbit is a self-hosted console for running many independent Telegram bots: connect each
bot and its database, see who it can reach, and send broadcasts across any combination of
them. Each bot keeps its own code and database; Orbit only reads it.

## What it does today

- **Overview** – active subscribers per bot, distinct people across all bots, recent broadcasts.
- **Bots** – connect with a token (verified with Telegram, stored encrypted), enable/disable,
  replace token.
- **Bot databases** – each bot's audience is read live from its own Postgres database
  (read-only): pick the user table, map columns (including linked tables), add filters, preview.
- **Broadcasts** – composer with formatting, media and link buttons; send now or schedule;
  everyone or hand-picked people; pause / resume / stop; per-bot delivery results;
  send the same message again and see every send together.
- **Activity log** – who did what, plus what the delivery engine did.

## Run it locally

```bash
# API (http://localhost:8000)
cd backend
cp .env.example .env            # then edit
uv sync && uv run alembic upgrade head
uv run uvicorn app.main:app --port 8000

# Web console (http://localhost:5173, proxies /api to the API)
cd frontend
pnpm install && pnpm dev
```

The first operator account is created from `ORBIT_BOOTSTRAP_ADMIN_EMAIL` /
`ORBIT_BOOTSTRAP_ADMIN_PASSWORD`, or with `uv run python -m app.cli create-admin you@example.com`.

Tests: `cd backend && uv run pytest`.

## Configuration

All settings are environment variables prefixed `ORBIT_` (see `backend/app/core/config.py`).
In production set at least `ORBIT_ENVIRONMENT=production`, `ORBIT_SECRET_KEY`,
`ORBIT_DATABASE_URL` (Postgres) and `ORBIT_COOKIE_SECURE=true`. To run delivery in its own
process, set `ORBIT_RUN_WORKER_IN_API=false` and start `uv run python -m app.worker`.

## Layout

```
backend/   FastAPI modular monolith (see docs/architecture.md)
frontend/  React + Vite console
docs/      architecture and brand guide
```
