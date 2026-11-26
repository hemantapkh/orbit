<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/brand/orbit-mark-dark.svg">
    <img src="frontend/public/brand/orbit-mark.svg" alt="Orbit" width="84" height="84">
  </picture>
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  A self-hosted control center for the Telegram bots you already run.
</p>

---

Orbit connects to your bots with their tokens and reads their users straight from each
bot's own database, read-only. From one place you can see who every bot can reach, send a
broadcast through any combination of bots, and follow it as it's delivered. Your bots
don't change, and Orbit never writes to their databases.

## Features

**Bots and audiences**
- Connect any number of bots. Tokens are checked with Telegram and stored encrypted.
- Map each bot's user table in a guided setup: Telegram ID, names, language, chat type,
  status, activity and more, including columns from linked tables. Columns with standard
  names are filled in for you.
- See who can receive a message, and why the rest can't: blocked the bot, deleted their
  account, removed the bot from a group, or unreachable.

**People**
- Everyone across all bots in one list, merged by Telegram ID.
- Search and filter by bot, chat type, status, last active, join date, language and
  Premium; sort by any column.
- Open anyone to see their record in each bot and every broadcast Orbit sent them.

**Broadcasts**
- Markdown or HTML, a photo, video, GIF or file, link buttons and a live preview.
- Personalize with `{first_name}`, `{username}` and fallbacks.
- Send to everyone, only people, groups or channels, or hand-picked people.
- Test groups: try the message on your own account, a QA group or a channel first.
- Send now or schedule; pause, resume or stop at any time.
- Live progress, speed and time remaining, with failures explained in plain language.
- Share a read-only link to a broadcast's live results, without anyone's personal details.
- Sending picks up where it stopped after a restart, and overlapping containers during a
  deploy never send the same message twice.

**Overview and analytics**
- The last 24 hours at a glance: who joined, who was active, who was lost.
- Audience growth, reach by bot, chat types, languages, Premium share, overlap between
  bots, and broadcast performance, with CSV export.

**Teams**
- Organizations with their own bots, broadcasts and members.
- Roles: owner, admin, sender and viewer. Invite people with a one-time link.
- An activity log of who did what.

## Your bot's database

Orbit needs one table with a row per chat and a column holding the Telegram chat ID.
Everything else is optional; the more you map, the more Orbit can show and filter on.

| Field | Used for |
| --- | --- |
| Telegram chat ID | Sending (required) |
| Username, first and last name, group title | Search, previews, personalization |
| Language, Premium | Filters and analytics |
| Chat type (`private`, `group`, `supergroup`, `channel`) | Sending to people, groups or channels |
| Status (`member`, `kicked`, `left` …), unreachable reason, can-receive flag | Skipping chats that can't be reached |
| Joined at, last active, status changed at | Growth, activity and loss figures |

Blocks Orbit discovers while sending are remembered on Orbit's side, so it works even if
your bot records none of this. Give Orbit a database user that can only read these tables
(see [Deployment](docs/deployment.md#connecting-a-bots-database)).

## Quick start

```bash
git clone <this repository> orbit && cd orbit
cp .env.example .env        # set ORBIT_SECRET_KEY, ORBIT_ADMIN_PASSWORD, POSTGRES_PASSWORD
docker compose up -d --build
```

Open **http://localhost:8000**, sign in, and add a bot under **Bots**.

## Documentation

| Guide | What's in it |
| --- | --- |
| [Deployment](docs/deployment.md) | Docker, environment variables, reverse proxy, production checklist, read-only database users |
| [Development](docs/development.md) | Running locally, tests, migrations, project layout |
| [Architecture](docs/architecture.md) | How the modules, the delivery engine and the Telegram integration fit together |
| [Brand](docs/brand.md) | Logo, colours and type |

Built with FastAPI, SQLAlchemy and Alembic, and React, TypeScript and Tailwind CSS.

## Status

Orbit is in active development and works with Telegram only.

## License

Copyright © 2026 Hemanta Pokharel. Licensed under the
[GNU Affero General Public License v3.0](LICENSE): you can use, self-host and modify Orbit,
and if you offer a modified version to others as a service, you must share your changes
with them under the same license.
