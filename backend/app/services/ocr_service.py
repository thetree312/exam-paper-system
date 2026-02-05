import base64
import io
import os
from pathlib import Path
from typing import List
import logging

import requests
from PIL import Image, ImageDraw
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import ExtractionSession, ExtractedItem, File
from ..schemas import Region


settings = get_settings()
logger = logging.getLogger(__name__)

# 裁剪安全边距配置：默认为 0，严格按照前端选区裁剪
CROP_MARGIN_X_RATIO = 0.0  # 水平方向比例边距
CROP_MARGIN_Y_RATIO = 0.0  # 垂直方向比例边距
CROP_MARGIN_MIN_X = 0      # 水平最小边距（像素）
CROP_MARGIN_MIN_Y = 0      # 垂直最小边距（像素）


class OcrService:
    def __init__(self) -> None:
        if not settings.ms_api_key:
            raise RuntimeError("PHONE_AGENT_API_KEY is not set in .env")
        self.base_url = settings.ms_base_url
        self.api_key = settings.ms_api_key
        self.model = settings.ms_vl_model

    def _crop_regions(
        self,
        region_jobs: List[tuple[str, Region]],
        debug_root: Path | None = None,
    ) -> List[tuple[Region, Image.Image]]:
        crops: List[tuple[Region, Image.Image]] = []
        for idx, (image_path, r) in enumerate(region_jobs):
            base_image = Image.open(image_path)
            img = base_image.convert("RGB")
            base_image.close()
            width, height = img.size
            logger.info(
                "[ocr] open image path=%s page=%s size=%sx%s margin_cfg(x_ratio=%.3f,y_ratio=%.3f,min_x=%d,min_y=%d)",
                image_path,
                r.page,
                width,
                height,
                CROP_MARGIN_X_RATIO,
                CROP_MARGIN_Y_RATIO,
                CROP_MARGIN_MIN_X,
                CROP_MARGIN_MIN_Y,
            )

            # 安全边距：在用户选区的基础上上下左右各扩展一点，避免前后端坐标细微误差导致内容被裁掉
            pad_x = max(CROP_MARGIN_MIN_X, int(CROP_MARGIN_X_RATIO * width))
            pad_y = max(CROP_MARGIN_MIN_Y, int(CROP_MARGIN_Y_RATIO * height))

            # 原始像素框
            raw_x1 = int(r.x * width)
            raw_y1 = int(r.y * height)
            raw_x2 = int((r.x + r.width) * width)
            raw_y2 = int((r.y + r.height) * height)

            # 加安全边距后的像素框
            x1 = max(0, min(width, raw_x1 - pad_x))
            y1 = max(0, min(height, raw_y1 - pad_y))
            x2 = max(0, min(width, raw_x2 + pad_x))
            y2 = max(0, min(height, raw_y2 + pad_y))

            logger.info(
                "[ocr] region %d norm=(x=%.3f,y=%.3f,w=%.3f,h=%.3f) raw_pixels=(%d,%d,%d,%d) expanded_pixels=(%d,%d,%d,%d)",
                idx,
                r.x,
                r.y,
                r.width,
                r.height,
                raw_x1,
                raw_y1,
                raw_x2,
                raw_y2,
                x1,
                y1,
                x2,
                y2,
            )
            if x2 <= x1 or y2 <= y1:
                logger.warning("[ocr] skip invalid region %d due to non-positive size", idx)
                continue

            crop = img.crop((x1, y1, x2, y2)).copy()

            # 挖掉排除区域（在裁剪后的局部坐标内填充白色）
            if getattr(r, "exclusions", None):
                draw_crop = ImageDraw.Draw(crop)
                for hole in r.exclusions:
                    hx1 = int(hole.x * width) - x1
                    hy1 = int(hole.y * height) - y1
                    hx2 = int((hole.x + hole.width) * width) - x1
                    hy2 = int((hole.y + hole.height) * height) - y1
                    hx1 = max(0, min(crop.width, hx1))
                    hy1 = max(0, min(crop.height, hy1))
                    hx2 = max(0, min(crop.width, hx2))
                    hy2 = max(0, min(crop.height, hy2))
                    if hx2 > hx1 and hy2 > hy1:
                        draw_crop.rectangle((hx1, hy1, hx2, hy2), fill="white")

            crops.append((r, crop))

            # 在整张预览图上画出红框 overlay，便于肉眼验证前后端坐标是否一致
            if debug_root is not None:
                try:
                    debug_root.mkdir(parents=True, exist_ok=True)
                    overlay = img.copy()
                    draw = ImageDraw.Draw(overlay)
                    draw.rectangle((x1, y1, x2, y2), outline="red", width=3)
                    overlay_path = debug_root / f"overlay_region_{idx}_page_{r.page}.png"
                    overlay.save(overlay_path)
                    logger.info(
                        "[ocr] saved overlay for region idx=%d path=%s box=(%d,%d,%d,%d)",
                        idx,
                        overlay_path,
                        x1,
                        y1,
                        x2,
                        y2,
                    )
                except Exception:
                    logger.exception("[ocr] failed to save overlay for region idx=%d", idx)

        logger.info("[ocr] total valid crops=%d", len(crops))
        return crops

    def _resolve_image_path_for_page(self, file: File, page: int) -> str:
        """
        Determine the correct preview image path for a specific page.
        """
        base_rel = Path(file.preview_path or file.storage_path)
        backend_root = Path(__file__).resolve().parents[2]
        target_rel = base_rel

        if page > 1:
            if file.preview_path and ".page" in base_rel.name:
                try:
                    prefix, suffix = base_rel.name.rsplit(".page", 1)
                    original_page, ext = suffix.split(".", 1)
                except ValueError:
                    raise FileNotFoundError(
                        f"preview path {base_rel} 格式异常，无法定位第 {page} 页"
                    ) from None
                target_name = f"{prefix}.page{page}.{ext}"
                target_rel = base_rel.with_name(target_name)
            else:
                raise FileNotFoundError(f"文件不包含第 {page} 页的预览")

        abs_path = (backend_root / target_rel).resolve()
        if not abs_path.exists():
            raise FileNotFoundError(f"预览文件不存在: {abs_path}")
        return str(abs_path)

    def _image_to_data_url(self, image: Image.Image) -> str:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        b64 = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"

    def _call_models(self, image: Image.Image) -> str:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        image_url = self._image_to_data_url(image)
        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": image_url},
                        },
                        {
                            "type": "text",
                            "text": (
                                "你是一个只做 OCR 的引擎，必须逐字逐行抄写图片中的全部内容（题号、题干、选项、公式等），严格保持顺序，不得省略。"
                                "优先使用标准 LaTeX 表示所有数学符号（例如 \\sqrt{}、\\frac{}、\\cdot、\\complement_{U}、\\pi），"
                                "如果确实无法确定对应的 LaTeX，可以暂时保留原 Unicode 字符，但仍然禁止添加 HTML 标签、Markdown、自然语言解释或总结。"
                                "【重要】关于美元符号的处理：\n"
                                "- 数学公式中的美元符号：用 $...$ 包裹行内公式（例如 $E=mc^2$），用 $$...$$ 包裹块级公式。\n"
                                "- 英文文本中的美元符号（货币）：保持原样，不要用任何符号包裹（例如 $160、$50、$1000）。\n"
                                "- 区分方法：如果 $ 后面紧跟数字且没有数学运算符，就是货币符号，直接抄写；如果包含数学符号或 LaTeX 命令，就用 $...$ 包裹。\n"
                                "若识别的内容中出现表格，必须使用标准 Markdown 表格语法（第一行为表头，使用 '|' 与 '---' 分隔）逐列逐行抄写该表格，保持原有结构与顺序。"
                                "对于选择题选项，尽量保持版式：若原图为一行横排或两列排版，请在输出时也合并为相同行/同列（例如 A. B. C. D. 横向，或两列两行）；只有当某个选项内容本身很长或换行时，再使用纵向分行。"
                                "不要概括，不要解释，只输出识别到的原始内容。"
                            ),
                        },
                    ],
                }
            ],
            "temperature": 0,
        }
        resp = requests.post(url, headers=headers, json=payload, timeout=60)
        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:  # pragma: no cover - network error path
            raise RuntimeError(
                f"ModelScope request failed: status={resp.status_code}, body={resp.text}"
            ) from exc
        data = resp.json()
        text_output: str | None = None
        try:
            # OpenAI 兼容格式
            contents = data["choices"][0]["message"]["content"]
            # 可能是字符串或 list
            if isinstance(contents, str):
                text_output = contents.strip()
            if isinstance(contents, list):
                texts = [c.get("text", "") for c in contents if isinstance(c, dict)]
                text_output = "\n".join(t for t in texts if t).strip()
        except Exception:
            pass
        if text_output is not None:
            preview = text_output.replace("\n", "\\n")
            logger.info("[ocr] model output len=%d preview=%s", len(text_output), preview)
            return text_output
        raw = str(data)
        logger.warning("[ocr] unexpected model response, raw=%s", raw)
        return raw

    def ocr_for_session(self, db: Session, session_id: int, regions: List[Region]) -> List[str]:
        session = db.query(ExtractionSession).filter_by(id=session_id).first()
        if not session:
            raise ValueError("Session not found")
        file: File | None = db.query(File).filter_by(id=session.file_id).first()
        if not file:
            raise ValueError("File not found for session")

        logger.info(
            "[ocr] start session=%s file_id=%s tenant=%s user=%s region_count=%d",
            session.id,
            session.file_id,
            session.tenant_id,
            session.user_id,
            len(regions),
        )

        region_jobs: List[tuple[str, Region]] = []
        for idx, region in enumerate(regions):
            try:
                page_image_path = self._resolve_image_path_for_page(file, region.page)
            except FileNotFoundError as exc:
                logger.warning(
                    "[ocr] skip region idx=%d page=%d due to missing preview: %s",
                    idx,
                    region.page,
                    exc,
                )
                continue
            region_jobs.append((page_image_path, region))

        if not region_jobs:
            logger.warning("[ocr] no valid regions to process for session=%s", session.id)
            return []

        # 保存 debug 截图 / overlay，便于查看模型实际看到的内容
        debug_root = Path(__file__).resolve().parents[2] / "debug_crops" / f"session_{session_id}"
        try:
            debug_root.mkdir(parents=True, exist_ok=True)
        except Exception:
            logger.exception("[ocr] failed to create debug_crops directory at %s", debug_root)

        crops = self._crop_regions(region_jobs, debug_root=debug_root)
        results: List[str] = []

        for idx, (region, crop) in enumerate(crops):
            try:
                if debug_root.exists():
                    debug_path = debug_root / f"region_{idx}_page_{region.page}.png"
                    crop.save(debug_path)
                    logger.info(
                        "[ocr] saved debug crop idx=%d page=%d size=%sx%s path=%s",
                        idx,
                        region.page,
                        crop.width,
                        crop.height,
                        debug_path,
                    )
            except Exception:
                logger.exception("[ocr] failed to save debug crop idx=%d", idx)

            text = self._call_models(crop)
            logger.info("[ocr] region %d page=%d ocr length=%d", idx, region.page, len(text or ""))
            results.append(text)

        # 持久化到 extracted_items
        for idx, text in enumerate(results):
            item = ExtractedItem(
                tenant_id=session.tenant_id,
                session_id=session.id,
                sequence_index=idx,
                content_html=text,
                content_plain=text,
                question_type=None,
                confidence=None,
            )
            db.add(item)
        db.commit()

        return results
