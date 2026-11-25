# Architecture

Orbit is a **modular monolith**: one FastAPI app, one database, feature modules with
clear boundaries. The delivery engine runs inside the API process by default, or as
`app.worker` on its own.

```
app/
  core/                    config, database, security, shared dependencies
  integrations/telegram/   everything that speaks the Telegram Bot API
    client.py              HTTP client
    messages.py            the Telegram message format (text, parse mode, media, buttons)
    bots.py                token checks (getMe) and sealing/unsealing bot tokens
    delivery.py            send one message → plain outcome (delivered, blocked, rate limited…)
  modules/
    auth/ bots/ sources/ media/ campaigns/ overview/ activity/
```

## Telegram boundary

Orbit is built for Telegram and only Telegram. The one rule: **Telegram API calls, error
codes and bot credentials stay in `integrations/telegram/`.** Feature modules call it and
work with the results; for example, the campaign engine maps `SendStatus.RECIPIENT_BLOCKED`
to a blocked delivery without knowing that Telegram returned HTTP 403.

Platform-specific data stays explicit where it lives (`bots.telegram_id`, per-bot
`media_bot_files.file_id`). There is deliberately no provider abstraction.

## Bot databases

A bot's audience is read live from the bot's own database (`bot_sources`) with SQLAlchemy
Core against reflected tables: one main table holding the Telegram ID, plus tables linked
to it by foreign keys. Nothing is copied. Chats that blocked a bot are kept in
`bot_suppressions`, because Orbit never writes to a bot's database.

## Delivery

Launching a broadcast schedules it; the engine claims it, snapshots recipients into
`deliveries`, then sends in batches per bot at ~25 msg/s with retries. All progress is in
the database, so pause/stop act within one batch and a restart resumes.
