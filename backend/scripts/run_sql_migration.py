"""Utility to run a SQL migration file against the configured MySQL database.

Usage:
    python scripts/run_sql_migration.py db/migrations/20240104_add_question_state.sql

The script reads backend/.env (via app.config.Settings) so it always connects to the
same database that the FastAPI app uses. It executes statements sequentially and
stops immediately on the first error.
"""
from __future__ import annotations

import argparse
import pathlib
import sys
from typing import List

import pymysql

# Ensure backend root is on sys.path so "app.config" can be imported no matter
# where this script is launched from.
BACKEND_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import get_settings  # noqa: E402  (import after sys.path tweak)


def parse_sql_statements(raw_sql: str) -> List[str]:
    statements: List[str] = []
    buffer: List[str] = []

    for line in raw_sql.splitlines():
        stripped = line.strip()
        # Skip comments and blank lines
        if not stripped or stripped.startswith("--"):
            continue

        buffer.append(line)
        if line.rstrip().endswith(";"):
            statement = "\n".join(buffer).rstrip().rstrip(";")
            if statement:
                statements.append(statement)
            buffer.clear()

    if buffer:
        statement = "\n".join(buffer).rstrip().rstrip(";")
        if statement:
            statements.append(statement)

    return statements


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a SQL migration file")
    parser.add_argument(
        "sql_file",
        type=pathlib.Path,
        help="Path to the .sql file (e.g. db/migrations/20240104_add_question_state.sql)",
    )
    args = parser.parse_args()

    sql_path = args.sql_file.resolve()
    if not sql_path.is_file():
        raise SystemExit(f"SQL file not found: {sql_path}")

    raw_sql = sql_path.read_text(encoding="utf-8")
    statements = parse_sql_statements(raw_sql)
    if not statements:
        raise SystemExit("No SQL statements detected in file")

    settings = get_settings()

    print(
        "Connecting to MySQL:",
        f"host={settings.mysql_host} port={settings.mysql_port} db={settings.mysql_db}",
    )

    connection = pymysql.connect(
        host=settings.mysql_host,
        port=settings.mysql_port,
        user=settings.mysql_user,
        password=settings.mysql_password,
        database=settings.mysql_db,
        charset="utf8mb4",
        autocommit=False,
    )

    try:
        with connection.cursor() as cursor:
            for stmt in statements:
                print("Executing statement:\n", stmt)
                cursor.execute(stmt)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print("Migration completed successfully.")


if __name__ == "__main__":
    main()
