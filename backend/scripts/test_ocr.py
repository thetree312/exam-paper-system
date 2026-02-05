from pathlib import Path
import os

backend_root = Path(__file__).resolve().parents[1]
project_model_dir = backend_root / "paddle_models"
project_model_dir.mkdir(exist_ok=True)
resolved_model_dir = str(project_model_dir.resolve())
os.environ["PADDLEOCR_HOME"] = resolved_model_dir
os.environ["PPOCR_HOME"] = resolved_model_dir
os.environ["FLAGS_use_mkldnn"] = "0"
os.environ["FLAGS_use_pinned_memory"] = "0"
os.environ["FLAGS_enable_paddle_mkldnn"] = "0"
os.environ["FLAGS_cpu_deterministic"] = "1"

from paddleocr import PaddleOCR

os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'


def format_markdown(result: list[list[list]]) -> str:
    lines = ["# OCR 识别结果", ""]
    if not result:
        lines.append("未检测到任何文字，可能图片质量问题或模型加载失败。")
        return "\n".join(lines)

    for page_idx, page in enumerate(result, start=1):
        lines.append(f"## 页面 {page_idx}")
        lines.append("")
        for line in page:
            if len(line) < 2:
                continue
            text, score = line[1]
            lines.append(f"- {text.strip()} _(置信度 {score:.4f})_")
        lines.append("")
    return "\n".join(lines).rstrip()


ocr = PaddleOCR(
    lang="ch",
    use_textline_orientation=True,
    det_model_dir=str(project_model_dir / "ch_PP-OCRv4_det_infer"),
    rec_model_dir=str(project_model_dir / "ch_PP-OCRv4_rec_infer"),
    cls_model_dir=str(project_model_dir / "ch_ppocr_mobile_v2.0_cls_infer"),
)


img_path = r"d:\Exam-paper\backend\uploads\2\20260203153529829053_2025年高考全国一卷数学真题.page2.png"

print(f"正在识别图片：{img_path}")

result = ocr.ocr(img_path, cls=True)

markdown_output = format_markdown(result)
output_file = backend_root / "docs" / "ocr_result.md"
output_file.write_text(markdown_output, encoding="utf-8")

print("\n" + markdown_output)
print(f"\nMarkdown 已写入: {output_file}")