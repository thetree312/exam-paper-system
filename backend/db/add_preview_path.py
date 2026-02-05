import os
from pathlib import Path

import pymysql
from dotenv import load_dotenv


def load_config() -> dict:
    project_root = Path(__file__).resolve().parents[1]
    dotenv_path = project_root / ".env"
    if dotenv_path.exists():
        load_dotenv(dotenv_path)

    return {
        "host": os.getenv("MYSQL_HOST", "localhost"),
        "port": int(os.getenv("MYSQL_PORT", "3306")),
        "user": os.getenv("MYSQL_USER", "root"),
        "password": os.getenv("MYSQL_PASSWORD", ""),
        "database": os.getenv("MYSQL_DB", "exam_paper"),
    }


def ensure_preview_path_column(cfg: dict) -> None:
    ddl = """
    ALTER TABLE files
      ADD COLUMN preview_path VARCHAR(512) NULL AFTER storage_path;
    """

    connection = pymysql.connect(
        host=cfg["host"],
        port=cfg["port"],
        user=cfg["user"],
        password=cfg["password"],
        database=cfg["database"],
        autocommit=True,
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute("SHOW COLUMNS FROM files LIKE 'preview_path';")
            exists = cursor.fetchone()
            if exists:
                print("[skip] preview_path already exists on files table.")
                return

            cursor.execute(ddl)
            print("[ok] preview_path column added to files table.")
    finally:
        connection.close()


if __name__ == "__main__":
    config = load_config()
    ensure_preview_path_column(config)
