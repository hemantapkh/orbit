# Deploying Orbit

Orbit ships as **one Docker image** that serves both the web console and the API on
port **8000**. Database migrations run automatically every time the container starts.

## With Docker Compose (Orbit + Postgres)

```bash
cp .env.example .env     # set ORBIT_SECRET_KEY, ORBIT_ADMIN_PASSWORD, POSTGRES_PASSWORD
docker compose up -d --build
```

Open `http://localhost:8000` and sign in with `ORBIT_ADMIN_EMAIL` / `ORBIT_ADMIN_PASSWORD`.

## With the image alone

```bash
docker build -t orbit .
docker run -d -p 8000:8000 -v orbit-data:/data \
  -e ORBIT_SECRET_KEY=... \
  -e ORBIT_DATABASE_URL=postgresql://orbit:pass@db:5432/orbit \
  -e ORBIT_BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  -e ORBIT_BOOTSTRAP_ADMIN_PASSWORD=... \
  orbit
```

Without `ORBIT_DATABASE_URL`, Orbit uses SQLite in the `/data` volume, which is fine for a
single small instance. Postgres is recommended for anything real.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `ORBIT_SECRET_KEY` | **Yes** | Long random string. Encrypts bot tokens and database URLs, signs sessions. **Never change it once bots are connected.** Generate with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`. |
| `ORBIT_DATABASE_URL` | Recommended | Orbit's own database, e.g. `postgresql://user:pass@host:5432/orbit`. |
| `ORBIT_COOKIE_SECURE` | Behind HTTPS | Set to `true` so the session cookie is HTTPS-only. |
| `ORBIT_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | First start | Creates the first account, as owner of a first organization, when none exists; ignored afterwards. Everyone else joins by invite link. Or run `python -m app.cli create-admin you@example.com` in the container. |
| `ORBIT_RUN_WORKER_IN_API` | No | `true` (default) sends broadcasts from the API process. Set `false` and run `python -m app.worker` as a separate container to keep sending through API restarts. |
| `ORBIT_SEND_RATE_PER_BOT` | No | Messages per second per bot. Default 25 (Telegram allows about 30). |

Every setting, with its default, is listed in [`backend/.env.example`](../backend/.env.example).

## Reverse proxy

Send **all** traffic to port 8000; the container decides what is UI and what is API.

```nginx
server {
    server_name orbit.example.com;
    client_max_body_size 55m;   # media uploads go up to 50 MB

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy: `orbit.example.com { reverse_proxy orbit:8000 }` plus `request_body { max_size 55MB }`.

## Production checklist

- **Senders claim their batches,** so two containers overlapping during a deploy never send
  the same message twice. A batch claimed by a container that was killed is sent again
  after 5 minutes.
- **Graceful shutdown.** Give the container at least 10 s to stop so the batch in flight is
  recorded.
- **Keep port 8000 private.** Publish it on `127.0.0.1` and let the proxy face the internet.
- **Back up** Orbit's database and the `/data` volume (uploaded media).

## Connecting a bot's database

Orbit reads each bot's user table live and read-only. Give it a dedicated user that can
only read what it needs:

```sql
CREATE ROLE orbit_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE botdb TO orbit_ro;
GRANT USAGE ON SCHEMA public TO orbit_ro;
GRANT SELECT ON public.users TO orbit_ro;       -- plus any linked tables you map
```

Orbit also opens every session read-only and stops any query after 15 seconds.

## Share links

Shared broadcasts live at `/share/<token>` and need no sign-in. Responses carry
`Referrer-Policy: no-referrer`, `Cache-Control: no-store` and `X-Robots-Tag: noindex`, and
Orbit masks share tokens in its access log. If your proxy keeps its own access logs,
consider masking `/share/` and `/api/public/shares/` paths there too.
