#!/usr/bin/env python3
"""List current MySQL tables using env MYSQL_* (ignores DATABASE_URL).

Usage (from backend dir, venv activated):
    python scripts/list_mysql_tables.py
"""
from __future__ import annotations

from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect

BASE_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

import os

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

insp = inspect(engine)
tables = sorted(insp.get_table_names())
print(f"TOTAL TABLES: {len(tables)}")
for name in tables:
    print(f"- {name}")
