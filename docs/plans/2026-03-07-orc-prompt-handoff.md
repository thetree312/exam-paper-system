## 背景

这份交接文档只覆盖当前这条链：

- `backend/app/assistant_graph/nodes/orc_loop.py`
- `backend/app/assistant_graph/nodes/context_init.py`
- `backend/app/assistant_graph/nodes/execution_runtime.py`
- `backend/app/assistant_graph/tool_registry.py`
- `backend/app/services/tool_search_service.py`
- `backend/app/services/rag_service.py`
- 相关测试

不要把这份文档理解成整个仓库的总交接。当前工作区本身很脏，且存在大量与本链路无关的改动。

---

## 本轮已确认的事实

### 1. `版本2.txt` 本身没有乱码

- `backend/版本2.txt` 是正常 UTF-8 文本。
- 之前把 prompt 改成 `????` / 问号，是写入链路的问题，不是源文件的问题。

### 2. ORC prompt 现已替换为 `版本2.txt` 内容

当前 `backend/app/assistant_graph/nodes/orc_loop.py` 中：

- `SYSTEM_PROMPT_TEMPLATE` 已经是 `版本2.txt` 的中文内容
- 不是旧的 `ORC Learning Coach Agent` 英文模板
- 不是问号乱码模板

已验证：

- 文件编码：UTF-8，无 BOM
- `py_compile` 通过

### 3. 世界观里 `resource:source_file:*` 的来源与含义已确认

`resource:source_file:1054`：

- 不是 workspace 资源
- 来自 workroom 绑定的 `source_file_ids`
- 应属于 `kb` 域

当前修正状态：

- `context_init.py` 里 active object 已显式带 `domain`
- `resource:source_file:*` 应标记为 `domain="kb"`

### 4. 当前 agent 行为问题已经从“完全失明”收缩为更具体的问题

已经不是：

- 看不到 world model
- 看不到图
- KB 永远拿不到视觉资产

已经确认是：

1. ORC 角色定位过于像调度器/控制器
2. `tool_search` 检索层仍会带回误导性 workspace 工具
3. ORC 拿到视觉证据后，仍可能退回“还要不要继续调工具”的规划人格
4. ORC 在重文本上下文下，会把“看图取证”变成“自己解释题意”

---

## 本轮已做的改动

### 1. ORC prompt 已改为 `版本2`

文件：

- `backend/app/assistant_graph/nodes/orc_loop.py`

当前方向：

- 先局面判断
- 再识别主要障碍
- 再设中间目标
- 最后才选动作

目标：

- 降低 “先动作、后理解” 的倾向
- 让 ORC 更像单 agent learning coach，而不是纯 orchestrator

### 2. `tool_search` 目录语义做过一次降噪

文件：

- `backend/app/services/tool_search_service.py`

方向：

- 降低 `input_hint/schema` 对 embedding 的污染
- 提高 `domain/capability/reads_kinds/acts_on_domains` 的比重

状态：

- 已做一版
- 但目前从实战表现看，首轮召回仍存在 workspace 偏置

### 3. KB 检索已从单通道改为 text/image 双通道

文件：

- `backend/app/services/rag_service.py`
- `backend/app/assistant_graph/nodes/execution_runtime.py`

状态：

- 已经能拿到 `asset_refs > 0`
- 已经能把视觉资产注入 ORC
- 当前问题已不再是 “KB 没图”

### 4. 新增/修正过日志

主要日志点：

- `kb.evidence.assets`
- `orc.visual_context`
- `qwen.payload`

用途：

- 确认送进模型的具体图片
- 确认图片顺序
- 确认同轮文本负担

---

## 当前已验证的结论

### A. 当前错误答案不是因为“没送图”

日志已确认：

- ORC 轮次里 `vision_assets` 已注入
- `qwen.payload` 中存在 `images=2`

因此不能再把问题归因到：

- 图没送进去
- 多模态没启用

### B. 当前错误答案也不能简单归因到“整页图看不清”

用户已用同类整页图在 API 平台手测过，`qwen3.5-plus` 可以正确读图。

因此当前更应优先怀疑：

1. 图像顺序/页绑定/问题绑定
2. 同轮文本上下文过重，干扰视觉判断
3. ORC 在拿到图后继续以调度器身份重新规划
4. ORC 把图像证据和题意解释混成了一步

### C. `tool_search` 是无智能检索层，前半段偏航不能甩锅给它“自己决策”

正确理解：

- `tool_search` 没有 LLM 智能
- 它只执行 ORC 发出的自然语言 query

但目前工具目录语义和排序机制，会把合理 query 仍然带向一批误导性工具。

所以问题是双层的：

1. ORC 的 query 生成
2. tool catalog 的召回与排序

### D. 首轮 query 已经比过去好，但还不够“世界观进入决策”

实际 query 例子：

> 需要读取 document 域中 source_file 的内容解析工具，能够提取题目编号、图例信息和向量坐标数据

这说明 ORC 已经开始吸收对象域信息。

但问题仍在于：

- 它写成了“能力需求描述”
- 而不是“带对象域约束的检索意图”

例如：

- `提取题目编号` 会误导到 workspace index 工具
- 缺少 “不依赖 workspace 已有对象” 这类约束

---

## 当前未完成项

### 1. ORC 的角色还没真正从 planner 收束为 answerer

具体表现：

- 明明已拿到 `vision_assets`
- 明明已知道 `kb_evidence` 有 answerable evidence
- 但后续迭代仍会重新问“是不是还需要调用工具”

这是当前最核心的 prompt / role 问题。

### 2. `tool_search` 仍会把 workspace 工具排到太前

注意：

- 目标不是强行让 `read_kb_evidence` 永远第一
- 真正要修的是：
  - query 结构
  - 工具定义边界
  - 目录语义重排
  - 让世界状态真正进入检索层

### 3. ORC 的视觉轮文本负担过重

现象：

- 带图轮次 `text_chars` 仍很大
- 模型是在“长文本 + 两张图”里做混合推理

待解决问题：

- 视觉轮是否应做更强的上下文裁剪
- 当前 `Current context JSON` 和 task memory 是否过重

### 4. trace 仍然会暴露模型自己的错误自然语言改写

例如：

- 明明对象是 `domain="kb"` 的 `resource:source_file:*`
- trace 里仍写成“工作区有一个资源文件”

这说明：

- state 修正了
- 但 trace 生成/暴露方式还没修

---

## 本轮做错过的事

这个需要显式写出来，避免新会话重复踩坑。

1. 曾错误把终端显示问题当成源文件乱码
2. 曾通过 shell/stdin 链路直接写中文，导致部分文件内容真的被写成 `?`
3. 这个坑已经确认存在，所以后续如果再需要批量写中文：
   - 不要用会经过 PowerShell stdin 编码链的直接写法
   - 优先用明确 `encoding='utf-8'` 的文件写入
   - 必要时用 `\\u` 转义写测试字面量

---

## 已验证通过的最小检查

### 1. prompt 相关

已通过：

```powershell
.\\.venv\\Scripts\\python.exe -m py_compile app\\assistant_graph\\nodes\\orc_loop.py
.\\.venv\\Scripts\\python.exe -m pytest tests\\assistant_graph\\test_orc_loop_world_snapshot_prompt.py tests\\assistant_graph\\test_context_init_world_snapshot.py -q
```

结果：

- `py_compile` 通过
- `2 passed`

### 2. 编码状态

已确认：

- `backend/app/assistant_graph/nodes/orc_loop.py` 为 UTF-8
- 无 BOM
- prompt 正文为真实中文，不是 `?`

---

## 下一会话建议起点

建议新会话直接从这 3 件事开始，不要重新回到“大而泛”的世界观讨论：

### 优先级 1：审 ORC 视觉轮

目标：

- 查清楚 ORC 在 `vision_assets` 已注入后，为什么仍会继续走“工具规划人格”

优先文件：

- `backend/app/assistant_graph/nodes/orc_loop.py`

重点看：

- role 定位
- 收束条件
- 视觉轮上下文裁剪

### 优先级 2：审 `tool_search` query 与召回结构

目标：

- 不要做“让某工具永远第一”的特例修复
- 要看为什么带有 `document 域 / source_file` 的 query 仍会召回大量 workspace 工具

优先文件：

- `backend/app/services/tool_search_service.py`
- `backend/app/assistant_graph/tool_registry.py`
- `backend/app/assistant_graph/nodes/execution_runtime.py`

### 优先级 3：审 trace 语言层

目标：

- 不再让 trace 把 `kb` 对象说成 “工作区资源”
- 不再让 trace 暴露中英混杂和原始错误自述

优先文件：

- `backend/app/assistant_graph/nodes/orc_loop.py`
- `backend/app/assistant_graph/stream_registry.py`

---

## 新会话可直接使用的启动提示

建议新会话第一句直接用这个：

```text
先阅读 docs/plans/2026-03-07-orc-prompt-handoff.md，然后只沿 ORC 视觉轮收束、tool_search 召回偏置、trace 语言层这三条继续排查和实现，不要重开大范围世界观讨论。
```

