<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/brand/orbit-mark-dark.svg">
    <img src="frontend/public/brand/orbit-mark.svg" alt="Orbit" width="84" height="84">
  </picture>
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>Everything connected. One place.</strong><br>
  A self-hosted control center for the Telegram bots you already run.
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#license">License</a>
</p>

---

When you run several Telegram bots, each one lives in its own world: its own code, its
own database, its own users. Reaching everyone means a script per bot, guessing how many
people are still listening, and no idea what happened after you pressed send.

**Orbit puts all of them on one console.** Connect a bot with its token, point Orbit at
the table where the bot keeps its users, and you can see who each bot can reach, write one
message, and send it through any combination of bots, then watch it arrive live.
Your bots don't change, and Orbit never writes to their databases.

## Features

**Bots and audiences**
- Connect any number of bots; tokens are verified with Telegram and stored encrypted.
- Read each bot's users **live from its own Postgres database**, read-only. A guided setup
  finds the table with Telegram IDs, maps names and language (including from linked
  tables), and lets you filter, for example only private chats or only premium users.
- See reachable people per bot and across all bots, with people who blocked a bot
  remembered and skipped automatically.

**Broadcasting**
- Write in **Markdown** (or HTML), attach a photo, video, GIF or file, and add link
  buttons, with a live Telegram-style preview.
- Send to **everyone** on the chosen bots or to **hand-picked people**.
- **Test groups**: send the draft to your own account, a QA group or a channel in one click.
- Send now or **schedule**; pause, resume or stop at any time.
- **Send again** to a different audience; every send of a message stays grouped.

**Results**
- Live progress with current speed and time remaining.
- A timeline of delivered, blocked, unreachable and failed messages, filterable by bot.
- Failure reasons in plain language, so you know whether people blocked the bot or a
  message was rejected.
- **Share a read-only link** to a broadcast's live results, with no sign-in for viewers and
  never anyone's personal details.

**For teams**
- **Organizations**: separate spaces with their own bots, broadcasts and members.
- **Roles**: owner, admin, sender and viewer, so people get exactly the access they need.
- Invite people with a one-time link; they choose their own password.
- An activity log of who did what.
- One Docker image, Postgres or SQLite, and migrations that run themselves.

## How it works

1. **Connect a bot** with its token from [@BotFather](https://t.me/BotFather).
2. **Connect its database.** Orbit reads the user table when it needs to; nothing is copied.
3. **Compose and send.** Orbit delivers through the Telegram Bot API at Telegram's rate
   limits, retries what's worth retrying, and records every outcome.

Delivery state lives in Orbit's own database, so a restart picks up exactly where it
stopped.

## Quick start

```bash
git clone <this repository> orbit && cd orbit
cp .env.example .env        # set ORBIT_SECRET_KEY, ORBIT_ADMIN_PASSWORD, POSTGRES_PASSWORD
docker compose up -d --build
```

Open **http://localhost:8000** and sign in. Then add a bot under **Bots**.

## Documentation

| Guide | What's in it |
| --- | --- |
| [Deployment](docs/deployment.md) | Docker, environment variables, reverse proxy, production checklist, read-only database users |
| [Development](docs/development.md) | Running locally, tests, migrations, project layout |
| [Architecture](docs/architecture.md) | How the modules, the delivery engine and the Telegram integration fit together |
| [Brand](docs/brand.md) | Logo, colours and type |

**Built with** FastAPI, SQLAlchemy and Alembic on the backend, React, TypeScript and
Tailwind CSS on the frontend.

## Status

Orbit is in active development. It is built for Telegram only; other messaging platforms
are not planned.

## License

Copyright © 2026 Hemanta Pokharel.

Orbit is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE).
You can use, self-host, study and modify it. If you run a modified version as a
service for others, you must make your changes available to its users under the same
license.
