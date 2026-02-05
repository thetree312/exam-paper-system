#!/usr/bin/env python3
"""Create extra PostgreSQL tables that are not covered by SQLAlchemy models.

Currently covers:
- schema_migrations
- profile_events

Usage (from backend dir, venv activated, DATABASE_URL pointing to PostgreSQL):

    python scripts/create_pg_extra_tables.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import text

# Ensure backend package is importable and .env is loaded
BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

from app.db import engine  # noqa: E402


SCHEMA_MIGRATIONS_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) PRIMARY KEY,
    executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""

PROFILE_EVENTS_DDL = """
CREATE TABLE IF NOT EXISTS profile_events (
    id BIGINT PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    session_id BIGINT NOT NULL,
    document_id BIGINT,
    event_type VARCHAR(64) NOT NULL DEFAULT 'dialogue_turn',
    payload JSONB NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def main() -> None:
    print("[info] Using engine URL:", engine.url)
    with engine.begin() as conn:
        print("[info] Creating table schema_migrations (IF NOT EXISTS)...")
        conn.execute(text(SCHEMA_MIGRATIONS_DDL))
        print("[info] Creating table profile_events (IF NOT EXISTS)...")
        conn.execute(text(PROFILE_EVENTS_DDL))
    print("[done] Extra PostgreSQL tables created/verified.")


if __name__ == "__main__":
    main()
