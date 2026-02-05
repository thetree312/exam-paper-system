import os
from functools import lru_cache


class Settings:
    """Minimal configuration manager for the GLM-OCR demo backend."""

    def __init__(self) -> None:
        self.api_key = os.getenv("ZHIPU_API_KEY", "").strip()
        if not self.api_key:
            raise RuntimeError(
                "未检测到 ZHIPU_API_KEY 环境变量，请在后台终端中配置后再启动 demo 后端。"
            )

        # layout_parsing 专用地址，允许用户通过环境变量覆盖
        self.layout_url = (
            os.getenv("ZHIPU_LAYOUT_URL")
            or os.getenv("ZHIPU_BASE_URL")  # 允许沿用用户已有 Base URL
            or "https://open.bigmodel.cn/api/paas/v4/layout_parsing"
        ).strip()
        # 如果提供的是 chat completions 地址，需要自动替换成 layout_parsing
        if self.layout_url.rstrip("/").endswith("chat/completions"):
            self.layout_url = "https://open.bigmodel.cn/api/paas/v4/layout_parsing"

        self.model = os.getenv("ZHIPU_MODEL_GLM_OCR", "glm-ocr").strip() or "glm-ocr"
        self.request_timeout = float(os.getenv("GLM_OCR_TIMEOUT", "120"))
        default_origins = (
            "http://localhost:4173,http://127.0.0.1:4173,http://localhost:5173,null"
        )
        self.allowed_origins = [
            origin.strip()
            for origin in os.getenv("GLM_OCR_ALLOWED_ORIGINS", default_origins).split(",")
            if origin.strip()
        ]


@lru_cache()
def get_settings() -> Settings:
    return Settings()
