import pathlib
import sys

from sqlalchemy import create_engine, text


def main() -> None:
    root = pathlib.Path(__file__).resolve().parents[1]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    from app.config import get_settings  # noqa: WPS433

    settings = get_settings()
    engine = create_engine(settings.database_url)

    sql_path = root / "db/migrations/20250108_add_document_mindmap_cache.sql"
    if not sql_path.exists():
        raise FileNotFoundError(f"SQL migration not found: {sql_path}")

    statement = sql_path.read_text(encoding="utf-8")

    with engine.begin() as conn:
        conn.execute(text(statement))

    print("✅ documents.mindmap_cache columns added.")


if __name__ == "__main__":
    main()
