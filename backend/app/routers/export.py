from __future__ import annotations

import base64
import logging
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response

from ..schemas import ExportTemplateInfo, ExportTemplatesResponse, ExportWordRequest


logger = logging.getLogger("export")

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("/templates", response_model=ExportTemplatesResponse)
def list_export_templates() -> ExportTemplatesResponse:
    backend_root = Path(__file__).resolve().parents[2]
    templates_root = backend_root / "templates"
    word_templates_dir = templates_root / "word_templates"
    templates_dir = word_templates_dir if word_templates_dir.exists() else templates_root

    if not templates_dir.exists() or not templates_dir.is_dir():
        return ExportTemplatesResponse(templates=[])

    items: list[ExportTemplateInfo] = []
    for path in sorted(templates_dir.glob("*.docx")):
        key = path.stem
        name = key
        items.append(
            ExportTemplateInfo(
                key=key,
                name=name,
                description=None,
            )
        )

    return ExportTemplatesResponse(templates=items)


@router.post("/word")
def export_word(payload: ExportWordRequest) -> Response:
    """导出当前试卷为 Word 文档（.docx）。

    前端应提交已整理好的 Markdown+LaTeX 文本，包含题干、表格、图片、公式等。
    本接口使用 Pandoc 将 Markdown 转换为 .docx，并直接返回文件内容。
    """

    if not payload.questions:
        raise HTTPException(status_code=400, detail="无题目可导出")

    # 拼接整份试卷的 Markdown 文本
    # 注意：这里不再使用 Markdown 标题语法（# / ##），避免在 Word 中被映射为 Heading1/2，
    # 而是全部作为普通段落文本交给模板样式控制。
    lines: list[str] = []
    title = (payload.title or "导出试卷").strip()
    if title:
        lines.append(title)
        lines.append("")

    # 按 index 排序，避免前端顺序异常
    sorted_questions = sorted(payload.questions, key=lambda q: q.index)

    for q in sorted_questions:
        # 每题前加一个题号行，作为普通段落文本（非 Markdown 标题）
        lines.append(f"第{q.index}题")
        lines.append("")
        # 题目自身的 markdown 内容
        body = (q.markdown or "").strip()
        if body:
            lines.append(body)
            lines.append("")

    markdown_text = "\n".join(lines).strip() + "\n"

    # 使用临时目录存放中间文件
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            md_path = tmp_path / "paper.md"
            docx_path = tmp_path / "paper.docx"

            # 处理内联的 data:image/base64 图片，将其解码为临时文件，
            # 并把 Markdown 中的引用替换为相对文件路径，便于 Pandoc 作为“原图”嵌入。
            img_pattern = re.compile(
                r"!\[[^\]]*\]\((data:image/(png|jpeg|jpg);base64,(.+?))\)",
                re.IGNORECASE | re.DOTALL,
            )

            img_counter = {"i": 1}

            def _replace_data_image(match: re.Match) -> str:  # type: ignore[type-arg]
                try:
                    mime_subtype = (match.group(2) or "png").lower()
                    # group(3) 可能包含额外的前缀，例如重复的 data:image/...;base64,
                    # 因此前仅取最后一个逗号后的部分作为真正的 base64 数据。
                    raw_tail = (match.group(3) or "").strip()
                    b64_data = raw_tail.split(",")[-1].strip()
                    ext = "png" if mime_subtype == "png" else "jpg"
                    idx = img_counter["i"]
                    img_counter["i"] += 1
                    filename = f"image_{idx}.{ext}"
                    out_path = tmp_path / filename
                    out_path.write_bytes(base64.b64decode(b64_data))
                    # 在 markdown 中使用相对文件名，配合 subprocess 的 cwd=tmpdir，
                    # 让 Pandoc 在临时目录下查找资源文件。
                    return f"![]({filename})"
                except Exception:
                    # 出现异常时保留原始内容，避免整体导出失败
                    return match.group(0) or ""

            markdown_for_pandoc = img_pattern.sub(_replace_data_image, markdown_text)

            md_path.write_text(markdown_for_pandoc, encoding="utf-8")

            try:
                backend_root = Path(__file__).resolve().parents[2]
                templates_root = backend_root / "templates"
                word_templates_dir = templates_root / "word_templates"
                templates_dir = (
                    word_templates_dir if word_templates_dir.exists() else templates_root
                )

                reference_doc: Path | None = None
                if payload.template_key:
                    candidate = templates_dir / f"{payload.template_key}.docx"
                    if not candidate.exists():
                        raise HTTPException(
                            status_code=400,
                            detail="指定的导出模板不存在",
                        )
                    reference_doc = candidate
                else:
                    default_candidate = templates_dir / "export_reference.docx"
                    if default_candidate.exists():
                        reference_doc = default_candidate

                cmd = [
                    "pandoc",
                    str(md_path),
                    "-o",
                    str(docx_path),
                    "--standalone",
                ]
                if reference_doc is not None:
                    cmd.extend(["--reference-doc", str(reference_doc)])

                result = subprocess.run(
                    cmd,
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    encoding="utf-8",
                    cwd=str(tmp_path),
                )
            except FileNotFoundError as exc:
                logger.exception("pandoc not found when exporting word")
                raise HTTPException(
                    status_code=500,
                    detail="服务器未安装 pandoc，无法导出 Word 文档",
                ) from exc
            except subprocess.CalledProcessError as exc:  # pragma: no cover - 运行时错误
                logger.error("pandoc failed: stdout=%s stderr=%s", exc.stdout, exc.stderr)
                raise HTTPException(
                    status_code=500,
                    detail="生成 Word 文档失败，请稍后重试",
                ) from exc

            if not docx_path.exists():
                logger.error("pandoc finished but docx not found: %s", docx_path)
                raise HTTPException(
                    status_code=500,
                    detail="生成的 Word 文档不存在，请联系管理员",
                )

            data = docx_path.read_bytes()

    except HTTPException:
        # 已有明确错误信息，直接抛出
        raise
    except Exception as exc:  # pragma: no cover - 防御性兜底
        logger.exception("unexpected error when exporting word")
        raise HTTPException(status_code=500, detail="导出 Word 文档时发生未知错误") from exc

    # 使用简单的文件名，避免特殊字符导致的问题
    plain_title = title or "export"
    safe_ascii = "".join(ch if ch.isascii() else "_" for ch in plain_title) or "export"
    filename_ascii = f"{safe_ascii}.docx"
    filename_utf8 = quote(f"{plain_title}.docx")
    content_disposition = (
        f'attachment; filename="{filename_ascii}"; filename*=UTF-8\'\'{filename_utf8}'
    )

    return Response(
        content=data,
        media_type=(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
        headers={
            "Content-Disposition": content_disposition,
        },
    )
