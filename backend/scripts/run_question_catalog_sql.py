#!/usr/bin/env python3
"""运行 question_catalogs 建表 SQL 的小工具。

示例：
    cd backend
    .venv\\Scripts\\activate
    python scripts/run_question_catalog_sql.py

如需执行其他 SQL，可指定 --file。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 把 backend 根目录加入 sys.path，才能复用现有配置/数据库模块
BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import text

from app.config import get_settings
from app.db import engine

DEFAULT_SQL_FILE = BACKEND_DIR / "db" / "migrations" / "20260214_add_question_catalogs.sql"


def split_sql_statements(sql_content: str) -> list[str]:
    """简易切分 SQL 语句，去掉空行和注释。"""
    statements: list[str] = []
    for chunk in sql_content.split(';'):
        lines = []
        for raw_line in chunk.splitlines():
            stripped = raw_line.strip()
            if not stripped or stripped.startswith('--'):
                continue
            lines.append(raw_line)
        statement = '\n'.join(lines).strip()
        if statement:
            statements.append(statement)
    return statements


def execute_sql_file(sql_path: Path) -> None:
    if not sql_path.exists():
        raise FileNotFoundError(f"SQL 文件不存在: {sql_path}")

    sql_content = sql_path.read_text(encoding='utf-8')
    statements = split_sql_statements(sql_content)

    if not statements:
        print(f"⚠️  文件 {sql_path.name} 未检测到可执行 SQL")
        return

    print(f"📝 开始执行 {sql_path} (共 {len(statements)} 条语句)")
    with engine.begin() as conn:
        for idx, statement in enumerate(statements, 1):
            print(f"  -> 语句 {idx}/{len(statements)}: ", end='')
            conn.execute(text(statement))
            print("✅ 完成")
    print("✅ SQL 执行完成")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="执行指定 SQL 文件（默认 question_catalogs 建表脚本）")
    parser.add_argument(
        "--file",
        dest="sql_file",
        type=str,
        help="要执行的 SQL 文件路径，默认为 db/migrations/20260214_add_question_catalogs.sql",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sql_file = Path(args.sql_file).resolve() if args.sql_file else DEFAULT_SQL_FILE

    settings = get_settings()
    print(f"📌 数据库: {settings.database_url}")
    execute_sql_file(sql_file)


if __name__ == "__main__":
    main()
