#!/bin/sh
set -e
# Bring the database schema up to date before starting (safe to run every time).
alembic upgrade head
exec "$@"
