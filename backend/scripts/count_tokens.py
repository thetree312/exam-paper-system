import argparse
from pathlib import Path

try:
    import tiktoken
except Exception:  # pragma: no cover
    tiktoken = None


def build_encoder(model_name: str) -> "tiktoken.Encoding | None":
    """
    Return a tokenizer encoding compatible with the specified model.

    Qwen/Qwen2 仍未在 tiktoken 中提供单独的 encoding 名称，这里优先尝试
    encoding_for_model；若失败则回退到通用的 cl100k_base。
    """
    if tiktoken is None:
        return None
    try:
        return tiktoken.encoding_for_model(model_name)
    except KeyError:
        try:
            return tiktoken.get_encoding("cl100k_base")
        except Exception:
            return None


def approximate_tokens(text: str) -> int:
    # 经验：中英文混合文本平均每 3.5~4.5 字符 ≈ 1 token
    avg_chars_per_token = 4.0
    return max(1, int(len(text) / avg_chars_per_token))


def count_tokens(file_path: Path, model_name: str) -> tuple[int, bool]:
    text = file_path.read_text(encoding="utf-8")
    encoder = build_encoder(model_name)
    if encoder is None:
        return approximate_tokens(text), False
    try:
        return len(encoder.encode(text)), True
    except Exception:
        return approximate_tokens(text), False


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Count tokenizer tokens for a given text/JSON file.",
    )
    parser.add_argument(
        "file",
        type=Path,
        help="Path to the text / JSON file (e.g. backend/app/logs/*.json)",
    )
    parser.add_argument(
        "--model",
        default="qwen-turbo",
        help="Model name passed to tiktoken (default: qwen-turbo).",
    )
    args = parser.parse_args()

    if not args.file.exists():
        raise SystemExit(f"File not found: {args.file}")

    tokens, exact = count_tokens(args.file, args.model)
    print(f"File: {args.file}")
    print(f"Model: {args.model}")
    if exact:
        print(f"Token count: {tokens} (exact)")
    else:
        print(
            f"Token count (approx): {tokens} "
            "(fallback used，因为无法加载 tiktoken 模型编码或缺少网络缓存)"
        )


if __name__ == "__main__":
    main()
