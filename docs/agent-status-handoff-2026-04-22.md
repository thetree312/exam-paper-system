# Agent 状态交接 - 2026-04-22

## 1. 这份交接文档的目的

这份文档只做三件事：

1. 记录当前项目里 agent 主链的真实状态。
2. 记录已经做到哪一步、哪些点仍然没达成。
3. 明确下一步任务只聚焦两件事：
   - `prompt` 改动适配
   - 摸查 agent 实际输入链

这份文档不再讨论大方向，也不再回到 `raw CoT` 展示路线。

## 2. 已经确认的目标

当前用户已经明确确认的目标是：

- 不展示 raw CoT。
- 不展示“思考了几秒”这种 thought 折叠块。
- 工具调用必须独立展示为事实块。
- 最终回复必须独立收口。
- 公开过程说明如果出现，必须来自 LLM 本身。
- 后端禁止硬编码固定用户可见文案。

目标效果已经由下面这个 mock 确认过：

- [agent-public-narration-ui-mock-2026-04-21.html](/D:/Exam-paper/docs/agent-public-narration-ui-mock-2026-04-21.html)

一句话概括就是：

`公开说明 + 工具事实 + 最终答复`

不是：

`思考链 + 工具日志 + 最终答复`

## 3. 当前 agent 主链真实状态

### 3.1 backend 运行边界

- `backend/` 仍然是唯一主后端。
- `opencode` 当前仍然是 `backend` 内部 runtime，不是独立服务。
- 当前 agent runtime 实际入口在：
  - [backend/agent/packages/opencode/src/agent/index.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/agent/index.ts)
- backend 路由层在：
  - [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts)

### 3.2 backend 对前端导出的 facts

当前 `/api/agent/run-stream` 已经不是最早那套压缩协议主链，而是 facts 风格事件流，主要包括：

- `session`
- `message_started`
- `message_updated`
- `message_completed`
- `part_added`
- `part_updated`
- `part_completed`
- `part_delta`
- `permission_asked`
- `question_asked`
- `done`

事实类型当前包含：

- `commentary`
- `final_answer`
- `text`
- `reasoning`
- `tool`
- `file`
- 其他 `part`

关键文件：

- [backend/agent/packages/opencode/src/agent/index.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/agent/index.ts)
- [backend/src/domains/agent/dto.ts](/D:/Exam-paper/backend/src/domains/agent/dto.ts)

### 3.3 `commentary` 相位当前怎么来的

当前 `SessionProcessor` 里，普通文本 part 会以 `phase: "commentary"` 起步，最终阶段会把现有 text parts 提升成 `final_answer`：

- [backend/agent/packages/opencode/src/session/processor.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/processor.ts)
- [backend/agent/packages/opencode/src/session/message-v2.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/message-v2.ts)

也就是说，项目里已经有了：

- `commentary`
- `final_answer`

这两个事实相位。

但这不等于模型已经稳定产出你要的“像 Codex 那样的公开说明”。

### 3.4 frontend 当前消费状态

前端当前已经是 facts 驱动，不再以旧的 `delta / agent_trace / assistant_final` 作为主真相源。

关键文件：

- [frontend/src/hooks/useAgentChat.ts](/D:/Exam-paper/frontend/src/hooks/useAgentChat.ts)
- [frontend/src/lib/agentFacts.ts](/D:/Exam-paper/frontend/src/lib/agentFacts.ts)
- [frontend/src/components/AgentChatPanel.tsx](/D:/Exam-paper/frontend/src/components/AgentChatPanel.tsx)
- [frontend/src/hooks/useConversation.ts](/D:/Exam-paper/frontend/src/hooks/useConversation.ts)

当前主展示流已经按这几类 block 在走：

- `commentary`
- `text`
- `final_answer`
- `tool`

`reasoning` 默认不再进主展示流。

### 3.5 工具展示现状

当前工具块不是全都一个样式，但还没有彻底收完。

现状如下：

- `bash / shell / command`：
  - 作为 `command` 类展示。
- `edit / write / apply_patch / multiedit`：
  - 作为 `file_edit` 类展示。
- `write` 工具已经补了：
  - `diff`
  - `filediff`
  - `relativePath`
- 新产生的 `write/edit/apply_patch` 结果已经有机会走专门 diff/file 展示，不会全部退回通用块。

关键文件：

- [backend/agent/packages/opencode/src/tool/write.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/tool/write.ts)
- [frontend/src/components/AgentChatPanel.tsx](/D:/Exam-paper/frontend/src/components/AgentChatPanel.tsx)
- [frontend/src/lib/agentFacts.ts](/D:/Exam-paper/frontend/src/lib/agentFacts.ts)

注意：

- 旧历史消息如果没有 diff metadata，不会自动变成新样式。
- 新发生的文件类工具调用才会走新的 diff/file 展示链。

## 4. 当前已经确认的已知问题

### 4.1 公开说明效果没有达到目标

这是当前最核心的问题。

用户已经明确反馈：

- 当前真实运行效果仍然不是 mock 里那种“边说边做”。
- agent 更像是：
  - 一直调工具
  - 工具结束后再给最终回复
- 缺少类似 Codex / Cursor 的那种：
  - 工具前一小段公开说明
  - 工具失败后基于 observation 的继续说明

这说明当前虽然已经有 `commentary` 事实类型，但：

- 要么模型几乎不产出它
- 要么 prompt/输入链没有给模型足够机会或足够清晰的协议
- 要么当前 runtime 仍然更偏“直接工具调用，少说话”

### 4.2 不能再用提示词注入去强推 narration

这条已经踩过坑。

之前在 [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts) 里做过系统提示注入，试图强行让模型在工具前后说一句。结果是：

- 工具失败时，assistant 仍然可能说成功
- narration 脱离了工具事实
- 直接污染 agent 行为

这个做法已经明确失败，当前也已经撤回。

所以后续不能再靠这种 route 层追加一句大系统提示去硬推效果。

### 4.3 聊天历史切换曾导致前端崩溃

用户反馈过：

- 切换聊天记录会触发：
  - `Maximum update depth exceeded`

当前 [frontend/src/hooks/useConversation.ts](/D:/Exam-paper/frontend/src/hooks/useConversation.ts) 已经做了一轮自动选中去重修正：

- 用 `autoSelectionIntentRef` 限制自动重选
- 避免 store 更新反复触发 active conversation 重置

这块代码已经存在，但浏览器侧仍需继续验证，不能只看代码。

### 4.4 输入问题还没有摸清

这条是下一步必须查的，不是可选项。

当前我们还不能准确说清楚：

- 真实进入 runtime 的系统提示是什么
- 真实进入 runtime 的用户输入是什么
- 模型看到的是哪一层 prompt 组合
- `commentary` 没出来，到底是模型不愿意产出，还是输入链本身就没给出这种空间

## 5. 现在最值得关注的真实文件

### 5.1 runtime / prompt / phase

- [backend/agent/packages/opencode/src/session/processor.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/processor.ts)
- [backend/agent/packages/opencode/src/session/message-v2.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/message-v2.ts)
- [backend/agent/packages/opencode/src/session/prompt/gpt.txt](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt/gpt.txt)
- [backend/agent/packages/opencode/src/agent/generate.txt](/D:/Exam-paper/backend/agent/packages/opencode/src/agent/generate.txt)

### 5.2 backend API / 输入边界

- [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts)
- [backend/src/domains/agent/dto.ts](/D:/Exam-paper/backend/src/domains/agent/dto.ts)
- [backend/agent/packages/opencode/src/agent/index.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/agent/index.ts)

### 5.3 frontend 消费与会话切换

- [frontend/src/hooks/useAgentChat.ts](/D:/Exam-paper/frontend/src/hooks/useAgentChat.ts)
- [frontend/src/hooks/useConversation.ts](/D:/Exam-paper/frontend/src/hooks/useConversation.ts)
- [frontend/src/lib/agentFacts.ts](/D:/Exam-paper/frontend/src/lib/agentFacts.ts)
- [frontend/src/components/AgentChatPanel.tsx](/D:/Exam-paper/frontend/src/components/AgentChatPanel.tsx)

## 6. 对当前状态的工程判断

### 6.1 `commentary` 通道已经存在，但还没有“活起来”

这不是前端样式问题。

当前仓库里已经有：

- `commentary`
- `tool`
- `final_answer`

但“像 Codex 那样边说边做”的效果并没有自然出现。

所以问题已经不是：

- 要不要新增 `commentary` 类型

而是：

- 为什么当前模型在这条链里没有稳定地产出公开说明

### 6.2 下一步重点不是继续动样式

样式可以继续收，但不是当前主问题。

当前更关键的是两件事：

1. `prompt` 怎么适配，才能让模型更自然地产出公开 narration，而不污染工具真相。
2. 输入链到底是什么，当前模型究竟看到了什么。

也就是这轮交接文档要明确锁定的两个任务。

## 7. 下一步任务一：prompt 改动适配

### 7.1 目标

目标不是写硬编码固定文案，也不是 route 层塞一句大系统提示。

目标是：

- 沿着 `opencode` 原生 prompt 设计，审查并调整 prompt 结构
- 让模型更容易自然地产出 `commentary`
- 同时不破坏工具事实约束

### 7.2 当前已经看到的线索

在 [backend/agent/packages/opencode/src/session/prompt/gpt.txt](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt/gpt.txt) 里已经明确出现了：

- `Use commentary for short progress updates while working and final for the completed response.`
- `commentary channel`

这说明当前 runtime 设计本来就知道：

- `commentary`
- `final`

是两种不同输出相位。

所以后续应优先检查：

1. 当前这个 prompt 是否真的进入了实际运行链。
2. 是否还有其他 prompt 规则把模型重新推回“只调工具、最后总结”。
3. 当前模型供应商和模型本身，在这套 prompt 下是不是根本不愿意产出 commentary。

### 7.3 需要摸查的文件

- [backend/agent/packages/opencode/src/session/prompt/gpt.txt](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt/gpt.txt)
- [backend/agent/packages/opencode/src/session/prompt.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt.ts)
- [backend/agent/packages/opencode/src/agent/generate.txt](/D:/Exam-paper/backend/agent/packages/opencode/src/agent/generate.txt)
- [backend/agent/packages/opencode/src/provider/transform.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/provider/transform.ts)

### 7.4 明确禁止的做法

- 不要再在 [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts) 里追加硬塞的 narration system prompt。
- 不要把 narration 设计成规则引擎式固定步骤。
- 不要把 `reasoning` 假装成 `commentary`。

## 8. 下一步任务二：摸查输入问题

### 8.1 目标

把下面这些问题逐项查清：

1. 前端发给 backend 的 `messages/system/model/sessionId` 到底是什么。
2. backend 传给 `agent.streamMessage()` 的 `message` 实际是什么。
3. `SessionPrompt.prompt()` 里最终给模型的输入是什么。
4. 当前 conversation history、system、agent、model、tool context 是怎么被组装进去的。

### 8.2 当前已经能看到的疑点

在 [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts) 里，`/run-stream` 当前只取最后一个 `user` message 的 `content` 作为：

- `prompt`

然后传给：

- `agent.streamMessage({ message: { text: prompt, ... } })`

这本身不一定是 bug，因为 session history 可能由 runtime 自己补。

但它至少说明：

- route 层并没有把前端 `messages` 全量直接透进 runtime
- 真正的上下文仍然要靠 session/history/prompt builder 去还原

这正是“输入问题”要重点摸的地方。

### 8.3 需要重点看哪些链路

1. 前端发起：
   - [frontend/src/hooks/useAgentChat.ts](/D:/Exam-paper/frontend/src/hooks/useAgentChat.ts)
   - [frontend/src/services/agentApi.ts](/D:/Exam-paper/frontend/src/services/agentApi.ts)

2. backend run-stream 入口：
   - [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts)

3. runtime 真正吃输入的地方：
   - [backend/agent/packages/opencode/src/agent/index.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/agent/index.ts)
   - [backend/agent/packages/opencode/src/session/prompt.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt.ts)
   - [backend/agent/packages/opencode/src/session/processor.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/processor.ts)

### 8.4 这一步应产出的结果

下一位接手的人做完“输入问题摸查”之后，应该能明确回答：

- 当前模型看到的 system prompt 是什么
- 当前模型看到的 user 输入是什么
- commentary 机会是在什么时机出现的
- 为什么当前模型没有稳定产出 narration

如果这四个问题答不出来，就不应该继续改 UI。

## 9. 建议的接手顺序

1. 先不要碰前端样式。
2. 先读：
   - [backend/agent/packages/opencode/src/session/prompt/gpt.txt](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt/gpt.txt)
   - [backend/agent/packages/opencode/src/session/prompt.ts](/D:/Exam-paper/backend/agent/packages/opencode/src/session/prompt.ts)
   - [backend/src/routes/agent.ts](/D:/Exam-paper/backend/src/routes/agent.ts)
3. 先把实际输入链摸清楚。
4. 再决定 prompt 该怎么做最小适配。
5. 最后再回到 UI 效果验证：
   - `commentary -> tool -> final_answer`
   - 或者在无 narration 时退化成：
     - `tool -> final_answer`

## 10. 结论

当前项目里的 agent 并不是“没有 `commentary` 通道”，而是：

- `commentary` 通道已经有了
- facts 链也已经通了
- 前端也已经能消费了

但关键问题仍然没解决：

- 模型为什么没有稳定地产出你要的公开说明

因此下一步不该继续围着 thought 样式、工具卡片细节打转，而应先完成两件事：

1. `prompt` 改动适配
2. `输入问题` 摸查

这两步做清楚之后，才知道当前离目标差的是：

- prompt 设计
- 输入组装
- 还是模型/provider 行为本身
