import os
from urllib.parse import quote_plus
from functools import lru_cache
from typing import Optional

from dotenv import load_dotenv


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(BASE_DIR, ".env")
if os.path.exists(ENV_PATH):
    load_dotenv(ENV_PATH)


class Settings:
    def __init__(self) -> None:
        self.mysql_host: str = os.getenv("MYSQL_HOST", "localhost")
        self.mysql_port: int = int(os.getenv("MYSQL_PORT", "3306"))
        self.mysql_user: str = os.getenv("MYSQL_USER", "root")
        self.mysql_password: str = os.getenv("MYSQL_PASSWORD", "")
        self.mysql_db: str = os.getenv("MYSQL_DB", "exam_paper")

        raw_url = os.getenv("DATABASE_URL", "").strip()
        if raw_url:
            self.database_url: str = raw_url
        else:
            user_enc = quote_plus(self.mysql_user)
            pwd_enc = quote_plus(self.mysql_password)
            db_enc = quote_plus(self.mysql_db)
            self.database_url: str = (
                f"mysql+pymysql://{user_enc}:{pwd_enc}"
                f"@{self.mysql_host}:{self.mysql_port}/{db_enc}?charset=utf8mb4"
            )
        self.agent_checkpoint_postgres_url: str = os.getenv(
            "AGENT_CHECKPOINT_POSTGRES_URL", self.database_url
        ).strip()
        self.agent_checkpoint_setup_on_boot: bool = (
            os.getenv("AGENT_CHECKPOINT_SETUP_ON_BOOT", "true").strip().lower() == "true"
        )

        self.ms_base_url: str = os.getenv(
            "PHONE_AGENT_BASE_URL", "https://api-inference.modelscope.cn/v1"
        ).rstrip("/")
        self.ms_api_key: Optional[str] = os.getenv("PHONE_AGENT_API_KEY")
        self.ms_vl_model: str = os.getenv(
            "MS_VL_MODEL_ID", "Qwen/Qwen3-VL-30B-A3B-Instruct"
        )

        raw_alibaba_base = os.getenv(
            "ALIBABA_BASE_URL", "https://dashscope.aliyuncs.com"
        ).strip()
        suffix = "/compatible-mode/v1"
        if raw_alibaba_base.endswith(suffix):
            raw_alibaba_base = raw_alibaba_base[: -len(suffix)]
        self.alibaba_base_url: str = raw_alibaba_base.rstrip("/")
        self.alibaba_api_key: Optional[str] = os.getenv("ALIBABA_API_KEY")
        self.alibaba_model_qwen_flash: str = os.getenv(
            "ALIBABA_MODEL_QWEN_FLASH", "qwen-flash"
        )
        self.alibaba_model_qwen_plus: str = os.getenv(
            "ALIBABA_MODEL_QWEN_PLUS", "qwen3.5-plus"
        )
        self.alibaba_model_qwen_long: str = os.getenv(
            "ALIBABA_MODEL_QWEN_LONG", "qwen-long"
        )
        self.alibaba_model_qwen_mindmap_expand: str = os.getenv(
            "ALIBABA_MODEL_QWEN_MINDMAP_EXPAND", self.alibaba_model_qwen_flash
        )
        self.alibaba_explicit_cache_enabled: bool = (
            os.getenv("ALIBABA_EXPLICIT_CACHE_ENABLED", "true").strip().lower() == "true"
        )
        self.alibaba_session_cache_enabled: bool = (
            os.getenv("ALIBABA_SESSION_CACHE_ENABLED", "true").strip().lower() == "true"
        )
        # 便宜/快速路由与总结模型（例如 qwen-turbo 或 qwen-flash）
        self.alibaba_model_qwen_turbo: str = os.getenv(
            "ALIBABA_MODEL_QWEN_TURBO", self.alibaba_model_qwen_flash
        )
        self.alibaba_enable_thinking: bool = (
            os.getenv("ALIBABA_ENABLE_THINKING", "true").strip().lower() == "true"
        )
        self.alibaba_thinking_budget: int = int(
            os.getenv("ALIBABA_THINKING_BUDGET", "2048")
        )

        # 向量化/embedding 模型配置（用于对话长期记忆等场景）
        self.alibaba_model_embedding: str = os.getenv(
            "ALIBABA_MODEL_EMBEDDING", "tongyi-embedding-vision-flash"
        )
        # 默认维度与 pgvector 列保持一致；如需变更，请同步更新 DDL
        self.alibaba_embedding_dimensions: int = int(
            os.getenv("ALIBABA_EMBEDDING_DIMENSIONS", "768")
        )

        self.siliconflow_base_url: str = os.getenv(
            "SILICONFLOW_BASE_URL", "https://api.siliconflow.cn/v1"
        ).rstrip("/")
        self.siliconflow_api_key: Optional[str] = os.getenv("SILICONFLOW_API_KEY")

        # Zhipu GLM-OCR 配置
        self.zhipu_api_key: Optional[str] = os.getenv("ZHIPU_API_KEY")
        layout_url = (
            os.getenv("ZHIPU_LAYOUT_URL")
            or os.getenv("ZHIPU_BASE_URL")
            or "https://open.bigmodel.cn/api/paas/v4/layout_parsing"
        ).strip()
        if layout_url.rstrip("/").endswith("chat/completions"):
            layout_url = "https://open.bigmodel.cn/api/paas/v4/layout_parsing"
        self.zhipu_layout_url: str = layout_url
        self.zhipu_model_glm_ocr: str = (
            os.getenv("ZHIPU_MODEL_GLM_OCR", "glm-ocr").strip() or "glm-ocr"
        )
        self.asset_transport_mode: str = (
            os.getenv("ASSET_TRANSPORT_MODE", "base64").strip().lower() or "base64"
        )
        self.public_asset_base_url: str = (
            os.getenv("PUBLIC_ASSET_BASE_URL", "").strip().rstrip("/")
        )
        self.page_layout_schema_version: str = (
            os.getenv("PAGE_LAYOUT_SCHEMA_VERSION", "v1").strip() or "v1"
        )
        self.glm_layout_max_concurrency: int = int(
            os.getenv("GLM_LAYOUT_MAX_CONCURRENCY", "2")
        )
        self.glm_layout_lease_seconds: int = int(
            os.getenv("GLM_LAYOUT_LEASE_SECONDS", "180")
        )

        # Redis / Celery 配置
        self.redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/1")
        self.celery_queue_preview: str = (
            os.getenv("CELERY_QUEUE_PREVIEW", "exam_preview").strip() or "exam_preview"
        )
        self.celery_queue_glm_layout: str = (
            os.getenv("CELERY_QUEUE_GLM_LAYOUT", "exam_glm_layout").strip() or "exam_glm_layout"
        )
        self.celery_queue_embed: str = (
            os.getenv("CELERY_QUEUE_EMBED", "exam_embed").strip() or "exam_embed"
        )

        # CORS 配置
        self.environment: str = os.getenv("ENVIRONMENT", "development")
        self.frontend_url: str = os.getenv("FRONTEND_URL", "http://localhost:5173")
        self.allowed_origins: list[str] = self._parse_allowed_origins()
        self.enable_word_uploads: bool = (
            os.getenv("ENABLE_WORD_UPLOADS", "false").strip().lower() == "true"
        )
        self.max_request_bytes: int = int(
            os.getenv("MAX_REQUEST_BYTES", str(300 * 1024 * 1024))
        )
        self.max_upload_bytes: int = int(
            os.getenv("MAX_UPLOAD_BYTES", str(300 * 1024 * 1024))
        )
        self.bailian_file_retention_days: int = int(
            os.getenv("BAILIAN_FILE_RETENTION_DAYS", "30")
        )
        self.bailian_file_cleanup_batch_size: int = int(
            os.getenv("BAILIAN_FILE_CLEANUP_BATCH_SIZE", "200")
        )
        self.mindmap_outline_concurrency: int = int(
            os.getenv("MINDMAP_OUTLINE_CONCURRENCY", "4")
        )
        self.mindmap_expand_retry_limit: int = int(
            os.getenv("MINDMAP_EXPAND_RETRY_LIMIT", "2")
        )
        self.mindmap_quality_min_score: float = float(
            os.getenv("MINDMAP_QUALITY_MIN_SCORE", "0.74")
        )

    def _parse_allowed_origins(self) -> list[str]:
        """解析允许的来源列表"""
        if self.environment == "development":
            return ["*"]
        
        # 生产环境：从环境变量读取，支持多个域名用逗号分隔
        origins_str = os.getenv("ALLOWED_ORIGINS", self.frontend_url)
        return [origin.strip() for origin in origins_str.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
