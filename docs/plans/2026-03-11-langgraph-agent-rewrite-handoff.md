# 2026-03-11 LangGraph Agent Rewrite Handoff

## 目的

这份文档给下一个接手的人说明三件事：

1. 这次为什么放弃旧 ORC / Deep Agents 路线，回到单一 LangGraph 主链。
2. 我实际改了什么，以及这些改动各自想解决什么问题。
3. 当前实现为什么仍然不可用，下一步应该从哪里继续，而不该再走哪些回头路。

这不是一份“完成总结”，而是一份**失败重构实验的交接文档**。

## 当前结论

当前 agent **仍然不可用**。

不是“行为还要继续优化”这么简单，而是：

- agent 主链虽然收成了单一 LangGraph graph，但仍然带有明显状态机味道；
- 真实 trace 里它仍然会重复找工具，而不是基于观察自然收束；
- 前端 trace 刚刚从“工具碎片流”改成 `thought / tool_call / tool_result` 三类事件，但还没经过真实场景验证；
- 多轮、会话连续性、证据足够后的自然终答，仍然需要继续验证。

所以这次交接的重点不是“继续微调 prompt”，而是：

**保持 LangGraph 单轨，继续削弱状态机味，强化 observe/world-update 这一层。**

## 这次为什么这样改

### 1. 放弃旧 ORC 路线

旧 ORC 路线的问题已经不是局部 bug，而是架构性失败：

- 环境解释、工具调度、停机收口、兼容逻辑都堆在一起；
- 多轮里会话、对话轮次、运行态混在一起；
- 大量工程侧提示和补丁逻辑污染 agent 行为；
- 文件数多、入口多、兼容层多，后续根本没人能看懂。

结论是：旧 ORC 不能再补。

### 2. 试了 Deep Agents，结果选错了

后面一度切去 `Deep Agents`，原因是我误把“当前 agentic 不够”判断成了“LangGraph 不够 agentic”。

这是错误判断。

你这个场景要的不是 Deep Agents 的 harness，而是：

- 单一会话；
- 清晰 world state；
- 清晰工具边界；
- 明确的 trace；
- 对前端工作区/知识库环境的最小描述。

这些 LangGraph 本来就能做。

所以后来又把 `Deep Agents` 整条主链删掉，回到 LangGraph。

### 3. 回到 LangGraph，但第一版还是写成了状态机

回到 LangGraph 后，最开始写成了：

- `agent -> tools -> agent`

虽然外壳是 LangGraph，但内里还是传统工具循环状态机。

这个版本的几个典型问题：

- 系统提示、工具描述、环境消息发生乱码；
- trace 解析把流式 tool call 拆成碎片往前端发；
- graph 路由只看有没有 `tool_calls`，不看“证据是否已足够”；
- 前端看不到独立的思考轨迹，只看到工具名和正文混排。

所以这次最后一轮改动，重点不是再调 prompt，而是先修：

- 文本可读性；
- graph 节点职责；
- trace 事件模型。

## 这次实际改了什么

### A. 结构清理：只保留一套 agent 逻辑

现在 agent 相关逻辑集中在：

- `backend/app/assistant_graph/agent_graph.py`
- `backend/app/assistant_graph/agent_tools.py`
- `backend/app/assistant_graph/router_runtime.py`
- `backend/app/assistant_graph/session_runtime.py`
- `backend/app/assistant_graph/runtime_bootstrap.py`

`router` 只作为 HTTP 入口存在：

- `backend/app/routers/agent_v2.py`

删除或退出主链的内容包括：

- `deep_agent_harness.py`
- agent 专属 service helper
- archived legacy subagents
- 旧 ORC / context_init / session_runtime_init / agent_step 主链

目标很简单：

**仓库里只留一套 agent 主链。**

### B. Graph 改成 `reason -> act -> observe`

`backend/app/assistant_graph/agent_graph.py` 现在已经不是：

- `agent -> tools -> agent`

而是：

- `reason`
- `act`
- `observe`

职责如下：

- `reason`
  - 负责调模型；
  - 只根据消息历史和系统提示决定下一步；
- `act`
  - 只执行工具调用；
  - 不直接把工具结果塞进消息；
- `observe`
  - 把工具结果转成 `ToolMessage`；
  - 更新 `last_action_result`；
  - 再回到 `reason`。

这么改的目的：

- 先把“推理”和“执行”拆开；
- 再把“执行”和“观察/更新世界”拆开；
- 避免 LangGraph graph 继续退化成线性工具循环状态机。

### C. 修 trace：从碎片事件改成聚合后的三类事件

`backend/app/assistant_graph/router_runtime.py` 里现在有：

- `iter_stream_trace_events(...)`
- `StreamTraceReducer`

事件被收成三类：

- `thought`
- `tool_call`
- `tool_result`

这次修复的核心点：

- 带工具调用的 assistant 文本，不再当正文 delta，而当 `thought` trace；
- 分裂的 tool call 片段会先在后端聚合，再往前端发；
- 前端不该再只看到 `tool=name args=None` 这种碎片。

对应地，`backend/app/routers/agent_v2.py` 的 `run-stream` 现在已经切到：

- 先走 `normalize_stream_event`
- 再走 `iter_stream_trace_events`
- 再走 `StreamTraceReducer`
- 最后把聚合后的 trace 发给前端

### D. 清理工具语义文本

`backend/app/assistant_graph/agent_tools.py` 里的工具 schema 已经用正常中文重写，目的不是润色，而是让模型至少能正确区分：

- `read_kb_evidence`
- `read_workspace_index`
- `read_workspace_assets`
- `write_workspace_focus`

这些工具各自适用的地方。

## 为什么这么改

因为前一版的失败，不是单点问题，而是三层同时坏：

1. **文本层坏**
   - 提示和工具描述乱码；
   - 模型从一开始就被喂坏。

2. **编排层坏**
   - graph 只有机械循环；
   - 没有真正的 observe/world-update 语义。

3. **可观测性坏**
   - 前端只有正文或工具名；
   - 后端 trace 全是碎片；
   - 出问题时根本不知道是模型错、工具错、还是路由错。

这次改动的目标不是“让 agent 一下变聪明”，而是先把这三层拉回可调试、可重构的状态。

## 当前仍然存在的问题

### 1. 仍然有状态机味

虽然 graph 已经拆成 `reason -> act -> observe`，但它是否真正实现了“观察后改变世界，从而改变下一轮推理”，仍然要看真实 trace。

目前 `observe` 做的仍然偏浅：

- 主要是把工具结果写回 `messages`；
- 再更新一个 `last_action_result`；
- 还没有形成更强的“世界变化”语义。

换句话说：

**这次只是把状态机拆薄了，不等于已经变成了真正的 agentic runtime。**

### 2. 会话连续性问题还没有完成验收

之前真实问题之一是：

- `no-doc` 路径下，每轮可能都像新的 run；
- 会话和对话轮次混淆。

这次没有重新大改 `session_runtime.py`，所以这部分仍然需要用真实场景重新验证。

### 3. 证据足够后的自然收束还没确认

之前 agent 常见的问题是：

- 已经拿到图和文本证据；
- 但仍继续找工具，不会自然停下来回答。

这次 graph 虽然拆了节点，但没有加任何“规则引擎式 sufficiency rule”。这本身是对的，但也意味着：

**现在还不知道 observe 后的消息历史，是否足以让模型自然收束。**

### 4. 中文显示仍需在真实运行态确认

我已经把工具文本和环境文本按正常 UTF-8 中文重写了，但本地 PowerShell 读取文件时仍然可能显示成乱码。

这件事要以真实前端/后端运行结果为准，不要只看 PowerShell 输出。

## 这次验证过什么

### 定向测试

- `tests/assistant_graph/test_agent_stream_trace_events.py`
  - 锁住：
    - `thought` 事件；
    - `tool_call` 事件；
    - `tool_result` 事件；
    - fragmented tool call 聚合。

- `tests/assistant_graph/test_agent_graph_runtime.py`
  - 锁住：
    - graph 节点名为 `reason/act/observe`；
    - 不再存在 `agent/tools` 旧主链；
    - 核心文案应是可读中文。

### 全量测试

运行过：

```bash
.\.venv\Scripts\python.exe -m pytest tests/assistant_graph -q
```

结果：

- `31 passed`

### 语法检查

运行过：

```bash
python -m py_compile app/assistant_graph/agent_graph.py app/assistant_graph/agent_tools.py app/assistant_graph/router_runtime.py app/routers/agent_v2.py
```

结果：

- 通过

## 下一个接手的人应该怎么继续

### 优先级 1：先看真实 trace，不要再盲改

现在最重要的不是继续猜，而是直接跑真实请求，看三件事：

1. 前端 trace 是否已经独立显示为：
   - `thought`
   - `tool_call`
   - `tool_result`
2. tool call 是否仍然被拆成碎片；
3. agent 在拿到足够证据后，是否还会继续找工具。

如果这三件事没有真实 trace 支撑，不要继续改。

### 优先级 2：如果仍然重复找工具，继续改 observe，不要碰 router

下一刀应该落在：

- `backend/app/assistant_graph/agent_graph.py`

而不是 `agent_v2.py`。

具体方向：

- 让 `observe` 不只是把工具结果包成 `ToolMessage`；
- 而是把“世界发生了什么变化”写得更清楚；
- 但不要再回到工程提示/规则引擎/动作菜单那条路。

### 优先级 3：如果会话仍断裂，修 session runtime，而不是再改 graph 文案

需要重点复查：

- `backend/app/assistant_graph/session_runtime.py`
- `backend/app/routers/agent_v2.py`

关注：

- `thread_id` 是否在同一会话内复用；
- `session_id` 是否在 `no-doc` 路径也稳定；
- 是否仍然存在“每轮都新 run”的行为。

## 不要再走的路

下一位接手时，不要再回到这些错误方向：

1. 不要再切回 Deep Agents
2. 不要再恢复旧 ORC / context_init / agent_step 主链
3. 不要再往 router 塞 agent 核心逻辑
4. 不要再用动作菜单、focus/domain 标签、environment_action 这类工程塑形
5. 不要再把环境和工具对象混成同一层心智模型
6. 不要再为了“先别搞挂”而留两套平行主链

## 当前关键文件

### 主要生产文件

- `backend/app/assistant_graph/agent_graph.py`
- `backend/app/assistant_graph/agent_tools.py`
- `backend/app/assistant_graph/router_runtime.py`
- `backend/app/assistant_graph/session_runtime.py`
- `backend/app/assistant_graph/runtime_bootstrap.py`
- `backend/app/routers/agent_v2.py`

### 当前测试文件

- `backend/tests/assistant_graph/test_agent_stream_trace_events.py`
- `backend/tests/assistant_graph/test_agent_graph_runtime.py`

## 最后的判断

这次不是“完成重构”，而是把一条已经失控的主链拉回了**可继续重构**的状态。

当前版本仍然不能被视为可交付 agent。

但和前一版相比，至少已经做到：

- 只剩一套 LangGraph 主链；
- 乱码、trace、graph 节点职责开始被正面处理；
- 后续不会再被 Deep Agents / ORC / router orchestration 多套逻辑同时污染。

所以接下来该做的不是继续打补丁，而是：

**基于这条单轨 LangGraph 主链，继续把 observe/world-update 做实。**
