import os

from celery import Celery

from .config import get_settings


settings = get_settings()

# 允许通过环境变量覆盖，默认读取 Settings.redis_url
redis_url = os.getenv("REDIS_URL", settings.redis_url)

celery_app = Celery(
    "exam_paper_backend",
    broker=redis_url,
    backend=redis_url,
)

# 基本配置，可以按需再细化
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="Asia/Shanghai",
    enable_utc=True,
    task_default_queue="exam_preview",
)

# 明确包含任务模块，避免 worker 无法识别自定义任务
celery_app.conf.update(include=["app.tasks"])
