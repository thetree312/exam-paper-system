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
            "ALIBABA_MODEL_QWEN_PLUS", "qwen-flash"
        )
        # 专用视觉模型（例如 qwen3-vl-flash），供多模态视觉 Agent 使用
        self.alibaba_model_qwen_vl_flash: str = os.getenv(
            "ALIBABA_MODEL_QWEN_VL_FLASH", "qwen3-vl-flash"
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

        # Redis / Celery 配置
        self.redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/1")

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
