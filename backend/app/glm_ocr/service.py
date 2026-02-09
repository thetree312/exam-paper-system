import base64
import hashlib
import io
import json
import logging
import mimetypes
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from html import unescape
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from PIL import Image
from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Document, File, Question, FileOcrCache
from ..services.cache_manager import FileOcrCacheManager
from ..services.legend_service import LegendService


CACHE_TTL = timedelta(days=180)
settings = get_settings()
logger = logging.getLogger("glm_ocr")


QUESTION_START_RE = re.compile(r"^\s*(\d{1,3})\s*[\.．、:：]")


@dataclass
class GlmLayoutBlock:
    page_index: int
    index: int
    label: str
    bbox_2d: List[float]
    content: str


class GlmOcrService:
    """封装 GLM-OCR 版面解析与题卡导入逻辑。

    当前版本侧重于：
    - 调用智谱 GLM-OCR layout_parsing 接口
    - 解析 layout_details / md_results
    - 为后续题卡生成提供基础能力
    """

    def __init__(self) -> None:
        if not settings.siliconflow_api_key and not settings.ms_api_key:
            # 仅为保持与现有配置风格一致，这里不强制要求 GLM 环境变量，
            # 真正调用时会再次检查。
            pass

    # === 调用层 ===

    async def call_layout_parsing(
        self,
        db: Session,
        *,
        file: File,
        tenant_id: int,
        document: Optional[Document] = None,
        force_refresh: bool = False,
    ) -> Tuple[Dict[str, Any], Optional[FileOcrCache]]:
        api_key = settings.zhipu_api_key  # type: ignore[attr-defined]
        layout_url = settings.zhipu_layout_url  # type: ignore[attr-defined]
        model = settings.zhipu_model_glm_ocr  # type: ignore[attr-defined]

        if not api_key:
            raise HTTPException(status_code=500, detail="ZHIPU_API_KEY 未配置")

        content_hash = file.content_hash
        file_bytes: Optional[bytes] = None
        mime: Optional[str] = None
        if not content_hash:
            file_bytes, mime = self._load_file_bytes(file)
            content_hash = hashlib.sha256(file_bytes).hexdigest()
            file.content_hash = content_hash
            db.add(file)
            db.flush()

        cache_manager = FileOcrCacheManager(db)
        cache_entry = None
        if content_hash:
            cache_entry = cache_manager.get_latest(
                tenant_id=tenant_id,
                content_hash=content_hash,
                model=model,
                ttl=CACHE_TTL,
            )

        if cache_entry and not force_refresh:
            cached_result = self._deserialize_cache(cache_entry)
            if document is not None:
                self._apply_document_cache(document, cached_result, model)
                cache_manager.attach_document(cache_entry, document)
            cache_manager.touch(cache_entry)
            return cached_result, cache_entry

        if file_bytes is None or mime is None:
            file_bytes, mime = self._load_file_bytes(file)
        data_uri = self._to_data_uri(file_bytes, mime)

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload: Dict[str, Any] = {
            "model": model,
            "file": data_uri,
            "need_layout_visualization": False,
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(layout_url, headers=headers, json=payload)

        if resp.status_code != 200:
            try:
                detail = resp.json()
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=502, detail={"message": "GLM-OCR 请求失败", "response": detail})

        data = resp.json()
        if isinstance(data, dict) and data.get("code") not in (None, 0, 200):
            raise HTTPException(status_code=502, detail=data)

        cache_entry = cache_manager.upsert(
            tenant_id=tenant_id,
            content_hash=content_hash or "",
            model=model,
            file_id=file.id,
            document=document,
            md_payload=data.get("md_results"),
            layout_payload=data,
        )

        if document is not None:
            self._apply_document_cache(document, data, model)
            db.add(document)

        db.flush()
        return data, cache_entry

    # === 文件与裁剪工具 ===

    def _load_file_bytes(self, file: File) -> Tuple[bytes, str]:
        backend_root = Path(__file__).resolve().parents[2]
        rel = Path(file.storage_path)
        abs_path = (backend_root / rel).resolve()
        if not abs_path.exists():
            raise HTTPException(status_code=404, detail=f"源文件不存在: {abs_path}")
        data = abs_path.read_bytes()
        mime, _ = mimetypes.guess_type(str(abs_path))
        if not mime:
            mime = "application/pdf" if abs_path.suffix.lower() == ".pdf" else "image/png"
        return data, mime

    def _to_data_uri(self, data: bytes, mime: str) -> str:
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{mime};base64,{b64}"

    def _resolve_image_path_for_page(self, file: File, page: int) -> str:
        """根据 File.preview_path / storage_path 定位指定页的预览图路径。

        逻辑与 LegendService/_resolve_image_path_for_page 基本一致，
        以便复用现有由 Celery 生成的预览 PNG。
        """

        base_rel = Path(file.preview_path or file.storage_path)
        backend_root = Path(__file__).resolve().parents[2]
        target_rel = base_rel

        if page > 1:
            if file.preview_path and ".page" in base_rel.name:
                try:
                    prefix, suffix = base_rel.name.rsplit(".page", 1)
                    _original_page, ext = suffix.split(".", 1)
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

    def _load_preview_image(self, file: File, page: int) -> Optional[Image.Image]:
        """加载指定页的预览图为 RGB 模式；若不存在则返回 None。"""

        try:
            image_path = self._resolve_image_path_for_page(file, page)
        except FileNotFoundError:
            return None

        base_image = Image.open(image_path)
        try:
            img = base_image.convert("RGB")
        finally:
            base_image.close()
        return img

    def _compute_bbox(
        self,
        raw_bbox: Optional[List[float]],
        width: Optional[float],
        height: Optional[float],
    ) -> Optional[Tuple[Dict[str, int], Optional[Dict[str, float]]]]:
        """将 GLM-OCR 返回的 bbox_2d 统一转换为像素与归一化坐标。"""

        if not raw_bbox or len(raw_bbox) < 4:
            return None
        x1, y1, x2, y2 = raw_bbox[:4]
        if width and height:
            # 若坐标落在 [-1,1] 范围内，视为归一化坐标，需要乘以宽高
            if max(abs(x1), abs(x2), abs(y1), abs(y2)) <= 1:
                x1 *= width
                x2 *= width
                y1 *= height
                y2 *= height
        abs_bbox = {
            "x1": int(max(0, x1)),
            "y1": int(max(0, y1)),
            "x2": int(max(0, x2)),
            "y2": int(max(0, y2)),
        }
        norm_bbox: Optional[Dict[str, float]] = None
        if width and height and width > 0 and height > 0:
            norm_bbox = {
                "x1": abs_bbox["x1"] / width,
                "y1": abs_bbox["y1"] / height,
                "x2": abs_bbox["x2"] / width,
                "y2": abs_bbox["y2"] / height,
            }
        return abs_bbox, norm_bbox

    def _crop_block_to_file(
        self,
        image: Image.Image,
        abs_bbox: Dict[str, int],
        crops_root: Path,
        document_id: int,
        base_name: str,
    ) -> Optional[str]:
        """根据像素框裁剪并保存到磁盘，返回供前端使用的 URL。"""

        x1, y1, x2, y2 = (
            abs_bbox["x1"],
            abs_bbox["y1"],
            abs_bbox["x2"],
            abs_bbox["y2"],
        )
        if x2 <= x1 or y2 <= y1:
            return None

        w, h = image.size
        crop_box = (
            max(0, min(w, x1)),
            max(0, min(h, y1)),
            max(0, min(w, x2)),
            max(0, min(h, y2)),
        )
        if crop_box[2] - crop_box[0] <= 1 or crop_box[3] - crop_box[1] <= 1:
            return None

        crops_root.mkdir(parents=True, exist_ok=True)
        filename = f"{base_name}_{crop_box[0]}_{crop_box[1]}_{crop_box[2]}_{crop_box[3]}.png"
        target_path = crops_root / filename

        cropped = image.crop(crop_box)
        cropped.save(target_path)

        # 与 router 中的 /api/glm-ocr/crops/{document_id}/{filename} 对齐
        url = f"/api/glm-ocr/crops/{document_id}/{filename}"
        return url

    def _crop_block_to_data_url(
        self,
        image: Image.Image,
        abs_bbox: Dict[str, int],
        source_type: Optional[str] = None,
    ) -> Optional[str]:
        """根据像素框裁剪并直接返回 data URL，用于题卡内联图例。"""

        x1, y1, x2, y2 = (
            abs_bbox["x1"],
            abs_bbox["y1"],
            abs_bbox["x2"],
            abs_bbox["y2"],
        )
        if x2 <= x1 or y2 <= y1:
            return None

        w, h = image.size
        crop_box = (
            max(0, min(w, x1)),
            max(0, min(h, y1)),
            max(0, min(w, x2)),
            max(0, min(h, y2)),
        )
        if crop_box[2] - crop_box[0] <= 1 or crop_box[3] - crop_box[1] <= 1:
            return None

        cropped = image.crop(crop_box)

        if source_type == "image":
            try:
                legend_service = LegendService()
                cropped = legend_service._preprocess(cropped, "image")
            except Exception:
                logger.exception("[glm_ocr.import] legend postprocess failed, fallback to raw crop")

        buffer = io.BytesIO()
        cropped.save(buffer, format="PNG")
        b64 = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64}"

    # === 题卡导入骨架（答案隐藏） ===

    def import_exam_as_questions(
        self,
        db: Session,
        tenant_id: int,
        document_id: int,
        glm_result: Dict[str, Any],
    ) -> List[Question]:
        """根据 GLM-OCR 结果创建题目记录。

        当前实现仅为骨架：
        - 将整份试卷 markdown 作为单个 Question.content
        - 预留 grading_predicted_answer 字段存放答案内容（若后续从 markdown 中抽取）

        后续可以在此处细化为按题号拆分多个 Question。
        """

        document: Optional[Document] = db.query(Document).filter_by(
            id=document_id,
            tenant_id=tenant_id,
        ).first()
        if document is None:
            raise HTTPException(status_code=404, detail="Document 不存在")

        layout_pages = glm_result.get("layout_details") or []
        data_info = glm_result.get("data_info") or {}
        pages_meta = data_info.get("pages") or []

        file: Optional[File] = document.file
        if file is None:
            markdown_fallback = str(glm_result.get("md_results") or "").strip()
            if not markdown_fallback:
                raise HTTPException(status_code=400, detail="GLM-OCR 返回空的 md_results")
            logger.info(
                "[glm_ocr.import] document=%s no file bound, fallback to single-question mode",
                document.id,
            )
            question = Question(
                tenant_id=tenant_id,
                document_id=document.id,
                sequence_index=0,
                page=None,
                content=markdown_fallback,
                legend_images="[]",
                student_answer=None,
                grading_judgement=None,
                grading_predicted_answer=None,
                grading_reasoning=None,
                grading_confidence=None,
                versions=[],
            )
            db.add(question)
            db.commit()
            db.refresh(question)
            return [question]

        figure_labels = {"image", "figure", "chart", "table"}
        skip_labels = {
            "header",
            "footer",
            "page_header",
            "page_footer",
            "pagenum",
            "page_number",
            "logo",
        }

        questions: List[Question] = []
        current_parts: List[str] = []
        current_legends: List[Dict[str, Any]] = []
        current_page: Optional[int] = None
        answer_lines: List[str] = []

        # 是否已经生成过至少一道题，用于区别卷首/中途出现的说明页
        has_started_questions = False

        # 通过简单的全局状态避免把「注意事项」「答题说明」「答案页」当成题目
        in_notice_section = True
        in_answer_section = False

        def flush_current() -> None:
            nonlocal has_started_questions
            if not current_parts:
                return
            sequence_index = len(questions)
            markdown = "\n".join(part for part in current_parts if part)

            # 若当前题目过程中曾插入过图例占位符，则无条件保留对应图例
            legends_for_question = current_legends

            q = Question(
                tenant_id=tenant_id,
                document_id=document.id,
                sequence_index=sequence_index,
                page=current_page,
                content=markdown,
                legend_images=json.dumps(legends_for_question, ensure_ascii=False),
                student_answer=None,
                grading_judgement=None,
                grading_predicted_answer=None,
                grading_reasoning=None,
                grading_confidence=None,
                versions=[],
            )
            db.add(q)
            questions.append(q)
            has_started_questions = True
            logger.info(
                "[glm_ocr.import] question #%s page=%s legends=%s snippet=%s",
                sequence_index,
                current_page,
                len(current_legends),
                markdown[:80].replace("\n", " "),
            )

        def looks_like_section_header(text: str) -> bool:
            stripped = text.strip()
            if not stripped:
                return False
            # 形如 “一、选择题” “二、填空题” 等
            if re.match(r"^[#\s]*[一二三四五六七八九十]+[、\.．]", stripped):
                return True
            # 形如 “第Ⅰ卷” “第II卷” 等
            if re.match(r"^第[一二三四五六七八九十0-9ⅠⅡⅢIVVVI]+卷", stripped):
                return True
            normalized = stripped.lstrip("#").strip()
            section_prefixes = ["选择题", "填空题", "解答题", "本大题", "本题共"]
            return any(normalized.startswith(prefix) for prefix in section_prefixes)

        total_pages = len(layout_pages)
        logger.info(
            "[glm_ocr.import] start document=%s pages=%s",
            document.id,
            total_pages,
        )

        for page_idx in range(total_pages):
            blocks = layout_pages[page_idx] or []
            if not blocks:
                continue

            page_num = page_idx + 1

            # 若在已经开始出题之后，某一页包含明显的卷首/注意事项标题，则整页视为说明页，直接跳过
            if has_started_questions:
                page_has_notice_title = False
                page_contains_answer_kw = False
                for b in blocks:
                    native_label_page = str(b.get("native_label") or "").lower()
                    text_page = str(b.get("content") or "")
                    if any(kw in text_page for kw in ["参考答案", "题答案", "【答案】", "答案】", "答案："]):
                        page_contains_answer_kw = True
                    if native_label_page in {"doc_title", "paragraph_title"} and (
                        "注意事项" in text_page
                        or "答题卡" in text_page
                        or "考试" in text_page
                    ):
                        page_has_notice_title = True
                if page_has_notice_title and not page_contains_answer_kw:
                    logger.info(
                        "[glm_ocr.import] skip meta page page=%s after questions started",
                        page_num,
                    )
                    continue

            image = self._load_preview_image(file, page_num)

            meta = pages_meta[page_idx] if page_idx < len(pages_meta) else {}
            # GLM 返回的宽高（通常对应其内部渲染坐标系），可能与预览 PNG 分辨率不同
            glm_width = meta.get("width")
            glm_height = meta.get("height")
            width = glm_width or (image.width if image else None)
            height = glm_height or (image.height if image else None)

            for block_idx, block in enumerate(blocks):
                label = str(block.get("label") or "text").lower()
                native_label = str(block.get("native_label") or "").lower()
                raw_bbox = block.get("bbox_2d")
                raw_content = str(block.get("content") or "").strip()

                bbox_pair = (
                    self._compute_bbox(raw_bbox, width, height)
                    if (raw_bbox and (width and height))
                    else None
                )
                abs_bbox: Optional[Dict[str, int]] = None
                norm_bbox: Optional[Dict[str, float]] = None
                if bbox_pair:
                    abs_bbox, norm_bbox = bbox_pair
                    # 若 GLM 的坐标系尺寸与预览图尺寸不一致，按归一化坐标重新适配到预览图
                    if (
                        image is not None
                        and norm_bbox is not None
                        and glm_width
                        and glm_height
                    ):
                        img_w, img_h = image.size
                        # 只有在确实存在尺寸差异时才重算，避免多余误差
                        if img_w > 0 and img_h > 0 and (
                            int(glm_width) != img_w or int(glm_height) != img_h
                        ):
                            abs_bbox = {
                                "x1": int(norm_bbox["x1"] * img_w),
                                "y1": int(norm_bbox["y1"] * img_h),
                                "x2": int(norm_bbox["x2"] * img_w),
                                "y2": int(norm_bbox["y2"] * img_h),
                            }

                if label in skip_labels and norm_bbox is not None:
                    if norm_bbox["y2"] < 0.15 or norm_bbox["y1"] > 0.85:
                        logger.debug(
                            "[glm_ocr.import] skip header/footer label=%s native=%s page=%s bbox=%s",
                            label,
                            native_label,
                            page_num,
                            norm_bbox,
                        )
                        continue

                content = raw_content
                if label == "table" and "<table" in raw_content.lower():
                    converted = self._html_table_to_markdown(raw_content)
                    if converted:
                        content = converted
                        logger.info(
                            "[glm_ocr.import] converted HTML table to markdown on page=%s block=%s",
                            page_num,
                            block_idx,
                        )

                if content:
                    # 清理简单 HTML 包裹，避免 "<div align=\"center\">" 等噪声出现在题干中
                    # 保留 table/mtd/sub/sup 等结构，主要移除 div/span 等纯样式标签
                    content = re.sub(r"<div[^>]*>", "", content, flags=re.IGNORECASE)
                    content = re.sub(r"</div>", "", content, flags=re.IGNORECASE)
                    content = re.sub(r"<span[^>]*>", "", content, flags=re.IGNORECASE)
                    content = re.sub(r"</span>", "", content, flags=re.IGNORECASE)

                    lines = [unescape(line).rstrip() for line in content.splitlines()]
                    for line in lines:
                        stripped = line.strip()
                        if not stripped:
                            if current_parts:
                                current_parts.append("")
                            continue

                        hit_answer_kw = any(
                            kw in stripped for kw in ["参考答案", "答案解析", "【答案】", "题答案"]
                        )
                        if hit_answer_kw and not in_answer_section:
                            in_answer_section = True
                            logger.debug(
                                "[glm_ocr.import] enter answer section page=%s line=%s",
                                page_num,
                                stripped[:60],
                            )

                        # 检测说明结束、正式题目开始的信号：需要是明确的小节标题
                        if in_notice_section and looks_like_section_header(stripped):
                            in_notice_section = False
                            logger.debug(
                                "[glm_ocr.import] leave notice section page=%s line=%s",
                                page_num,
                                stripped[:60],
                            )
                            continue

                        if in_notice_section and not in_answer_section:
                            continue
                        if in_answer_section:
                            answer_lines.append(stripped)
                            continue

                        # 题型标题 / 分节行：例如 "一、选择题" "二、填空题" "【本题共..." 等
                        if any(kw in stripped for kw in ["选择题", "填空题", "解答题", "本题共"]):
                            # 若形式为 "一、..." / "二、..."，视为题型标题，作为题目边界但不写入题干
                            if re.match(r"^[一二三四五六七八九十]+\s*[、\.．]", stripped):
                                if current_parts:
                                    flush_current()
                                    current_parts.clear()
                                    current_legends.clear()
                                    current_page = None
                                continue

                        m = QUESTION_START_RE.match(stripped)
                        if m:
                            if current_parts:
                                flush_current()
                                current_parts.clear()
                                current_legends.clear()
                            current_page = page_num
                            current_parts.append(stripped)
                            continue

                        if current_parts:
                            current_parts.append(stripped)
                        else:
                            # 没有开始任何题目且也不在说明/答案区，保守起见先丢弃
                            continue

                # 图像 / 表格类 block：仅在中部区域且非 header/logo 时，才尝试作为图例
                is_header_like = any(
                    key in native_label for key in ["header", "footer", "logo"]
                )

                # 对已经以 HTML/Markdown 表格形式渲染的 table block，不再额外裁剪为图例，避免前端重复展示
                is_html_table_block = label == "table" and "<table" in raw_content.lower()

                if (
                    image is not None
                    and abs_bbox is not None
                    and label in figure_labels
                    and not is_header_like
                    and not is_html_table_block
                ):
                    # 额外限制：裁剪框需落在页面中部，避免顶端/底部 logo
                    if norm_bbox is not None and (
                        norm_bbox["y2"] < 0.08 or norm_bbox["y1"] > 0.92
                    ):
                        logger.debug(
                            "[glm_ocr.import] skip extreme-top/bottom figure label=%s native=%s page=%s bbox=%s",
                            label,
                            native_label,
                            page_num,
                            norm_bbox,
                        )
                        continue
                    url = self._crop_block_to_data_url(
                        image=image,
                        abs_bbox=abs_bbox,
                        source_type=getattr(file, "source_type", None),
                    )
                    if url and current_parts:
                        # 使用占位符记录图例在题干中的大致位置
                        placeholder = f"[[GLM_FIG_{len(current_legends)}]]"
                        current_parts.append(placeholder)
                        current_legends.append(url)
                    elif url is None:
                        logger.debug(
                            "[glm_ocr.import] skip invalid crop page=%s block=%s label=%s",
                            page_num,
                            block_idx,
                            label,
                        )

        flush_current()

        answer_map: Dict[int, str] = {}
        last_no: Optional[int] = None

        def _add_answer(no: int, text: str) -> None:
            t = text.strip()
            if not t:
                return
            prev = answer_map.get(no)
            if prev:
                answer_map[no] = prev + "\n" + t
            else:
                answer_map[no] = t

        header_re = re.compile(r"^[\[【]?(第\s*)?(?P<no>\d+)\s*(题)?\s*答案[】\]]?\s*$")
        value_re = re.compile(r"^[\[【]?答案[】\]]?\s*[:：]?\s*(?P<ans>.+)$")
        inline_re = re.compile(
            r"^\s*(第\s*)?(?P<no>\d+)\s*(题)?\s*[\.．、:：）)]?\s*(?:(?:答案|Ans|ANS)\s*[:：]?)?\s*(?P<rest>.*)$"
        )

        for line in answer_lines:
            s = line.strip()
            if not s:
                continue
            header_match = header_re.match(s)
            if header_match:
                try:
                    last_no = int(header_match.group("no"))
                except (TypeError, ValueError):
                    continue
                continue

            value_match = value_re.match(s)
            if value_match and last_no is not None:
                _add_answer(last_no, value_match.group("ans"))
                continue

            m_ans = inline_re.match(s)
            if m_ans:
                no_str = m_ans.group("no") or ""
                try:
                    last_no = int(no_str)
                except ValueError:
                    continue
                rest = m_ans.group("rest") or ""
                rest = re.sub(r"^[\[【]?答案[】\]]?\s*[:：]?\s*", "", rest).strip()
                _add_answer(last_no, rest)
                continue

            if last_no is not None:
                _add_answer(last_no, s)

        if answer_map:
            if len(questions) == 1 and 1 not in answer_map and answer_map:
                only = next(iter(answer_map.values()))
                q0 = questions[0]
                existing = (getattr(q0, "canonical_answer", None) or "").strip()
                if not existing:
                    q0.canonical_answer = only
                    q0.answer_status = "complete"
                    q0.answer_source = "ocr"
            else:
                for idx, q in enumerate(questions, start=1):
                    ans = answer_map.get(idx)
                    if not ans:
                        continue
                    existing = (getattr(q, "canonical_answer", None) or "").strip()
                    if existing:
                        continue
                    q.canonical_answer = ans
                    q.answer_status = "complete"
                    q.answer_source = "ocr"

        if not questions:
            markdown_fallback = str(glm_result.get("md_results") or "").strip()
            if not markdown_fallback:
                raise HTTPException(
                    status_code=400,
                    detail="GLM-OCR 返回空的 md_results 与 layout_details",
                )
            logger.warning(
                "[glm_ocr.import] layout_details produced no questions, fallback to single-question md_results",
            )
            question = Question(
                tenant_id=tenant_id,
                document_id=document.id,
                sequence_index=0,
                page=None,
                content=markdown_fallback,
                legend_images="[]",
                student_answer=None,
                grading_judgement=None,
                grading_predicted_answer=None,
                grading_reasoning=None,
                grading_confidence=None,
                versions=[],
            )
            db.add(question)
            questions = [question]

        db.commit()
        for q in questions:
            db.refresh(q)

        logger.info(
            "[glm_ocr.import] document=%s created_questions=%s",
            document.id,
            len(questions),
        )
        return questions

    def _dump_json(self, payload: Any) -> Optional[str]:
        if payload is None:
            return None
        try:
            return json.dumps(payload, ensure_ascii=False)
        except Exception:
            return None

    def _deserialize_cache(self, cache_entry: FileOcrCache) -> Dict[str, Any]:
        if cache_entry.layout_cache:
            try:
                return json.loads(cache_entry.layout_cache)
            except Exception:
                logger.exception("[glm_ocr.cache] failed to decode layout_cache cache_id=%s", cache_entry.id)
        result: Dict[str, Any] = {}
        if cache_entry.md_cache:
            try:
                result["md_results"] = json.loads(cache_entry.md_cache)
            except Exception:
                logger.exception("[glm_ocr.cache] failed to decode md_cache cache_id=%s", cache_entry.id)
        return result

    def _apply_document_cache(self, document: Document, glm_result: Dict[str, Any], model: str) -> None:
        document.ocr_md_cache = self._dump_json(glm_result.get("md_results"))
        document.ocr_layout_cache = self._dump_json(glm_result)
        document.ocr_cache_generated_at = datetime.utcnow()
        document.ocr_cache_model = model

    def dump_glm_result(self, *, glm_result: Dict[str, Any], tenant_id: int, document: Document | None) -> None:
        """Persist raw GLM-OCR payload to tmp/glm_ocr_dumps for进一步排查。"""

        if document is None:
            return

        try:
            dump_root = Path(__file__).resolve().parents[2] / "tmp" / "glm_ocr_dumps"
            dump_root.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
            filename = f"tenant{tenant_id}_document{document.id}_{timestamp}.json"
            payload = {
                "tenant_id": tenant_id,
                "document_id": document.id,
                "generated_at": datetime.utcnow().isoformat(),
                "glm_result": glm_result,
            }
            (dump_root / filename).write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.exception("[glm_ocr.dump] failed to persist glm result", exc_info=True)

    def _strip_html_tags(self, text: str) -> str:
        return re.sub(r"<[^>]+>", "", text)

    def _html_table_to_markdown(self, html: str) -> str:
        try:
            m = re.search(r"<table[^>]*>(.*?)</table>", html, flags=re.IGNORECASE | re.DOTALL)
            if not m:
                return html.strip()
            inner = m.group(1)
            rows = re.findall(r"<tr[^>]*>(.*?)</tr>", inner, flags=re.IGNORECASE | re.DOTALL)
            matrix: List[List[str]] = []
            for row in rows:
                cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.IGNORECASE | re.DOTALL)
                cleaned = [self._strip_html_tags(c).strip() for c in cells]
                if cleaned:
                    matrix.append(cleaned)
            if not matrix:
                return ""
            col_count = max(len(r) for r in matrix)
            def pad(row: List[str]) -> List[str]:
                if len(row) >= col_count:
                    return row
                return row + [""] * (col_count - len(row))
            header = pad(matrix[0])
            body = [pad(r) for r in matrix[1:]]
            md_lines: List[str] = []
            md_lines.append("| " + " | ".join(header) + " |")
            md_lines.append("| " + " | ".join(["---"] * len(header)) + " |")
            for row in body:
                md_lines.append("| " + " | ".join(row) + " |")
            return "\n".join(md_lines)
        except Exception:
            return html.strip()
