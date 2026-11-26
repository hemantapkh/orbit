# syntax=docker/dockerfile:1

# ---- 1. Build the web console --------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /web
RUN npm install -g pnpm@12.21.0
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# ---- 2. API + console in one image ---------------------------------------------------
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.9 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/alembic.ini ./
COPY backend/migrations ./migrations
COPY backend/app ./app
COPY --from=web /web/dist ./static
COPY docker-entrypoint.sh /usr/local/bin/

RUN useradd --system --uid 10001 orbit && mkdir -p /data && chown orbit /data
USER orbit

ENV ORBIT_ENVIRONMENT=production \
    ORBIT_STATIC_DIR=/app/static \
    ORBIT_DATABASE_URL=sqlite+aiosqlite:////data/orbit.db \
    ORBIT_MEDIA_DIR=/data/media
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"

ENTRYPOINT ["docker-entrypoint.sh"]
# One worker: the delivery engine runs in this process. To scale the API, set
# ORBIT_RUN_WORKER_IN_API=false and run a separate container with `python -m app.worker`.
# Stop waiting for open connections after 3s on shutdown, so the delivery engine gets to
# finish its batch well inside Docker's 10s before the container is killed.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-graceful-shutdown", "3"]
