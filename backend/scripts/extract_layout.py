#!/usr/bin/env python
"""基于 PP-Structure 的版面/图例检测与裁剪脚本。"""
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

try:
    import onnxruntime as ort
except ImportError:  # pragma: no cover - optional dependency
    ort = None

backend_root = Path(__file__).resolve().parents[1]
project_model_dir = backend_root / "paddle_models"
project_model_dir.mkdir(exist_ok=True)
resolved_model_dir = str(project_model_dir.resolve())
os.environ["PADDLEOCR_HOME"] = resolved_model_dir
os.environ["PPOCR_HOME"] = resolved_model_dir
cls_cache_dir = project_model_dir / "paddleclas"
cls_cache_dir.mkdir(exist_ok=True)
os.environ["PADDLECLS_HOME"] = str(cls_cache_dir.resolve())
os.environ["HOME"] = str(project_model_dir.resolve())
os.environ["USERPROFILE"] = str(project_model_dir.resolve())
os.environ["PADDLE_ONEDNN_ENABLE"] = "0"
os.environ["PADDLE_ONEDNN_EMERGENCY"] = "0"
os.environ["FLAGS_use_mkldnn"] = "0"
os.environ["FLAGS_use_pinned_memory"] = "0"
os.environ["FLAGS_enable_paddle_mkldnn"] = "0"
os.environ["FLAGS_cpu_deterministic"] = "1"
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'

from paddleocr import PPStructure  # noqa: E402  pylint: disable=wrong-import-position

LAYOUT_MODEL = project_model_dir / "picodet_lcnet_x1_0_fgd_layout_cdla_infer"
TABLE_MODEL = project_model_dir / "ch_ppstructure_mobile_v2.0_SLANet_infer"
DET_MODEL = project_model_dir / "ch_PP-OCRv4_det_infer"
REC_MODEL = project_model_dir / "ch_PP-OCRv4_rec_infer"
CLS_MODEL = project_model_dir / "ch_ppocr_mobile_v2.0_cls_infer"
ORIENTATION_MODEL_DIR = project_model_dir / "text_image_orientation_infer"
PADDLEDET_LAYOUT_MODEL = project_model_dir / "layout_yolo.onnx"

LAYOUT_LABEL_MAP = {
    0: "text",
    1: "title",
    2: "figure",
    3: "table",
    4: "header",
    5: "footer",
    6: "reference",
    7: "equation",
}


def _ensure_model_dir(path: Path, name: str) -> None:
    mapping = {
        "inference.pdmodel": "model.pdmodel",
        "inference.pdiparams": "model.pdiparams",
        "inference.pdiparams.info": "model.pdiparams.info",
    }
    for inf_name, fallback in mapping.items():
        target = path / inf_name
        if target.exists():
            continue
        fallback_path = path / fallback
        if fallback_path.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(fallback_path, target)
        else:
            raise FileNotFoundError(
                f"{name} 缺少 {inf_name}，请检查 {path}，或确保至少存在 {fallback}"
            )


_ensure_model_dir(LAYOUT_MODEL, "版面检测模型")
_ensure_model_dir(TABLE_MODEL, "表格结构模型")
_ensure_model_dir(DET_MODEL, "文本检测模型")
_ensure_model_dir(REC_MODEL, "文本识别模型")
_ensure_model_dir(CLS_MODEL, "方向分类模型")
_ensure_model_dir(ORIENTATION_MODEL_DIR, "PaddleClas 朝向模型")


class PaddleDetOnnxLayoutDetector:
    """ONNXRuntime 推理 PaddleDetection 布局 YOLO 模型。"""

    def __init__(self, model_path: Path, input_size: int = 640, score_threshold: float = 0.4):
        if ort is None:
            raise RuntimeError("请先安装 onnxruntime：pip install onnxruntime")
        if not model_path.exists():
            raise FileNotFoundError(f"未找到 ONNX 布局模型: {model_path}")
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.input_size = input_size
        self.score_threshold = score_threshold

    def _preprocess(self, image: np.ndarray) -> tuple[np.ndarray, float]:
        h, w = image.shape[:2]
        scale = min(self.input_size / w, self.input_size / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        resized = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((self.input_size, self.input_size, 3), 114, dtype=np.uint8)
        canvas[:nh, :nw] = resized
        blob = canvas.astype("float32") / 255.0
        blob = blob.transpose(2, 0, 1)[None]
        return blob, scale

    def detect(self, image: np.ndarray) -> List[Dict[str, Any]]:
        blob, scale = self._preprocess(image)
        outputs = self.session.run(None, {self.input_name: blob})
        preds = outputs[0]
        results: List[Dict[str, Any]] = []
        for det in preds:
            x1, y1, x2, y2, score, cls_id = det
            if score < self.score_threshold:
                continue
            label = LAYOUT_LABEL_MAP.get(int(cls_id), "unknown")
            x1 = max(0, int(round(x1 / scale)))
            y1 = max(0, int(round(y1 / scale)))
            x2 = int(round(x2 / scale))
            y2 = int(round(y2 / scale))
            results.append({
                "type": label,
                "bbox": [x1, y1, x2, y2],
                "score": float(score),
            })
        return results


def clamp_bbox(bbox: List[float], width: int, height: int) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = map(int, map(round, bbox))
    x1 = max(0, min(x1, width - 1))
    y1 = max(0, min(y1, height - 1))
    x2 = max(x1 + 1, min(x2, width))
    y2 = max(y1 + 1, min(y2, height))
    return x1, y1, x2, y2


def format_markdown(entries: List[Dict[str, Any]], image_path: Path) -> str:
    lines = [
        "# 版面检测摘要",
        "",
        f"来源图片：`{image_path}`",
        "",
    ]
    if not entries:
        lines.append("未检测到任何版面元素。")
        return "\n".join(lines)

    for entry in entries:
        lines.append(f"## {entry['title']}")
        lines.append(f"- 类型：`{entry['type']}`")
        lines.append(
            f"- 坐标：({entry['bbox'][0]}, {entry['bbox'][1]}) - ({entry['bbox'][2]}, {entry['bbox'][3]})"
        )
        lines.append(f"- 裁剪文件：`{entry['crop_path']}`")
        if entry.get("detail_path"):
            lines.append(f"- 结构化结果：`{entry['detail_path']}`")
        if entry.get("texts"):
            lines.append("- OCR 文本：")
            for txt in entry["texts"]:
                lines.append(f"  - {txt}")
        lines.append("")
    return "\n".join(lines).rstrip()


def build_engine(enable_orientation: bool) -> PPStructure:
    return PPStructure(
        image_orientation=enable_orientation,
        layout=True,
        table=True,
        ocr=True,
        ocr_order_method="tb-yx",
        layout_model_dir=str(LAYOUT_MODEL),
        table_model_dir=str(TABLE_MODEL),
        det_model_dir=str(DET_MODEL),
        rec_model_dir=str(REC_MODEL),
        cls_model_dir=str(CLS_MODEL),
    )


def load_image(path: Path) -> np.ndarray:
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"无法读取图片: {path}")
    return img


def detect_with_ppstructure(image_path: Path, enable_orientation: bool) -> List[Dict[str, Any]]:
    engine = build_engine(enable_orientation=enable_orientation)
    return engine(str(image_path))


def detect_with_paddledet(image: np.ndarray, model_path: Path, threshold: float) -> List[Dict[str, Any]]:
    detector = PaddleDetOnnxLayoutDetector(model_path, score_threshold=threshold)
    return detector.detect(image)


def main() -> None:
    parser = argparse.ArgumentParser(description="PP-Structure 版面识别+裁剪")
    parser.add_argument("image", help="待处理的图片路径")
    parser.add_argument(
        "--output-markdown",
        default=str(backend_root / "docs" / "layout_result.md"),
        help="Markdown 输出文件",
    )
    parser.add_argument(
        "--crops-dir",
        default=str(backend_root / "paddle_crops"),
        help="裁剪图片输出目录",
    )
    parser.add_argument(
        "--enable-orientation",
        action="store_true",
        help="开启图片朝向预测（需 PaddleClas 模型，默认关闭以避免额外下载）",
    )
    parser.add_argument(
        "--layout-backend",
        choices=["paddledet", "ppstructure"],
        default="paddledet",
        help="选择版面检测后端，默认使用 PaddleDetection ONNX 模型以规避 OneDNN BUG",
    )
    parser.add_argument(
        "--paddledet-model",
        default=str(PADDLEDET_LAYOUT_MODEL),
        help="PaddleDetection 布局 ONNX 模型路径",
    )
    parser.add_argument(
        "--paddledet-threshold",
        type=float,
        default=0.4,
        help="PaddleDetection 置信度阈值",
    )
    args = parser.parse_args()

    img_path = Path(args.image).resolve()
    if not img_path.exists():
        raise FileNotFoundError(f"图片不存在: {img_path}")

    crops_dir = Path(args.crops_dir).resolve() / img_path.stem
    crops_dir.mkdir(parents=True, exist_ok=True)

    image = load_image(img_path)
    height, width = image.shape[:2]

    if args.layout_backend == "paddledet":
        layout_result = detect_with_paddledet(
            image,
            model_path=Path(args.paddledet_model).resolve(),
            threshold=args.paddledet_threshold,
        )
    else:
        layout_result = detect_with_ppstructure(img_path, enable_orientation=args.enable_orientation)

    entries: List[Dict[str, Any]] = []
    for idx, region in enumerate(layout_result, start=1):
        bbox = region.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        x1, y1, x2, y2 = clamp_bbox(bbox, width, height)
        crop = image[y1:y2, x1:x2]
        crop_path = crops_dir / f"{idx:02d}_{region.get('type', 'unknown')}.png"
        cv2.imwrite(str(crop_path), crop)

        texts: List[str] = []
        detail_path: Optional[str] = None
        res = region.get("res")
        if res and isinstance(res, dict):
            html = res.get("html")
            if html:
                detail_file = crop_path.with_suffix(".html")
                detail_file.write_text(html, encoding="utf-8")
                detail_path = str(detail_file)
        elif isinstance(res, list):
            for line in res:
                if isinstance(line, dict):
                    txt = (line.get("text") or "").strip()
                    if txt:
                        texts.append(txt)

        entries.append(
            {
                "title": f"元素 {idx}",
                "type": region.get("type", "unknown"),
                "bbox": (x1, y1, x2, y2),
                "crop_path": str(crop_path),
                "detail_path": detail_path,
                "texts": texts,
            }
        )

    markdown = format_markdown(entries, img_path)
    output_path = Path(args.output_markdown).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")

    print(markdown)
    print(f"\nMarkdown 输出: {output_path}")
    print(f"裁剪目录: {crops_dir}")


if __name__ == "__main__":
    main()
