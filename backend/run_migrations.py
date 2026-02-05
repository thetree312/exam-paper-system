#!/usr/bin/env python3
"""
数据库迁移脚本执行工具
用法：在后端虚拟环境中运行
  cd backend
  source .venv/bin/activate  # Linux/Mac
  python run_migrations.py
"""

import sys
import os
import argparse
from pathlib import Path

# 添加后端目录到 Python 路径
backend_dir = Path(__file__).parent
sys.path.insert(0, str(backend_dir))

from app.config import get_settings
from app.db import engine
from sqlalchemy import text


def print_section(title):
    """打印分隔符"""
    print(f"\n{'='*80}")
    print(f"  {title}")
    print(f"{'='*80}\n")


def read_sql_file(file_path):
    """读取 SQL 文件内容"""
    with open(file_path, 'r', encoding='utf-8') as f:
        return f.read()


def split_sql_statements(sql_content: str):
    """粗略拆分 SQL 文件，过滤注释与空行，避免注释挡在语句前被整体跳过。"""
    statements = []
    for raw in sql_content.split(';'):
        lines = []
        for line in raw.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith('--'):
                continue
            lines.append(line)
        statement = '\n'.join(lines).strip()
        if statement:
            statements.append(statement)
    return statements


def execute_migration(migration_file):
    """执行单个迁移脚本"""
    file_name = Path(migration_file).name
    print(f"📝 执行迁移: {file_name}")
    
    try:
        sql_content = read_sql_file(migration_file)
        statements = split_sql_statements(sql_content)
        
        with engine.connect() as conn:
            for i, statement in enumerate(statements, 1):
                # 跳过注释行
                if statement.startswith('--'):
                    continue
                
                print(f"  执行语句 {i}/{len(statements)}...", end=' ')
                try:
                    conn.execute(text(statement))
                    conn.commit()
                    print("✅")
                except Exception as e:
                    print(f"❌ 错误: {e}")
                    raise
        
        print(f"✅ 迁移 {file_name} 完成\n")
        return True
        
    except Exception as e:
        print(f"❌ 迁移 {file_name} 失败: {e}\n")
        return False


def parse_args():
    parser = argparse.ArgumentParser(
        description="数据库迁移执行工具。默认执行预设列表，可通过参数指定 SQL 文件。"
    )
    parser.add_argument(
        "files",
        nargs="*",
        help="要执行的 SQL 文件路径（可为绝对路径，或相对于 backend/ / backend/db/migrations/ 的相对路径）",
    )
    return parser.parse_args()


def resolve_migration_paths(selected_files):
    """根据用户输入解析迁移文件路径"""
    if not selected_files:
        return None

    resolved = []
    migrations_dir = backend_dir / "db" / "migrations"

    for raw in selected_files:
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate_backend = backend_dir / candidate
            candidate_migrations = migrations_dir / candidate

            if candidate_backend.exists():
                candidate = candidate_backend
            else:
                candidate = candidate_migrations

        resolved.append(candidate)

    return resolved


def main():
    """主函数"""
    args = parse_args()
    print("\n" + "="*80)
    print("  数据库迁移执行工具")
    print("="*80)
    
    try:
        settings = get_settings()
        print(f"\n📌 数据库连接字符串: {settings.database_url}")
        
        # 测试连接
        with engine.connect() as conn:
            print("✅ 数据库连接成功\n")
        
        # 迁移文件列表（按时间顺序执行）
        migrations_dir = backend_dir / "db" / "migrations"
        default_migration_files = [
            migrations_dir / "20250116_create_question_favorites.sql",
            migrations_dir / "20250116_add_max_favorite_questions_to_plans.sql",
            migrations_dir / "20250118_add_favorite_metadata.sql",
            migrations_dir / "20250118_add_favorite_metadata_fk.sql",
            migrations_dir / "20250120_add_agent_session_meta.sql",
        ]

        selected_paths = resolve_migration_paths(args.files)
        if selected_paths is None:
            migration_files = default_migration_files
            print("📚 未指定文件，执行默认迁移列表。\n")
        else:
            migration_files = selected_paths
            print("🎯 仅执行指定迁移文件：")
            for path in migration_files:
                print(f"  - {path}")
            print()
        
        print_section("开始执行迁移")
        
        failed_migrations = []
        for migration_file in migration_files:
            if not migration_file.exists():
                print(f"❌ 文件不存在: {migration_file}")
                failed_migrations.append(migration_file.name)
                continue
            
            if not execute_migration(migration_file):
                failed_migrations.append(migration_file.name)
        
        print_section("迁移完成")
        
        if failed_migrations:
            print(f"❌ 有 {len(failed_migrations)} 个迁移失败:")
            for name in failed_migrations:
                print(f"  - {name}")
            sys.exit(1)
        else:
            print("✅ 所有迁移执行成功！\n")
            sys.exit(0)
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
