# Agent Public Narration Handoff

Date: 2026-04-21  
Audience: 下一位继续处理 agent 对话链路的人  
Purpose: 记录这轮 agent UI / runtime 调整的真实停点，避免重新走一遍已经确认过的展示方向，也避免继续在错误的 CoT 方案上反复试错。

## 1. 已经确认的目标

用户已经审核并确认 `docs/agent-public-narration-ui-mock-2026-04-21.html` 所表达的方向是正确的。

确认目标是：

- 不展示 raw CoT
- 不展示“思考了多少秒”的折叠块
- 展示 LLM 自己写出来的公开过程说明
- 工具调用必须作为独立事实块插入
- 最终回复单独收口
- 所有用户可见文案必须来自 LLM，后端不能硬编码固定文案

这个目标不是“把 thought 做得更漂亮”，而是把 agent 的可见输出改成：

`公开说明 + 工具事实 + 最终答复`

## 2. 当前已经做过的修改

### 2.1 前端展示层

`frontend/src/components/AgentChatPanel.tsx`

- 目前前端已经不再走原来的 thought 折叠展示路线。
- 现在主渲染逻辑只保留了：
  - `text`
  - `tool`
- `thought` / raw reasoning 的旧 UI 分支已经从主展示路径上移除了。
- 工具块仍然保留为独立的可展开事实块。

### 2.2 会话切换稳定性

`frontend/src/hooks/useConversation.ts`

- 这轮曾经出现过切换历史记录导致 `Maximum update depth exceeded` 的问题。
- 当前代码里已经加了去重保护，避免同一个会话被重复选中时反复回写 `activeConversationKey`。
- 这个点仍然建议在真实浏览器里再验证一次，但当前代码里已经有对应修复。

### 2.3 backend 的 agent 公开叙述约束

`backend/src/routes/agent.ts`

- 当前 `run-stream` 和 `messages` 入口都已经通过 `composeAgentSystemPrompt()` 追加了统一的公开叙述约束。
- 约束的意图是：
  - 不暴露 hidden chain-of-thought
  - 在调用工具前先给用户一句短的公开说明
  - 工具结果之后可以补一句短的进度说明
  - 所有可见文字仍然必须由模型自己生成

注意：
- 这不是硬编码固定回复文案。
- 这是给模型加行为边界。

## 3. 这次没有恢复成功的地方

### 3.1 `agent.ts` 没有恢复到用户期望的最终状态

用户明确说“我恢复了部分代码但 `agent.ts` 恢复失败”。

这说明当前 `backend/src/routes/agent.ts` 仍然是本轮改动后的状态，不是完全回到用户想要的基线状态。

当前残留的明确改动包括：

- `AGENT_PUBLIC_NARRATION_SYSTEM`
- `composeAgentSystemPrompt()`
- `run-stream` / `messages` 入口传入合并后的 `system`

如果下一位接手的目标是继续对齐用户最终确认的行为，那就必须先决定：

- 是否保留这层“公开叙述约束”
- 还是需要再往下把 agent 入口恢复到更接近原始 runtime 的状态

这个决策不能靠猜，必须按用户当前要求和真实运行效果来定。

### 3.2 公开说明没有被完整验证

虽然 HTML mock 已经确认方向正确，但真实链路里仍然存在两种风险：

- 模型没有在工具前主动写出公开说明，只输出工具块和最终答复
- 前端虽然能渲染公开说明，但后端没稳定产出这类可见文本

也就是说：

- 展示方向已经确认
- 真实生成链路还需要最终验证

## 4. 当前仓库里最关键的相关文件

优先看这几个文件，不要再从抽象层开始猜：

- [frontend/src/components/AgentChatPanel.tsx](/D:/Exam-paper/frontend/src/components/AgentChatPanel.tsx)
- [frontend/src/hooks/useConversation.ts](/D:/Exam-paper/frontend/src/hooks/useConversation.ts)
- [frontend/src/hooks/useAgentChat.ts](/D:/Exam-paper/frontend/src/hooks/useAgentChat.ts)
- [frontend/src/lib/agentFacts.ts](/D:/Exam-paper/frontend/src/lib/agentFacts.ts)
- [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts)
- [backend/agent/packages/opencode/src/session/prompt.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt.ts)
- [backend/agent/packages/opencode/src/session/processor.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/processor.ts)
- [docs/agent-public-narration-ui-mock-2026-04-21.html](/D:/Exam-paper/docs/agent-public-narration-ui-mock-2026-04-21.html)

## 5. 已知问题与风险

### 5.1 工具前不说话

用户明确指出：

- agent 在调用工具前没有先说一句公开说明
- 只有工具输出，然后直接最终回复

这个问题不是展示层的小修小补能解决的，必须同时检查：

- backend 是否真的把“公开说明”这类输出送进了模型上下文
- `opencode` 原生 prompt / instruction 是否仍然压制了前置说明
- 前端是否把模型生成的公开说明正确拼进消息流

### 5.2 历史切换崩溃

用户还反馈过：

- 切换聊天历史会让前端崩溃

当前 `useConversation.ts` 里已经有一轮防抖式去重修正，但这块需要在真实浏览器里再确认一次，不要只看类型检查。

### 5.3 不要再把 CoT 当答案

这个点已经反复确认过：

- 不要再把原始 reasoning 展示出来
- 不要再回到“思考块 + 正文块”的路线
- 不要再让用户看到像日志一样的思维链

用户要的是：

- LLM 自己说的公开过程说明
- 工具事实
- 最终答复

不是 raw CoT。

## 6. 接手时建议的顺序

1. 先确认 `backend/src/routes/agent.ts` 是否保留 `composeAgentSystemPrompt()` 这一层。
2. 再确认 `backend/agent/packages/opencode/src/session/prompt.ts` 里是否还有会压制前置说明的 prompt 规则。
3. 然后在真实浏览器里验证一轮：
   - 首条消息是否先出现公开说明
   - 工具块是否仍然保留
   - 最终答复是否仍然收口
4. 最后再看历史切换是否还会把前端状态冲崩。

## 7. 结论

这轮的交接点不是“展示样式还没调完”，而是：

- 用户已经确认了新的展示范式
- 前端渲染层已经朝这个方向收了一半
- `agent.ts` 这边没有完全恢复到用户期望的最终基线
- 公开说明是否能稳定由模型产出，仍然是当前链路的关键验证点

下一位接手的人不要再从 thought / CoT 方案开始补，要直接沿着这份确认过的 `public narration + tool facts + final answer` 方向继续收敛。
