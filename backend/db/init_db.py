import os
from pathlib import Path

import pymysql
from dotenv import load_dotenv


def load_config():
    project_root = Path(__file__).resolve().parents[1]
    dotenv_path = project_root / ".env"
    if dotenv_path.exists():
        load_dotenv(dotenv_path)

    config = {
        "host": os.getenv("MYSQL_HOST", "localhost"),
        "port": int(os.getenv("MYSQL_PORT", "3306")),
        "user": os.getenv("MYSQL_USER", "root"),
        "password": os.getenv("MYSQL_PASSWORD", ""),
        "database": os.getenv("MYSQL_DB", "exam_paper"),
    }
    return config


def load_schema(database_name: str) -> list[str]:
    schema_path = Path(__file__).with_name("schema.sql")
    sql_text = schema_path.read_text(encoding="utf-8")
    sql_text = sql_text.replace("exam_paper", database_name)

    statements = [stmt.strip() for stmt in sql_text.split(";") if stmt.strip()]
    return statements


def apply_schema(config: dict):
    connection = pymysql.connect(
        host=config["host"],
        port=config["port"],
        user=config["user"],
        password=config["password"],
        autocommit=True,
    )
    try:
        with connection.cursor() as cursor:
            for statement in load_schema(config["database"]):
                cursor.execute(statement)
    finally:
        connection.close()


def main():
    config = load_config()
    apply_schema(config)
    print(f"Database schema applied for '{config['database']}'.")


if __name__ == "__main__":
    main()
