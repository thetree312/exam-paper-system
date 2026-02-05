#!/usr/bin/env python3
"""
数据库结构检查脚本
用法：在后端虚拟环境中运行
  cd backend
  source .venv/bin/activate  # Linux/Mac
  python inspect_db_schema.py
"""

import sys
import os
from pathlib import Path

# 添加后端目录到 Python 路径
backend_dir = Path(__file__).parent
sys.path.insert(0, str(backend_dir))

from app.config import get_settings
from app.db import engine
from sqlalchemy import inspect, text


def print_section(title):
    """打印分隔符"""
    print(f"\n{'='*80}")
    print(f"  {title}")
    print(f"{'='*80}\n")


def inspect_tables():
    """检查所有表的结构"""
    inspector = inspect(engine)
    
    # 获取所有表名
    table_names = inspector.get_table_names()
    print_section(f"数据库中的表 (共 {len(table_names)} 个)")
    
    for table_name in sorted(table_names):
        print(f"\n表名: {table_name}")
        print("-" * 80)
        
        # 获取列信息
        columns = inspector.get_columns(table_name)
        print(f"  列数: {len(columns)}")
        print(f"  {'列名':<25} {'类型':<20} {'可空':<8} {'默认值':<20}")
        print(f"  {'-'*25} {'-'*20} {'-'*8} {'-'*20}")
        
        for col in columns:
            col_name = col['name']
            col_type = str(col['type'])
            nullable = "Y" if col['nullable'] else "N"
            default = str(col['default']) if col['default'] is not None else "-"
            print(f"  {col_name:<25} {col_type:<20} {nullable:<8} {default:<20}")
        
        # 获取主键
        pk = inspector.get_pk_constraint(table_name)
        if pk and pk.get('constrained_columns'):
            print(f"\n  主键: {', '.join(pk['constrained_columns'])}")
        
        # 获取唯一约束
        unique_constraints = inspector.get_unique_constraints(table_name)
        if unique_constraints:
            print("\n  唯一约束:")
            for uc in unique_constraints:
                print(f"    - {uc['name']}: {', '.join(uc['column_names'])}")
        
        # 获取索引
        indexes = inspector.get_indexes(table_name)
        if indexes:
            print("\n  索引:")
            for idx in indexes:
                print(f"    - {idx['name']}: {', '.join(idx['column_names'])}")
        
        # 获取外键
        fks = inspector.get_foreign_keys(table_name)
        if fks:
            print("\n  外键:")
            for fk in fks:
                constrained = ', '.join(fk['constrained_columns'])
                referred = f"{fk['referred_table']}.{', '.join(fk['referred_columns'])}"
                print(f"    - {fk['name']}: {constrained} → {referred}")


def check_question_favorites_table():
    """检查 question_favorites 表是否存在"""
    print_section("检查 question_favorites 表")
    
    inspector = inspect(engine)
    table_names = inspector.get_table_names()
    
    if 'question_favorites' in table_names:
        print("question_favorites 表已存在")
        inspect_tables()
    else:
        print("question_favorites 表不存在")
        print("\n需要执行迁移脚本来创建该表")


def check_plans_table_columns():
    """检查 plans 表是否有 max_favorite_questions 列"""
    print_section("检查 plans 表的 max_favorite_questions 列")
    
    inspector = inspect(engine)
    columns = inspector.get_columns('plans')
    column_names = [col['name'] for col in columns]
    
    if 'max_favorite_questions' in column_names:
        print("max_favorite_questions 列已存在")
        for col in columns:
            if col['name'] == 'max_favorite_questions':
                print(f"  类型: {col['type']}")
                print(f"  可空: {col['nullable']}")
                print(f"  默认值: {col['default']}")
    else:
        print("max_favorite_questions 列不存在")
        print("\n需要执行迁移脚本来添加该列")


def get_db_stats():
    """获取数据库统计信息（支持 MySQL / PostgreSQL）"""
    print_section("数据库统计信息")

    dialect = engine.dialect.name

    with engine.connect() as conn:
        if dialect == "mysql":
            result = conn.execute(text("SELECT DATABASE()"))
            db_name = result.scalar()
            print(f"当前数据库: {db_name}")

            result = conn.execute(
                text(
                    "SELECT COUNT(*) FROM information_schema.tables "
                    "WHERE table_schema = DATABASE()"
                )
            )
            table_count = result.scalar()
            print(f"表数量: {table_count}")

            print("\n各表行数:")
            result = conn.execute(
                text(
                    """
            SELECT TABLE_NAME, TABLE_ROWS 
            FROM information_schema.tables 
            WHERE table_schema = DATABASE()
            ORDER BY TABLE_ROWS DESC
                    """
                )
            )

            for row in result:
                table_name, row_count = row
                print(f"  {table_name:<30} {row_count:>10} 行")

        elif dialect in ("postgresql", "postgres"):
            result = conn.execute(text("SELECT current_database()"))
            db_name = result.scalar()
            print(f"当前数据库: {db_name}")

            result = conn.execute(
                text(
                    """
            SELECT COUNT(*)
            FROM information_schema.tables
            WHERE table_catalog = current_database()
              AND table_schema NOT IN ('pg_catalog', 'information_schema')
                    """
                )
            )
            table_count = result.scalar()
            print(f"📊 表数量: {table_count}")

            print(f"\n📊 各表行数:")
            result = conn.execute(
                text(
                    """
            SELECT relname AS table_name, n_live_tup AS row_count
            FROM pg_stat_user_tables
            ORDER BY n_live_tup DESC
                    """
                )
            )

            for row in result:
                table_name, row_count = row
                print(f"  {table_name:<30} {row_count:>10} 行")

        else:
            print(f"警告: 暂未实现 {dialect} 方言的统计信息查询，跳过统计。")


def main():
    """主函数"""
    print("\n" + "="*80)
    print("  数据库结构检查工具")
    print("="*80)
    
    try:
        settings = get_settings()
        print(f"\n数据库连接字符串: {settings.database_url}")
        
        # 测试连接
        with engine.connect() as conn:
            print("数据库连接成功\n")
        
        # 获取统计信息
        get_db_stats()
        
        # 检查所有表
        inspect_tables()
        
        # 检查特定表
        check_question_favorites_table()
        check_plans_table_columns()
        
        print_section("检查完成")
        print("数据库结构检查完成\n")
        
    except Exception as e:
        print(f"\n错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
