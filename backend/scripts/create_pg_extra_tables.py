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

VECTOR_EXTENSION_DDL = """CREATE EXTENSION IF NOT EXISTS vector;"""

CONVERSATION_SNAPSHOTS_DDL = """
CREATE TABLE IF NOT EXISTS conversation_snapshots (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    session_id BIGINT NOT NULL,
    thread_id VARCHAR(64),
    turn_index INTEGER NOT NULL,
    summary TEXT NOT NULL,
    facts JSONB,
    embedding vector(768),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
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
        print("[info] Ensuring pgvector extension (IF NOT EXISTS)...")
        try:
            conn.execute(text(VECTOR_EXTENSION_DDL))
        except Exception as exc:  # noqa: BLE001
            print("[warn] Failed to create pgvector extension:", exc)
        print("[info] Creating table conversation_snapshots (IF NOT EXISTS)...")
        conn.execute(text(CONVERSATION_SNAPSHOTS_DDL))
        # 兼容已存在但缺少 embedding 列的旧表
        try:
            conn.execute(text("ALTER TABLE conversation_snapshots ADD COLUMN IF NOT EXISTS embedding vector(768);"))
        except Exception as exc:  # noqa: BLE001
            print("[warn] Failed to ensure embedding column on conversation_snapshots:", exc)
    print("[done] Extra PostgreSQL tables created/verified.")


if __name__ == "__main__":
    main()
