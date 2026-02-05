#!/usr/bin/env python3
"""Initialize PostgreSQL schema based on current SQLAlchemy models.

Usage (from backend directory, virtualenv activated):

    python scripts/init_postgres_schema.py \
        --database-url postgresql+psycopg2://exam_user:...@localhost:5432/exam_paper_dev

If --database-url is omitted, the script reads `.env` via app.config and uses
whatever DATABASE_URL (or fallback MySQL URL) is configured there. Therefore,
when initializing PostgreSQL you should temporarily point DATABASE_URL to the
PostgreSQL DSN before running this script.

Optional flags:
    --drop-existing   Drop all tables before creating them (use with caution!)
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

BASE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE_DIR))
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)

# Import models so that metadata is populated
from app import models  # noqa: F401
from app.config import get_settings
from app.db import Base, engine as default_engine


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create PostgreSQL schema from SQLAlchemy models")
    parser.add_argument(
        "--database-url",
        default=os.getenv("DATABASE_URL", ""),
        help="Override database URL (otherwise use app.config Settings)",
    )
    parser.add_argument(
        "--drop-existing",
        action="store_true",
        help="Drop all tables before creating them (DANGEROUS, only for clean environments)",
    )
    return parser.parse_args()


def resolve_engine(database_url: str) -> Engine:
    if database_url:
        print(f"[info] 使用传入的 --database-url 参数连接: {database_url}")
        return create_engine(database_url, future=True)

    settings = get_settings()
    print(f"[info] 使用 app.config 中的 settings.database_url: {settings.database_url}")
    return default_engine


def describe_tables(engine: Engine):
    with engine.connect() as conn:
        result = conn.execute(
            text(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                ORDER BY table_name
                """
            )
        )
        tables = [row[0] for row in result]
        print(f"[info] 当前库共有 {len(tables)} 张表：")
        for name in tables:
            print(f"       - {name}")


def main():
    args = parse_args()
    engine = resolve_engine(args.database_url)

    if args.drop_existing:
        confirm = input("[warn] 确认要删除当前数据库内所有由 Base.metadata 管理的表吗？(yes/NO): ")
        if confirm.strip().lower() == "yes":
            print("[info] 正在删除现有表...")
            Base.metadata.drop_all(bind=engine)
        else:
            print("[info] 取消删除操作，仅执行 create_all。")

    print("[info] 开始根据 SQLAlchemy 模型创建表...")
    Base.metadata.create_all(bind=engine)
    print("[done] 所有模型表已创建。")

    try:
        describe_tables(engine)
    except Exception as exc:  # pragma: no cover
        print(f"[warn] 无法列出信息架构表: {exc}")


if __name__ == "__main__":
    main()
