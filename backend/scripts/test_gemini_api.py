"""Interactive Gemini API key tester.

This script lets you paste a Gemini API key, fetches available models, and
optionally runs a minimal content-generation call to confirm the key works.
"""
from __future__ import annotations

import json
import sys
from typing import Any

import requests

LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
PROMPT_TEXT = "请简单自我介绍，并确认我可以使用 Gemini API。"

def prompt_api_key() -> str:
    """Prompt the user for the Gemini API key with visible input."""
    api_key = input("请输入 Gemini API Key（可见输入，回车确认）：").strip()
    if not api_key:
        print("[错误] API Key 为空，测试终止。")
        sys.exit(1)
    return api_key

def fetch_models(api_key: str) -> list[dict[str, Any]]:
    """Call the list-models endpoint to verify the key and get enabled models."""
    params = {"key": api_key}
    try:
        resp = requests.get(LIST_MODELS_URL, params=params, timeout=20)
    except requests.RequestException as exc:
        print(f"[错误] 无法访问 Gemini API：{exc}")
        sys.exit(1)

    if resp.status_code != 200:
        print(f"[错误] API Key 校验失败，状态码 {resp.status_code}: {resp.text}")
        sys.exit(1)

    payload = resp.json()
    models = payload.get("models") or []
    gemini_models = [m for m in models if "gemini" in m.get("name", "").lower()]
    if not gemini_models:
        print("[警告] 未在此账号下查询到 gemini* 模型，以下为原始响应：")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        sys.exit(1)
    return gemini_models

def choose_model(models: list[dict[str, Any]]) -> str:
    """Display models and let user choose one."""
    print("\n可用模型：")
    for idx, model in enumerate(models, start=1):
        display = model.get("displayName") or model.get("name")
        supported = ", ".join(model.get("supportedGenerationMethods", [])) or "(no methods)"
        print(f"  [{idx}] {display} | {supported}")
    while True:
        choice = input("\n请输入要测试的模型序号：").strip()
        if not choice.isdigit():
            print("请输入有效数字。")
            continue
        idx = int(choice)
        if 1 <= idx <= len(models):
            return models[idx - 1]["name"]
        print("序号超出范围，请重试。")

def run_test_completion(api_key: str, model_name: str) -> None:
    """Send a minimal generateContent request to confirm the key works."""
    url = f"https://generativelanguage.googleapis.com/v1beta/{model_name}:generateContent"
    headers = {"Content-Type": "application/json"}
    body = {
        "contents": [
            {
                "parts": [
                    {"text": PROMPT_TEXT},
                ]
            }
        ]
    }
    params = {"key": api_key}
    try:
        resp = requests.post(url, params=params, headers=headers, json=body, timeout=30)
    except requests.RequestException as exc:
        print(f"[错误] 调用模型失败：{exc}")
        sys.exit(1)

    if resp.status_code != 200:
        print(f"[错误] 模型调用返回 {resp.status_code}: {resp.text}")
        sys.exit(1)

    data = resp.json()
    print("\n[成功] 模型响应片段：")
    candidate = (data.get("candidates") or [{}])[0]
    content = candidate.get("content", {}).get("parts", [{}])[0].get("text", "")
    print(content or json.dumps(data, ensure_ascii=False, indent=2))

def main() -> None:
    print("=== Gemini API Key 测试助手 ===")
    api_key = prompt_api_key()
    models = fetch_models(api_key)
    model_name = choose_model(models)
    print(f"\n将使用模型：{model_name}")
    run_test_completion(api_key, model_name)
    print("\n全部测试完成，API Key 可正常访问该模型。")

if __name__ == "__main__":
    main()
