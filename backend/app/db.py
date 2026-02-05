from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from sqlalchemy.pool import QueuePool

from .config import get_settings


settings = get_settings()


class Base(DeclarativeBase):
    pass


# 配置连接池以支持并发请求
# pool_size: 连接池大小（默认连接数）
# max_overflow: 最多额外连接数（超过 pool_size 时）
# pool_pre_ping: 检查连接是否有效
# pool_recycle: 连接回收时间（秒），防止连接超时
engine = create_engine(
    settings.database_url,
    poolclass=QueuePool,
    pool_size=20,
    max_overflow=10,
    pool_pre_ping=True,
    pool_recycle=3600,
    future=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
