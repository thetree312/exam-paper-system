import base64
import io
from pathlib import Path
from typing import List
import logging

from PIL import Image, ImageFilter, ImageEnhance, ImageOps
from sqlalchemy.orm import Session

from ..models import ExtractionSession, File
from ..schemas import LegendRegion


logger = logging.getLogger(__name__)


class LegendService:
    """负责图例区域裁剪与图片预处理（降噪、锐化等）。"""

    def _resolve_image_path_for_page(self, file: File, page: int) -> str:
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

    def _preprocess(self, img: Image.Image, source_type: str) -> Image.Image:
        """
        图片来源与文档来源分开处理：
        - image（手机拍照等）：保真，不锐化，不上色，最多轻度自适应对比度。
        - 其他（pdf/word）：轻度对比 + 轻锐化 + 上色为编辑区背景（白），避免过暖。
        """

        if source_type == "image":
            # 手机拍照等：只动背景，不做锐化
            # 1) 灰度
            gray = img.convert("L")
            # 2) 轻度拉伸亮度，让背景靠近高亮区
            auto = ImageOps.autocontrast(gray, cutoff=0.02)
            boosted = ImageEnhance.Brightness(auto).enhance(1.03)

            # 3) 把足够亮的像素直接推到 255，保证背景纯白
            def _push_high(p: int) -> int:
                return 255 if p >= 220 else p

            high = boosted.point(_push_high)

            # 4) 上色：前景深灰，背景白，与 tiptap 一致
            tinted = ImageOps.colorize(
                high,
                black="#1a1a1a",
                white="#ffffff",
            )
            return tinted

        # 非 image：按文档类处理，提供扫描质感（接近前端编辑区背景白色）
        gray = img.convert("L")
        auto = ImageOps.autocontrast(gray, cutoff=0.8)
        contrasted = ImageEnhance.Contrast(auto).enhance(1.15)
        sharpened = contrasted.filter(
            ImageFilter.UnsharpMask(radius=0.8, percent=120, threshold=3)
        )
        tinted = ImageOps.colorize(
            sharpened,
            black="#1a1a1a",
            white="#ffffff",
        )
        return tinted

    def extract_legends(
        self,
        db: Session,
        session_id: int,
        legends: List[LegendRegion],
    ) -> List[str]:
        session = db.query(ExtractionSession).filter_by(id=session_id).first()
        if not session:
            raise ValueError("Session not found")
        file: File | None = db.query(File).filter_by(id=session.file_id).first()
        if not file:
            raise ValueError("File not found for session")

        backend_root = Path(__file__).resolve().parents[2]
        logger.info("[legend] start session=%s file_id=%s legend_count=%d", session.id, session.file_id, len(legends))

        data_urls: List[str] = []
        for idx, region in enumerate(legends):
            try:
                image_path = self._resolve_image_path_for_page(file, region.page)
            except FileNotFoundError as exc:
                logger.warning(
                    "[legend] skip region idx=%d page=%d due to missing preview: %s",
                    idx,
                    region.page,
                    exc,
                )
                continue

            base_image = Image.open(image_path)
            img = base_image.convert("RGB")
            base_image.close()
            width, height = img.size

            x1 = int(region.x * width)
            y1 = int(region.y * height)
            x2 = int((region.x + region.width) * width)
            y2 = int((region.y + region.height) * height)

            x1 = max(0, min(width, x1))
            y1 = max(0, min(height, y1))
            x2 = max(0, min(width, x2))
            y2 = max(0, min(height, y2))
            if x2 <= x1 or y2 <= y1:
                logger.warning("[legend] skip invalid region idx=%d due to non-positive size", idx)
                continue

            crop = img.crop((x1, y1, x2, y2)).copy()
            processed = self._preprocess(crop, file.source_type)
            data_url = self._image_to_data_url(processed)
            data_urls.append(data_url)

        logger.info("[legend] total processed legends=%d", len(data_urls))
        return data_urls
