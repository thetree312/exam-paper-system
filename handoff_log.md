# 工作交接日志

1. 修复环境输入：删除旧的伪环境链（`decision_state.py`、`context_assembler.py`、并行 runtime 相关文件）后，`router.py`+`router_runtime.py`现在直接从实际 `Workroom`、三个面板状态、绑定源、产物、focus 组装 `environment_state`。
2. 保持 runtime 可见性：增加 `_build_runtime_context_block` 及 `_build_runtime_context_message`，`_node_decide` 每轮额外插入当前 runtime 快照（只作用于本轮 `llm_messages`，不写入 `messages`/历史），测试在 `tests/agent/test_runtime_prompt_hygiene.py` 校验该块仅在当前 turn 可见。
3. 工具与 policy 调整：studio 工具改为读取新结构，`tool` 描述去掉暗示；policy/tool meta 不再把 environment 摘要写进 prompt，`world_model`/`runtime_snapshot` 也只跟踪 `center_panel_mode`、`active_center_document_id`、`bound_source_ids` 这些字段。
4. 验证：`pytest tests/agent/... tests/services/...`（共 34 条）以及 `py_compile app/agent/assistant_graph/runtime_bootstrap.py tests/agent/test_runtime_prompt_hygiene.py` 均通过，证明改动没有语法错误，输入处理行为符合预期。

请继续用最新日志验证首轮是否真正感知 runtime 快照、studio bias 是否被缓解。
