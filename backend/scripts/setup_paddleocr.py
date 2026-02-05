#!/usr/bin/env python
"""用于预下载 PaddleOCR 模型并把缓存固定到 backend/paddle_models。"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np


backend_root = Path(__file__).resolve().parents[1]
default_model_dir = backend_root / "paddle_models"
default_model_dir.mkdir(exist_ok=True)
os.environ.setdefault("PADDLEOCR_HOME", str(default_model_dir))
os.environ.setdefault("PPOCR_HOME", str(default_model_dir))


def _ensure_numpy_compatible() -> None:
    major = int(np.__version__.split('.')[0])
    if major >= 2:
        raise RuntimeError(
            "当前 numpy=={version} 与 PaddleOCR 依赖的 OpenCV ABI 不兼容，请先执行"
            " `pip install numpy==1.26.4` 再运行本脚本。".format(version=np.__version__)
        )


_ensure_numpy_compatible()

from paddleocr import PaddleOCR


def ensure_local_model_home(custom_dir: str | None = None) -> Path:
    """返回项目内的模型目录并设置环境变量。"""
    model_dir = Path(custom_dir) if custom_dir else default_model_dir
    model_dir.mkdir(parents=True, exist_ok=True)
    resolved = str(model_dir.resolve())
    os.environ["PADDLEOCR_HOME"] = resolved
    os.environ["PPOCR_HOME"] = resolved
    return model_dir


def download_models(lang: str, use_gpu: bool) -> None:
    model_dir = ensure_local_model_home()
    print(f"PaddleOCR 模型将缓存到: {model_dir}")

    # 初始化一次即可触发对应语言的模型下载
    PaddleOCR(lang=lang, use_gpu=use_gpu)
    print("模型准备完成，可在相同目录复用缓存。")


def main() -> None:
    parser = argparse.ArgumentParser(description="初始化 PaddleOCR 本地模型缓存")
    parser.add_argument("--lang", default="ch", help="模型语言，默认中文 ch")
    parser.add_argument(
        "--use-gpu",
        action="store_true",
        help="若机器已正确安装 GPU 版 paddlepaddle，可加上该参数",
    )
    parser.add_argument(
        "--model-dir",
        help="自定义缓存目录（默认为 backend/paddle_models）",
    )
    args = parser.parse_args()

    ensure_local_model_home(args.model_dir)
    download_models(lang=args.lang, use_gpu=args.use_gpu)


if __name__ == "__main__":
    main()
