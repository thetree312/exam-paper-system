#!/usr/bin/env python3
"""Create PostgreSQL role and database for the Exam-paper backend.

Usage (from backend directory, with virtualenv activated):

    python scripts/setup_postgres_db.py \
        --host localhost \
        --port 5432 \
        --superuser postgres \
        --superuser-password ******** \
        --db exam_paper \
        --user exam_user \
        --password ExamAppPass123!

The script also reads defaults from environment variables so you can simply
configure `.env` once and run:

    python scripts/setup_postgres_db.py

Required env keys (all optional, provide via CLI or env):
    POSTGRES_HOST
    POSTGRES_PORT
    POSTGRES_SUPERUSER
    POSTGRES_SUPERUSER_PASSWORD
    POSTGRES_SUPER_DB (defaults to `postgres`)
    POSTGRES_APP_DB
    POSTGRES_APP_USER
    POSTGRES_APP_PASSWORD
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
import psycopg2
from psycopg2 import sql
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

BASE_DIR = Path(__file__).resolve().parents[1]
ENV_PATH = BASE_DIR / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create PostgreSQL role and database for Exam-paper backend.")
    parser.add_argument("--host", default=os.getenv("POSTGRES_HOST", "localhost"), help="PostgreSQL host")
    parser.add_argument("--port", type=int, default=int(os.getenv("POSTGRES_PORT", "5432")), help="PostgreSQL port")
    parser.add_argument("--superuser", default=os.getenv("POSTGRES_SUPERUSER", "postgres"), help="Superuser name")
    parser.add_argument(
        "--superuser-password",
        default=os.getenv("POSTGRES_SUPERUSER_PASSWORD", ""),
        help="Superuser password (leave empty only if local trust authentication is configured)",
    )
    parser.add_argument(
        "--super-db",
        default=os.getenv("POSTGRES_SUPER_DB", "postgres"),
        help="Database to connect to as superuser (default: postgres)",
    )
    parser.add_argument("--db", default=os.getenv("POSTGRES_APP_DB", "exam_paper"), help="Application database name")
    parser.add_argument("--user", default=os.getenv("POSTGRES_APP_USER", "exam_user"), help="Application role name")
    parser.add_argument(
        "--password",
        default=os.getenv("POSTGRES_APP_PASSWORD", "ExamAppPass123!"),
        help="Application role password (will be created / updated)",
    )
    parser.add_argument(
        "--skip-owner-update",
        action="store_true",
        help="Do not change database owner if database already exists",
    )
    return parser.parse_args()


def connect_superuser(host: str, port: int, dbname: str, user: str, password: str):
    conn = psycopg2.connect(
        host=host,
        port=port,
        dbname=dbname,
        user=user,
        password=password or None,
    )
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    return conn


def ensure_role(cur, role_name: str, role_password: str):
    cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role_name,))
    if cur.fetchone():
        cur.execute(
            sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD %s").format(sql.Identifier(role_name)),
            (role_password,),
        )
        print(f"[info] 角色 '{role_name}' 已存在，已更新密码。")
    else:
        cur.execute(
            sql.SQL("CREATE ROLE {} WITH LOGIN PASSWORD %s").format(sql.Identifier(role_name)),
            (role_password,),
        )
        print(f"[info] 已创建角色 '{role_name}'。")


def ensure_database(cur, db_name: str, owner: str, skip_owner_update: bool):
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
    if cur.fetchone():
        print(f"[info] 数据库 '{db_name}' 已存在。")
        if not skip_owner_update:
            cur.execute(
                sql.SQL("ALTER DATABASE {} OWNER TO {}").format(sql.Identifier(db_name), sql.Identifier(owner))
            )
            print(f"[info] 已将数据库 '{db_name}' 所有者更新为 '{owner}'。")
        return

    cur.execute(
        sql.SQL(
            "CREATE DATABASE {} OWNER {} ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8' TEMPLATE template0"
        ).format(sql.Identifier(db_name), sql.Identifier(owner))
    )
    print(f"[info] 已创建数据库 '{db_name}'，所有者为 '{owner}'。")


def main():
    args = parse_args()

    if not args.password:
        raise SystemExit("应用数据库用户密码不能为空 (POSTGRES_APP_PASSWORD)。")

    if not args.superuser:
        raise SystemExit("必须提供 PostgreSQL 超级用户名称。")

    if not args.superuser_password:
        print("[warn] 未提供 POSTGRES_SUPERUSER_PASSWORD，将尝试无密码连接（仅适用于 trust 认证）。")

    print(
        f"[info] Connecting to host={args.host} port={args.port} db={args.super_db} as superuser '{args.superuser}'"
    )

    try:
        with connect_superuser(
            host=args.host,
            port=args.port,
            dbname=args.super_db,
            user=args.superuser,
            password=args.superuser_password,
        ) as conn:
            with conn.cursor() as cur:
                ensure_role(cur, args.user, args.password)
                ensure_database(cur, args.db, args.user, args.skip_owner_update)
    except psycopg2.Error as exc:
        raise SystemExit(f"[error] 无法连接或执行操作: {exc}") from exc

    print("[done] PostgreSQL 初始化完成。以下 DATABASE_URL 可写入 .env：")
    print(
        f"postgresql+psycopg2://{args.user}:{args.password}@{args.host}:{args.port}/{args.db}"
    )


if __name__ == "__main__":
    main()
