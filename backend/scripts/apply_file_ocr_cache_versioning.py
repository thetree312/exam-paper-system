"""Apply the 20250209 file_ocr_cache versioning migration.

Usage:
    # 先进入 backend 虚拟环境（例如 .venv\Scripts\activate）
    # 确保设置好 DATABASE_URL（与 FastAPI 共用的配置）
    python scripts/apply_file_ocr_cache_versioning.py
"""

from __future__ import annotations

import argparse
import pathlib
import sys

BASE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app.config import get_settings
from sqlalchemy import create_engine

MIGRATION_PATH = BASE_DIR / "db" / "migrations" / "20250209_add_file_ocr_cache_versioning.sql"


def run_sql(sql_file: pathlib.Path) -> None:
    settings = get_settings()
    database_url = settings.database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL 未配置，无法执行迁移")

    script = sql_file.read_text(encoding="utf-8")
    statements = [stmt.strip() for stmt in script.split(";") if stmt.strip()]

    engine = create_engine(database_url, future=True)
    print(f"[migration] using DATABASE_URL={database_url}")
    print(f"[migration] executing {len(statements)} statements from {sql_file}")
    with engine.begin() as conn:
        for stmt in statements:
            conn.exec_driver_sql(stmt)


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply file_ocr_cache versioning migration")
    parser.add_argument(
        "--sql",
        type=pathlib.Path,
        default=MIGRATION_PATH,
        help="自定义 SQL 路径（默认指向 20250209 脚本）",
    )
    args = parser.parse_args()

    if not args.sql.exists():
        raise FileNotFoundError(f"SQL 文件不存在: {args.sql}")

    run_sql(args.sql)


if __name__ == "__main__":
    main()
