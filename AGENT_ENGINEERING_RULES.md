---
description: Agent 工程行为规范与禁令
---

# Agent 工程行为规范与禁令

> 本文是对近期一系列「特例优化 / if-else 掩盖问题 / 把 Agent 写成假路由器 / 用 Prompt 写语义 if-else / 自作聪明 fallback」行为的**反思与硬性约束**。后续在本仓库（尤其是 `backend/app/assistant_graph`、`qwen_client`、各 Agent Prompt）中必须严格遵守。

## 一、原则：问题必须被看见，而不是被掩盖

- **禁止目标**：
  - 禁止任何形式的「先让它跑起来再说」式补丁。
  - 禁止通过代码分支或 Prompt 规则，把本该暴露出来的协议错误 / 模型错误 / 设计问题「糊过去」。
- **要求**：
  - 如果后端协议不满足预期：要么修协议，要么直接抛错，让调用栈和日志清楚可见；
  - 不允许在 Python 里帮 LLM 做决策；不允许在 Prompt 里写「如果 A 则必须 B」这种语义化 if-else 去兜底。

## 二、禁止的具体行为

### 1. 禁止在 Agent 工程里写决策性 if/else

**范围**：`backend/app/assistant_graph` 下所有节点（orchestrator、planner、tutor、intake_goalsetter、evaluator 等）以及与之强相关的服务封装。

- 禁止新增或修改以下模式的分支来「替 Agent 决策」：
  - 根据 state、latest_user、loop_meta 等，在 Python 里判断「如果是规划类请求，就强制走 planner / tutor / …」。
  - 在路由函数中引入「智能默认」：例如
    - `target = (state.get("next_agent") or "planner").strip()`
    - 任何「如果没写 next_agent，就帮它选一个看起来合理的」。
- 允许的 if/else 只限于：
  - 纯粹的**防御性编程**：类型检查、字段是否存在、转换失败直接报错等；
  - 明确的错误分支：检测到协议不满足约定时，**抛出异常或记录错误**，而不是改写行为。

### 2. 禁止把 Agent 当作路由表 / 固定流程「假 Agent」

- 禁止：
  - 用 Python 或 Prompt 把 Orchestrator 写成「匹配 case → 跳转到 xx agent」的路由器；
  - 在 Agent 内部写死「先 A 再 B 再 C」的流程（无论是代码里还是 Prompt 里）；
  - 通过一堆硬编码规则决定下一步应该调用哪个子 Agent，而不是把决策权交给 LLM，在 JSON 输出中给出。
- 要求：
  - Orchestrator / Planner 的职责是：**在结构化状态空间上做决策**，并把决策结果作为 JSON 输出；
  - Python 只负责：构造上下文、把输出写回 state、负责错误可观测；不负责「聪明选择」。

### 3. 禁止把 Agent 智能退化成「填 JSON 的机器」

- 禁止：
  - 用过度刚性的 Prompt 把 Agent 限制为「严格按模板填 JSON，不许表达思考」；
  - 为了让下游好解析，而牺牲 Agent 的真实思考与可读性，只留下死板字段。
- 要求：
  - Prompt 中必须保留 `thought` / `reason` 等字段，用于**暴露 Agent 的推理过程**，供前端展示和人类调试；
  - JSON 是载体，不是目的。不能让「满足 JSON 结构」压倒「做正确的决策」。

### 4. 禁止任何形式的 fallback 掩盖真实 Bug

- 禁止：
  - 在解析失败 / 模型输出不合法时，构造「看起来合理」的默认 plan，例如：
    - `if not plan: plan = {..., "next_agent": "planner"}`
    - `if not plan: plan = {..., "next_agent": "tutor"}`
  - 在调用失败时静默吞错，或者把错误改写为「normal usage」日志。
- 要求：
  - 协议错误 → **直接抛异常**（或返回明确错误结构），让上层 / 日志清楚看到；
  - 如果必须提供降级路径，必须是**显式的、带日志的、用户可见的**，而不是幕后偷偷替换结果。

### 5. 禁止「语义化 if-else」式 Prompt 特例优化

- 禁止在 SYSTEM_PROMPT 或指令中写下类似：
  - 「如果 latest_user 里包含 ‘规划’、‘节奏’，你必须把 next_agent 设为 planner」；
  - 「如果 loop_meta.round == 0 且 learning_plan 为空，你就不要用 tutor」；
  - 任何使用自然语言在 Prompt 里硬编码条件分支的规则，本质上都是 if-else，只是从代码搬到了 Prompt。
- 允许：
  - 描述角色职责与边界（例如：tutor 只讲题不做宏观规划；planner 负责任务板等）；
  - 描述高层策略偏好，但**不出现「如果 A 则必须 B」**这种刚性约束语句。

## 三、正向建议：问题该怎么查、行为该怎么收敛

1. **优先看协议与数据流**
   - 查看：传给 LLM 的 messages / tools / resources 是否符合官方文档；
   - 打印：原始 reply（受隐私约束时做必要截断），而不是直接假设 LLM 出错；
   - 校验：JSON 结构与约定字段是否一致。

2. **错误处理策略**
   - 遇到 DashScope / Qwen 错误：
     - 显式抛出 `QwenRequestError`，带上 `status_code` / `code` / `message`；
     - 禁止静默 `empty_stream` 或日志里写「success」但实际上失败。
   - 遇到 Agent 协议错误：
     - 抛出异常并在日志中注明「agent_protocol_error」，不造假数据。

3. **透明化而不是伪装工具调用**
   - `emit_trace_event` 的使用：
     - `stage="thought"`：用于暴露思考过程、路由意图等，不应触发「正在调用工具」UI；
     - `stage="action"`：**仅限真实工具调用或外部副作用**，必须有对应的 `tool_feedback` / `final` 关闭；
   - 禁止用 `stage="action"` 发一些与工具无关的事件，导致前端误以为在调工具、出现假 tool call。

4. **改动前先问自己三个问题**

在 Agent 工程里准备做任何改动（代码或 Prompt）之前，必须能用「是 / 否」回答下面三个问题：

1. 这次改动是否在 **增加 if/else 式的决策逻辑**（无论在代码还是 Prompt）？
2. 这次改动是否会在 **协议/模型出错时，自动帮它兜底**，让真实问题不再暴露？
3. 这次改动是否会把 Agent 进一步推向「固定流程 / 假路由器 / 填 JSON 机器」？

- 如果任意一个答案是「是」，则**禁止落地**，必须换一种方式：
  - 修协议、补数据、暴露错误，或者调整前端展示，而不是在 Agent 层做聪明决策。

## 四、本次违规行为记录（用于自我约束）

1. **在 router 中引入默认 planner 路由**
   - 行为：`target = (state.get("next_agent") or "planner").strip()`
   - 问题：在 Python 中替 ORC 决定应该走哪一个 Agent，属于路由层 if-else；
   - 状态：已移除，恢复为原有默认 tutor。

2. **在 `_run_orchestrator` 中构造默认 plan/fallback**
   - 行为：当解析不到 JSON 时，构造一个自创的 `plan`，强制 `next_agent="planner"` 或 `"tutor"`；
   - 问题：在协议错误时编造「看起来合理」的结果，掩盖真正的 Agent 输出问题；
   - 状态：已移除，现改为直接抛出异常。

3. **在 Prompt 中加入硬条件式 next_agent 规则**
   - 行为：写入「当 latest_user 是规划类请求且 loop_meta.round 为 0 且 learning_plan 为空时，必须把 next_agent 设为 planner」等语句；
   - 问题：这是把 if-else 从代码搬到 Prompt，本质未变，仍然是特例优化；
   - 状态：视当前文件为违规示例，后续需要逐步清理这类硬约束，改为描述职责边界而非条件分支。

---

今后在这个仓库里做任何 Agent 相关改动，都必须先对照本文件自检。如果改动触碰了上述禁令而又落地了，视为重复违规，需要优先回滚并重新设计。
