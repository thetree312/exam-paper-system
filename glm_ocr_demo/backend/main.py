import base64
import mimetypes
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
import httpx
import fitz  # PyMuPDF
from PIL import Image

from settings import get_settings

load_dotenv()
settings = get_settings()

app = FastAPI(title="GLM-OCR Demo Service", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _call_glm_ocr(data_uri: str) -> Dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {settings.api_key}",
        "Content-Type": "application/json",
    }
    payload = {"model": settings.model, "file": data_uri}

    async with httpx.AsyncClient(timeout=settings.request_timeout) as client:
        response = await client.post(settings.layout_url, json=payload, headers=headers)

    if response.status_code != 200:
        try:
            detail = response.json()
        except Exception:
            detail = response.text
        raise HTTPException(status_code=502, detail={"message": "智谱接口调用失败", "response": detail})

    data = response.json()
    if isinstance(data, dict) and data.get("msg") and data.get("code", 0) != 200:
        raise HTTPException(status_code=502, detail=data)
    return data


def _ensure_mime(filename: str, content_type: str | None) -> str:
    if content_type and content_type != "application/octet-stream":
        return content_type
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"

def _load_preview_images(file_bytes: bytes, mime: str) -> List[Image.Image]:
    """Convert upload into per-page PIL images for preview/highlight."""

    def _ensure_rgb(img: Image.Image) -> Image.Image:
        return img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img.convert("RGB")

    is_pdf = (mime and "pdf" in mime) or file_bytes.startswith(b"%PDF")
    if is_pdf:
        try:
            doc = fitz.open(stream=file_bytes, filetype="pdf")
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"无法读取 PDF：{exc}") from exc

        images: List[Image.Image] = []
        zoom_matrix = fitz.Matrix(2, 2)
        for page in doc:
            pix = page.get_pixmap(matrix=zoom_matrix)
            mode = "RGBA" if pix.alpha else "RGB"
            img = Image.frombytes(mode, [pix.width, pix.height], pix.samples)
            images.append(_ensure_rgb(img))
        if not images:
            raise HTTPException(status_code=400, detail="PDF 内无页面内容")
        return images

    try:
        image = Image.open(BytesIO(file_bytes))
        return [_ensure_rgb(image)]
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无法解析图片：{exc}") from exc


def _image_to_data_url(image: Image.Image, fmt: str = "PNG") -> str:
    buffer = BytesIO()
    image.save(buffer, format=fmt)
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
    mime = f"image/{fmt.lower()}"
    return f"data:{mime};base64,{encoded}"


def _compute_bbox(
    raw_bbox: Optional[List[float]], width: Optional[float], height: Optional[float]
) -> Optional[Tuple[Dict[str, int], Optional[Dict[str, float]]]]:
    if not raw_bbox or len(raw_bbox) < 4:
        return None
    x1, y1, x2, y2 = raw_bbox[:4]
    if width and height:
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
    norm_bbox = None
    if width and height and width > 0 and height > 0:
        norm_bbox = {
            "x1": abs_bbox["x1"] / width,
            "y1": abs_bbox["y1"] / height,
            "x2": abs_bbox["x2"] / width,
            "y2": abs_bbox["y2"] / height,
        }
    return abs_bbox, norm_bbox


def _crop_to_data_url(image: Image.Image, abs_bbox: Dict[str, int]) -> Optional[str]:
    x1, y1, x2, y2 = abs_bbox["x1"], abs_bbox["y1"], abs_bbox["x2"], abs_bbox["y2"]
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
    return _image_to_data_url(cropped)


CROP_LABELS = {"image", "figure", "chart", "table"}


def _build_enriched_payload(
    glm_response: Dict[str, Any],
    preview_images: List[Image.Image],
) -> Dict[str, Any]:
    layout_pages = glm_response.get("layout_details") or []
    pages_meta = (glm_response.get("data_info") or {}).get("pages") or []
    markdown = glm_response.get("md_results", "")

    enriched_pages: List[Dict[str, Any]] = []
    figure_cards: List[Dict[str, Any]] = []

    total_pages = max(len(layout_pages), len(preview_images)) or len(preview_images)
    for page_idx in range(total_pages):
        blocks = layout_pages[page_idx] if page_idx < len(layout_pages) else []
        image = preview_images[page_idx] if page_idx < len(preview_images) else (
            preview_images[-1] if preview_images else None
        )
        meta = pages_meta[page_idx] if page_idx < len(pages_meta) else {}
        width = meta.get("width") or (image.width if image else None)
        height = meta.get("height") or (image.height if image else None)

        page_payload: Dict[str, Any] = {
            "page_index": page_idx,
            "width": width,
            "height": height,
            "preview": _image_to_data_url(image) if image else None,
            "blocks": [],
        }

        for block_idx, block in enumerate(blocks or []):
            bbox_pair = _compute_bbox(block.get("bbox_2d"), width, height)
            if not bbox_pair:
                continue
            abs_bbox, norm_bbox = bbox_pair
            label = (block.get("label") or "text").lower()
            uid = f"{page_idx}-{block.get('index', block_idx)}"
            entry = {
                "uid": uid,
                "index": block.get("index", block_idx),
                "label": label,
                "content": block.get("content") or "",
                "bbox": {"abs": abs_bbox, "norm": norm_bbox},
            }
            if image and label in CROP_LABELS:
                crop_url = _crop_to_data_url(image, abs_bbox)
                if crop_url:
                    entry["crop_data_url"] = crop_url
                    figure_cards.append(
                        {
                            "uid": uid,
                            "label": label,
                            "page_index": page_idx,
                            "content": entry["content"],
                            "bbox": abs_bbox,
                            "data_url": crop_url,
                        }
                    )

            page_payload["blocks"].append(entry)

        enriched_pages.append(page_payload)

    return {
        "markdown": markdown,
        "pages": enriched_pages,
        "figures": figure_cards,
        "raw": glm_response,
    }


@app.get("/api/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/ocr")
async def run_ocr(file: UploadFile = File(...)) -> Dict[str, Any]:
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="上传文件为空")

    mime = _ensure_mime(file.filename or "upload.bin", file.content_type)
    preview_images = _load_preview_images(file_bytes, mime)
    b64 = base64.b64encode(file_bytes).decode("utf-8")
    data_uri = f"data:{mime};base64,{b64}"

    glm_response = await _call_glm_ocr(data_uri)
    enriched = _build_enriched_payload(glm_response, preview_images)
    return {"status": "ok", **enriched}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
