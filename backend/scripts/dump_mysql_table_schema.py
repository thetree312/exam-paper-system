#!/usr/bin/env python3
"""Dump schema for specific MySQL tables using MYSQL_* env.

Usage (from backend dir, venv activated):
    python scripts/dump_mysql_table_schema.py
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect
from urllib.parse import quote_plus

BASE_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

host = os.getenv("MYSQL_HOST", "localhost")
port = int(os.getenv("MYSQL_PORT", "3306"))
user = os.getenv("MYSQL_USER", "root")
password = os.getenv("MYSQL_PASSWORD", "")
db = os.getenv("MYSQL_DB", "exam_paper")

url = (
    f"mysql+pymysql://{quote_plus(user)}:{quote_plus(password)}"
    f"@{host}:{port}/{quote_plus(db)}?charset=utf8mb4"
)

print(f"MySQL URL: {url}")
engine = create_engine(url, future=True)
inspector = inspect(engine)

for table in ("schema_migrations", "profile_events"):
    print("\n" + "=" * 80)
    print(f"TABLE: {table}")
    print("=" * 80)
    cols = inspector.get_columns(table)
    for c in cols:
        print(
            f"{c['name']:<20} type={c['type']!s:<20} "
            f"nullable={c['nullable']} default={c.get('default')}"
        )
    pk = inspector.get_pk_constraint(table)
    print("PK:", pk)
