import argparse
from pathlib import Path
from typing import List

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.config import get_settings


def split_statements(sql_text: str) -> List[str]:
    statements: List[str] = []
    buffer: List[str] = []

    for raw_line in sql_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("--"):
            continue

        buffer.append(line)
        if line.endswith(";"):
            statement = " ".join(buffer).strip()
            if statement.endswith(";"):
                statement = statement[:-1]
            if statement:
                statements.append(statement)
            buffer.clear()

    if buffer:
        statements.append(" ".join(buffer).strip())

    return statements


def apply_schema(schema_path: Path) -> None:
    if not schema_path.exists():
        raise FileNotFoundError(f"Schema file not found: {schema_path}")

    sql_text = schema_path.read_text(encoding="utf-8")
    statements = split_statements(sql_text)

    if not statements:
        raise ValueError(f"No SQL statements parsed from {schema_path}")

    settings = get_settings()
    database_url = settings.database_url
    url = make_url(database_url)
    if not url.database:
        raise ValueError("DATABASE_URL must include a database name.")

    db_name = url.database
    server_engine = create_engine(url.set(database=None))
    db_engine = create_engine(url)

    create_db_statement = next(
        (stmt for stmt in statements if stmt.upper().startswith("CREATE DATABASE")), None
    )
    other_statements = [
        stmt
        for stmt in statements
        if not stmt.upper().startswith("CREATE DATABASE")
        and not stmt.upper().startswith("USE ")
    ]

    if create_db_statement:
        with server_engine.begin() as conn:
            print(f"[server] {create_db_statement}")
            conn.execute(text(create_db_statement))

    with db_engine.begin() as conn:
        for stmt in other_statements:
            print(f"[{db_name}] {stmt}")
            conn.execute(text(stmt))

    print(f"Schema from {schema_path} applied successfully to `{db_name}`.")


def main() -> None:
    default_schema = (
        Path(__file__).resolve().parents[1] / "db" / "schema.sql"
    )
    parser = argparse.ArgumentParser(
        description="Apply schema.sql to the configured MySQL database."
    )
    parser.add_argument(
        "--schema",
        type=Path,
        default=default_schema,
        help=f"Path to schema.sql (default: {default_schema})",
    )
    args = parser.parse_args()
    apply_schema(args.schema)


if __name__ == "__main__":
    main()
