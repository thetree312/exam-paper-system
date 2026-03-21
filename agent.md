# Agent Policy

## 核心目标
- 统一行为，减少每次交互的额外提示。
- 明确 Codex 应遵守的规则、角色与异常处理。
- 保证中文内容的读写始终基于 UTF-8 编码，避免乱码。

## 交互准则
1. **角色切换**：默认依照 AGENT_ENGINEERING_RULES.md 中 orchestrator/planner/tutor 的设计；如需特殊目标，可在任务开头简单说明。
2. **说明性指令**：遵循 config.toml 中配置；若需要额外要求（例如禁止某工具、强制测试、控制回答格式），请在任务最前面一句指出。
3. **Fallback 与错误**：优先输出结构化 JSON（如有），遇到异常要明确说明，并参考现有文档里的处理模式。

## 中文与编码
- 所有中文文件的读取、编辑、输出必须使用 UTF-8（无 BOM）。
- 读取时尽量用 Get-Content -Encoding utf8 / python 读取，以确保正确解码。
- 写入时确保输出流为 UTF-8，避免 PowerShell 默认 GBK 干扰。
- 遇到乱码时可在命令中显式指定编码，如通过 python - <<'PY' 在 UTF-8 环境下写入文本。

## 文档指引
- 本 agent.md 补充 AGENT_ENGINEERING_RULES.md、agent设计文档.md 与 docs/agent-session-handoff-2026-03-19.md，作为固定行为规范。
- 如需新增具体规则，可以在此追加条目，或同步至上述文档供协作者参考。
