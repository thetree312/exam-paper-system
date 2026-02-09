"""Quick inspection script for GLM-OCR related tables/columns.

Usage:
    # 先进入后端虚拟环境（例如 .venv\Scripts\activate），再运行：
    python scripts/check_glm_cache_schema.py
"""

from __future__ import annotations

from sqlalchemy import create_engine, inspect

from app.config import get_settings


def main() -> None:
    settings = get_settings()
    engine = create_engine(settings.database_url, future=True)
    inspector = inspect(engine)

    keywords = ("glm", "ocr", "layout")
    tables = inspector.get_table_names()
    matched_tables = [t for t in tables if any(k in t.lower() for k in keywords)]

    print("=== 查找包含 GLM/OCR 关键字的表 ===")
    if matched_tables:
        for name in matched_tables:
            print(f"- {name}")
    else:
        print("(未找到)")

    focus_tables = ("documents", "extraction_sessions", "files")
    extra_keywords = keywords + ("cache", "hash", "result")

    print("\n=== 重点表的字段关键字扫描 ===")
    for table in focus_tables:
        if table not in tables:
            print(f"[warn] 表 {table} 不存在")
            continue

        columns = inspector.get_columns(table)
        column_names = [c["name"] for c in columns]
        hits = [c for c in column_names if any(k in c.lower() for k in extra_keywords)]

        print(f"- {table}: total_columns={len(column_names)}")
        if hits:
            for col in hits:
                print(f"  * {col}")
        else:
            print("  (无相关字段)")

    engine.dispose()


if __name__ == "__main__":
    main()
