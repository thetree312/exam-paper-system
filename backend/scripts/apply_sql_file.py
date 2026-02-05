import argparse
import pathlib
import sys

from sqlalchemy import create_engine, text


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply a raw SQL file using app settings.")
    parser.add_argument("sql_file", help="Relative path to the .sql file (e.g. db/migrations/foo.sql)")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parents[1]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    from app.config import get_settings  # noqa: WPS433

    sql_path = (root / args.sql_file).resolve()
    if not sql_path.exists():
        raise FileNotFoundError(f"SQL file not found: {sql_path}")

    settings = get_settings()
    engine = create_engine(settings.database_url)

    statement = sql_path.read_text(encoding="utf-8")
    chunks = [chunk.strip() for chunk in statement.split(";") if chunk.strip()]

    with engine.begin() as conn:
        for chunk in chunks:
            conn.execute(text(chunk))

    print(f"✅ Applied SQL file: {sql_path.relative_to(root)} ({len(chunks)} statements)")


if __name__ == "__main__":
    main()
