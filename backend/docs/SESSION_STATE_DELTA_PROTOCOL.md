# 会话状态增量更新协议 (ΔS Protocol)

## 概述

本文档描述"分层记忆总线"中的 **ΔS 写回链路**，即会话状态（Session State）的增量更新机制。该机制允许 Agent 在每轮对话中逐步积累和更新学生的学习画像，而无需每次都重新生成完整状态。

## 架构设计

### 核心组件

1. **AgentState.session_state** - 结构化会话状态（S 层）
   - 存储学生的知识掌握度、错误模式、学习偏好等
   - 替代/补充旧版 `session_profile`

2. **AgentState.session_state_patch** - 增量补丁（ΔS）
   - 由 `solver_reply_node` 在每轮对话后产出
   - 仅包含本轮新增或更新的字段
   - 由 `context_node` 在下一轮开始时合并

### 数据流

```
┌─────────────────┐
│  context_node   │  ← 读取上一轮的 session_state_patch
│  (轮次 N+1)     │  ← 合并到 session_state
└────────┬────────┘
         │ session_state (已更新)
         ↓
┌─────────────────┐
│ supervisor_node │
└────────┬────────┘
         ↓
┌─────────────────┐
│  solver_node    │
└────────┬────────┘
         ↓
┌─────────────────┐
│solver_reply_node│  ← LLM 产出 session_state_patch
│  (轮次 N)       │  ← 提取并写入 state
└────────┬────────┘
         │ session_state_patch (新增)
         ↓
┌─────────────────┐
│  persist_node   │  ← 持久化 session_state 到数据库
└─────────────────┘
```

## 实现细节

### 1. LLM 产出格式

在 `solver_reply_node` 中，LLM 被指示在回复末尾使用特殊标记输出增量更新：

```markdown
【学生回复内容】
...正常的教学内容...

```session_state_patch
{
  "mastery_full": {
    "二次函数": "已掌握",
    "因式分解": "需加强"
  },
  "error_patterns": ["符号错误", "漏项"],
  "learning_style": "偏好图形化解释",
  "difficulty_pref": "medium"
}
```
```

### 2. 提取与清理

`solver_reply_node` 使用正则表达式提取 patch：

```python
patch_pattern = r"```session_state_patch\s*\n(.*?)\n```"
match = re.search(patch_pattern, reply, re.DOTALL | re.IGNORECASE)
if match:
    patch_json = match.group(1).strip()
    session_state_patch = json.loads(patch_json)
    # 从用户可见回复中移除 patch 标记
    clean_reply = re.sub(patch_pattern, "", reply, flags=re.DOTALL | re.IGNORECASE).strip()
```

### 3. 增量合并

`context_node` 在下一轮开始时执行合并：

```python
session_state = state.get("session_state") or {}
session_state_patch = state.get("session_state_patch")

if isinstance(session_state_patch, dict) and session_state_patch:
    session_state = _merge_session_profile(session_state, session_state_patch)
    logger.info("session_state_patch_merged: %s", list(session_state_patch.keys()))
    new_state["session_state_patch"] = None  # 清空，避免重复合并
```

### 4. 深度合并策略

`_merge_session_profile` 函数支持嵌套字典的深度合并：

```python
def _merge_session_profile(base: dict | None, patch: dict | None) -> dict:
    """合并会话画像/状态的增量补丁。支持嵌套字典的深度合并。"""
    if not isinstance(base, dict):
        base = {}
    if not isinstance(patch, dict):
        return base
    merged = dict(base)

    # 对于嵌套字典字段（如 mastery_full），执行深度合并
    for key in ("preferences", "constraints", "progress", "mastery_full", "error_patterns"):
        src = base.get(key)
        upd = patch.get(key)
        if isinstance(src, dict) and isinstance(upd, dict):
            tmp = dict(src)
            tmp.update(upd)  # 字典级别的更新
            merged[key] = tmp
        elif upd is not None:
            merged[key] = upd
    
    # 处理其他字段（直接覆盖）
    for k, v in patch.items():
        if k not in ("preferences", "constraints", "progress", "mastery_full", "error_patterns"):
            merged[k] = v
    
    return merged
```

### 5. 持久化

`persist_node` 将最终的 `session_state` 写入数据库：

```python
session_state = state.get("session_state")
if not isinstance(session_state, dict):
    session_state = state.get("session_profile") or {}  # 向后兼容

svc.update_session_profile(
    tenant_id=tenant_id,
    session_id=session_id,
    profile=session_state,
    history_summary=history_summary
)
```

## 支持的字段

### 核心字段

| 字段名 | 类型 | 说明 | 合并策略 |
|--------|------|------|----------|
| `mastery_full` | dict | 知识点掌握度详情 | 深度合并 |
| `mastery_brief` | str | 知识点掌握度摘要 | 覆盖 |
| `error_patterns` | list/dict | 常见错误模式 | 深度合并 |
| `learning_style` | str | 学习风格偏好 | 覆盖 |
| `difficulty_pref` | str | 难度偏好 (easy/medium/hard) | 覆盖 |
| `tone_preference` | str | 语气偏好 | 覆盖 |
| `practice_preferences` | dict | 练习偏好 | 深度合并 |
| `active_topic_ids` | list | 当前活跃话题 | 覆盖 |
| `recent_difficulty_feedback` | str | 最近难度反馈 | 覆盖 |

### 扩展字段

可根据需要添加自定义字段，系统会自动处理：
- 字典类型字段建议在 `_merge_session_profile` 中添加到深度合并列表
- 其他类型字段默认采用覆盖策略

## 视图投影

不同节点通过 `_session_state_view` 获取裁剪后的状态视图，避免 token 浪费：

```python
SESSION_STATE_VIEW_FIELDS = {
    "supervisor": ["mastery_brief", "active_topic_ids", "recent_difficulty_feedback"],
    "solver_intent": ["mastery_brief", "error_patterns", "practice_preferences"],
    "solver_reply": ["mastery_full", "learning_style", "difficulty_pref", "error_patterns"],
    "direct_reply": ["tone_preference"],
}
```

## 日志追踪

关键日志点：

1. **提取成功**：
   ```
   agent.graph.solver_reply.session_state_patch_extracted tenant=X user=Y patch_keys=['mastery_full', 'error_patterns']
   ```

2. **合并成功**：
   ```
   agent.graph.context.session_state_patch_merged tenant=X user=Y patch_keys=['mastery_full']
   ```

3. **持久化成功**：
   ```
   persist_node.profile_ok tenant=X session=Y state_keys=['mastery_full', 'learning_style'] summary_len=320
   ```

## 向后兼容

- `session_profile` 字段保留，用于旧代码兼容
- 新代码优先使用 `session_state`
- `persist_node` 同时更新两个字段
- 首次运行时自动从 `session_profile` 迁移到 `session_state`

## 最佳实践

### LLM Prompt 设计

在 Skill 模板中引导 LLM 产出结构化 patch：

```markdown
【会话状态更新协议】
在本轮对话结束后，如果你观察到学生的知识掌握、错误模式、学习偏好等方面有新的信息，
请在回复末尾用 JSON 代码块标记更新内容：

```session_state_patch
{
  "mastery_full": {"知识点A": "已掌握", "知识点B": "需加强"},
  "error_patterns": ["常见错误类型"],
  "learning_style": "偏好描述",
  "difficulty_pref": "easy|medium|hard"
}
```

仅包含本轮新增或更新的字段，系统会自动合并到会话状态中。
```

### 错误处理

- JSON 解析失败时记录警告，不中断流程
- patch 为空时跳过合并
- 字段类型不匹配时采用覆盖策略

### 性能优化

- 仅在有 patch 时执行合并
- 视图投影减少 token 消耗
- Top-K 截断大字典（如 `mastery_full` 只保留前 5 项）

## 未来扩展

### RAG 集成

当 `rag_enabled=True` 时，可在 patch 中包含检索到的知识点：

```json
{
  "retrieved_concepts": ["相关概念1", "相关概念2"],
  "rag_context_used": true
}
```

### 多模态支持

视觉理解结果可写入 patch：

```json
{
  "visual_understanding": {
    "图表类型": "函数图像",
    "关键特征": ["对称轴", "顶点"]
  }
}
```

### 协作学习

多学生会话可共享部分状态：

```json
{
  "group_progress": {
    "共同难点": ["因式分解"],
    "协作记录": [...]
  }
}
```

## 总结

ΔS 写回链路通过以下机制实现会话状态的渐进式演化：

1. **产出**：`solver_reply_node` 让 LLM 输出结构化 patch
2. **传递**：patch 通过 `AgentState.session_state_patch` 传递
3. **合并**：`context_node` 在下一轮开始时执行深度合并
4. **持久化**：`persist_node` 将最终状态写入数据库
5. **投影**：各节点通过视图获取所需字段，控制 token 预算

这套机制确保了会话状态的连续性和准确性，为个性化教学提供了坚实基础。
