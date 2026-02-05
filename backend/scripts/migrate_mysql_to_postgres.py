#!/usr/bin/env python3
"""Migrate data from MySQL to PostgreSQL using SQLAlchemy.

Usage (from backend dir, venv activated):
    python scripts/migrate_mysql_to_postgres.py [--truncate]

Env requirements:
    MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DB
    DATABASE_URL (PostgreSQL destination)
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Dict, Iterable, List

from dotenv import load_dotenv
from urllib.parse import quote_plus

from sqlalchemy import MetaData, Table, create_engine, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.inspection import inspect

BASE_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

# Tables must be migrated in dependency order (parents first)
TABLE_ORDER: List[str] = [
    "tenants",
    "plans",
    "subscriptions",
    "users",
    "social_accounts",
    "files",
    "extraction_sessions",
    "documents",
    "agent_sessions",
    "agent_messages",
    "questions",
    "extracted_items",
    "fulltext_blocks",
    "mindmaps",
    "question_types",
    "subjects",
    "tags",
    "question_favorites",
    "favorite_tags",
    "profile_events",
    "schema_migrations",
]

# Columns that should be parsed as JSON before inserting into PostgreSQL JSON/JSONB fields
JSON_COLUMNS: Dict[str, List[str]] = {
    "questions": ["versions"],
    "mindmaps": ["graph_json"],
    "agent_sessions": ["profile_json"],
    "profile_events": ["payload"],
}

# Columns stored as TEXT/VARCHAR that should contain JSON strings (ensure serialized)
TEXT_JSON_COLUMNS: Dict[str, List[str]] = {
    "plans": ["features"],
    "questions": ["legend_images"],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate data from MySQL to PostgreSQL")
    parser.add_argument("--chunk", type=int, default=1000, help="Number of rows per insert batch")
    parser.add_argument("--truncate", action="store_true", help="Truncate PostgreSQL tables before migrating")
    return parser.parse_args()


def build_mysql_engine() -> Engine:
    host = os.getenv("MYSQL_HOST", "localhost")
    port = int(os.getenv("MYSQL_PORT", "3306"))
    user = os.getenv("MYSQL_USER", "root")
    password = os.getenv("MYSQL_PASSWORD", "")
    db = os.getenv("MYSQL_DB", "exam_paper")

    url = (
        f"mysql+pymysql://{quote_plus(user)}:{quote_plus(password)}"
        f"@{host}:{port}/{quote_plus(db)}?charset=utf8mb4"
    )
    return create_engine(url, future=True)


def build_postgres_engine() -> Engine:
    url = os.getenv("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL 未设置，无法连接 PostgreSQL")
    return create_engine(url, future=True)


def chunked_rows(rows: Iterable[Dict], chunk_size: int) -> Iterable[List[Dict]]:
    batch: List[Dict] = []
    for row in rows:
        batch.append(row)
        if len(batch) >= chunk_size:
            yield batch
            batch = []
    if batch:
        yield batch


def normalize_row(table: str, row: Dict) -> Dict:
    data = dict(row)
    for col in JSON_COLUMNS.get(table, []):
        val = data.get(col)
        if isinstance(val, (str, bytes)) and val:
            try:
                data[col] = json.loads(val)
            except json.JSONDecodeError:
                data[col] = val
    if table == "profile_events" and "processed" in data:
        data["processed"] = bool(data["processed"])

    for col in TEXT_JSON_COLUMNS.get(table, []):
        val = data.get(col)
        if isinstance(val, (dict, list)):
            data[col] = json.dumps(val)
    return data


def truncate_tables(pg_engine: Engine):
    with pg_engine.begin() as conn:
        for table in reversed(TABLE_ORDER):
            conn.execute(text(f'TRUNCATE TABLE "{table}" RESTART IDENTITY CASCADE'))
    print("[info] 已清空 PostgreSQL 中的目标表。")


def reset_sequence(pg_engine: Engine, table: Table):
    if "id" not in table.c:
        return
    seq_sql = text("SELECT pg_get_serial_sequence(:tbl, 'id')")
    with pg_engine.begin() as conn:
        seq_name = conn.execute(seq_sql, {"tbl": table.name}).scalar()
        if seq_name:
            conn.execute(
                text(
                    f"SELECT setval('{seq_name}', COALESCE(MAX(id), 0) + 1, true) FROM \"{table.name}\""
                )
            )


def migrate_table(mysql_engine: Engine, pg_engine: Engine, table_name: str, chunk_size: int):
    mysql_meta = MetaData()
    pg_meta = MetaData()
    mysql_table = Table(table_name, mysql_meta, autoload_with=mysql_engine)
    pg_table = Table(table_name, pg_meta, autoload_with=pg_engine)

    mysql_inspector = inspect(mysql_engine)
    pk_info = mysql_inspector.get_pk_constraint(table_name)
    pk_cols = pk_info.get("constrained_columns") or []

    stmt = select(mysql_table)
    if pk_cols:
        stmt = stmt.order_by(*[mysql_table.c[col] for col in pk_cols])

    total = 0
    with mysql_engine.connect() as mysql_conn, pg_engine.begin() as pg_conn:
        result = mysql_conn.execute(stmt)
        rows_iter = (normalize_row(table_name, dict(row)) for row in result.mappings())
        for batch in chunked_rows(rows_iter, chunk_size):
            pg_conn.execute(pg_table.insert(), batch)
            total += len(batch)
    reset_sequence(pg_engine, pg_table)
    print(f"[done] {table_name}: migrated {total} rows")


def main():
    args = parse_args()
    mysql_engine = build_mysql_engine()
    pg_engine = build_postgres_engine()

    if args.truncate:
        truncate_tables(pg_engine)

    try:
        for table in TABLE_ORDER:
            migrate_table(mysql_engine, pg_engine, table, args.chunk)
    except SQLAlchemyError as exc:
        raise SystemExit(f"[error] 迁移失败: {exc}") from exc

    print("[success] MySQL -> PostgreSQL 迁移完成。")


if __name__ == "__main__":
    main()
