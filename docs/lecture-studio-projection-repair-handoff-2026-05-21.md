## 讲解容器投影修复方案与交接日志

日期：2026-05-21

适用范围：
- `backend/src/domains/lecture/service.ts`
- `backend/src/routes/lectures.ts`
- `backend/agent/packages/opencode/src/agent/prompt/lecture.txt`
- `frontend/src/components/LectureStudioPanel.tsx`

---

## 1. 目标

本次问题的正确目标不是“继续补 lecture session 路由逻辑”，而是把当前链路纠正为下面这个形态：

1. `opencode` child lecture agent 继续只使用它自己的原生 `session`
2. 讲解容器不再承担“第二套会话系统”的职责
3. 后端只做两件事：
   - 订阅 child session 的输出
   - 把可展示的输出投影到 Studio 讲解容器
4. agent 不需要知道、传递、解析、回填任何 lecture session id
5. question 仍然走原生 runtime `question` tool
6. 前端只渲染系统已经投影好的讲解块和提问状态，不猜测、不补造协议

这与用户要求一致：

- “subagent 在讲解容器里讲解”
- “session 这种东西 opencode agent 自己会处理”
- “只需要把 subagent 的输出放到讲解容器里输出展示即可”

---

## 2. 当前问题概览

### 2.1 问题一：A/B/C 选项消失，只剩输入框

真实现象：

- 前端提问组件只显示一个自由输入框
- A/B/C 固定选项没有显示

已确认根因：

1. child session 的原生 `question` tool 实际产出了 4 个选项
2. 这些选项的真实结构是：
   - `{ label, description }`
3. 当前后端 `mapRuntimeQuestion()` 只接受 `option.kind === "choice"` 的选项
4. 原生 question payload 里没有这个 `kind` 字段
5. 结果所有选项被后端过滤为空数组
6. 前端继续只渲染 `kind === 'choice'`，因此最终只剩 `custom` 输入

对应代码位置：

- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:658)
- [LectureStudioPanel.tsx](d:/Exam-paper/frontend/src/components/LectureStudioPanel.tsx:1726)

结论：

- 这不是 agent 没给选项
- 也不是前端布局问题
- 是“后端 question 语义映射”被错误改成了自定义 shape

### 2.2 问题二：讲解正文没出现，但提问先出现

真实现象：

- Studio 中间容器仍显示“等待讲解开始”
- 底部提问组件已经弹出

已确认根因：

1. child session 的第一条 assistant message 已经有讲解正文
2. 但当前 `syncLectureProjection()` 在处理 message 时：
   - 先推进 `projectedChildMessageCount`
   - 遇到 `assistant && !finish` 就直接 `break`
   - 因此正文没有被提取成 lecture block
3. 同时 `getPendingRuntimeQuestion()` 仍然成功抓到了 pending question
4. `buildSessionPayloadCore()` 因此发布了 `question_asked`

对应代码位置：

- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:555)
- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:582)
- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:691)
- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:518)

结论：

- 这不是“没有讲解”
- 而是“讲解投影逻辑过早拦截了未 finish assistant message”
- 同时又把 question 单独发出来了，造成顺序倒挂

### 2.3 问题三：链路外面又套了一层 lecture session 壳

真实现象：

- prompt 中仍然显式注入了 `[lecture-session-id:...]`
- 后端通过 parent task metadata / prompt marker 反查 lecture session

已确认根因：

当前代码仍在做以下事情：

1. `buildLectureTaskPrompt()` 把 lecture session marker 注入 prompt
2. `findLectureTaskBindingInParentSession()` 从 parent session 的 task part 里反查：
   - child agent session id
   - lecture session id
3. `resolveLectureAgentSessionID()` 继续依赖这套反查逻辑

对应代码位置：

- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:42)
- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:46)
- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:438)
- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:723)
- [service.ts](d:/Exam-paper/backend/src/domains/lecture/service.ts:649)

结论：

- 这层设计已经偏离“runtime 自己管 session，系统只做展示投影”
- 本质上仍然是外部 lecture routing 壳
- 这是需要整体移除的，不应该继续修补

---

## 3. 这次修复必须坚持的原则

### 3.1 不能再做的事

1. 不能继续扩写 lecture-specific session 绑定协议
2. 不能继续把 prompt 当作传递系统内部路由状态的载体
3. 不能继续发明 `kind === "choice"` 这类脱离 runtime 原生结构的自定义 question option 协议
4. 不能继续靠“if 这个字段没有，就兜底造一个”来修表象
5. 不能继续把“讲解块投影”与“提问状态投影”拆成两套先后不一致的逻辑

### 3.2 必须恢复的边界

1. `session` 归 `opencode runtime`
2. Studio 归展示层
3. 后端归投影层
4. prompt 归教学策略，不归系统路由
5. question 归 runtime 原生语义

---

## 4. 非止血式修复方案

## Phase A：去掉 lecture 路由壳，恢复 runtime session 单源

目标：

- 后端不再通过 prompt marker 维护 lecture session 显式绑定协议
- child lecture session 只以 runtime 原生 session 为真源
- Studio 侧只保留“某个 lecture tab 订阅哪个 child session”的投影关系

实施：

1. 删除或退役下面这些机制：
   - `LECTURE_SESSION_MARKER_PREFIX`
   - `buildLectureSessionMarker()`
   - `extractLectureSessionMarker()`
   - `findLectureTaskBindingInParentSession()`
2. `buildLectureTaskPrompt()` 不再注入 `[lecture-session-id:...]`
3. `launchSession()` 阶段只记录：
   - 当前 lecture tab 对应的 question card
   - origin parent session
   - 一旦 child task 真正创建完成，记录 child runtime session id
4. child runtime session id 的来源应该是 runtime task 启动返回值或 runtime 持久层的直接字段，而不是 prompt marker 反查
5. lecture service 后续所有投影都只面向：
   - `lecture tab id`
   - `child runtime session id`

结果：

- agent 不再知道 lecture session id
- prompt 变回教学提示
- lecture container 与 child session 的关系由系统内部状态维护，而不是靠 prompt marker 传递

## Phase B：统一“正文投影”和“提问投影”的数据源与顺序

目标：

- 同一条 child assistant 产出的正文与其 question tool 必须按同一轮次顺序进入 lecture container

实施：

1. 重新设计 `syncLectureProjection()`：
   - 不要以 `finish === false` 直接阻断整条 assistant message 的正文提取
   - 应按 `part` 级别解析，而不是只看 message 级 finish 状态
2. 对单条 assistant message，按 part 顺序处理：
   - 先抽取 `text` part 投影为 lecture block
   - 再识别其中的 tool/question part
   - 保证“先讲解，再提问”
3. `projectedChildMessageCount` 不应在正文尚未成功投影前前移
4. question 的发出应依赖：
   - 当前轮次正文已成功落块
   - 然后才发布 `question_asked`
5. 若 assistant message 只有 question 没有正文，也应在 UI 上明确视为“提问轮”，不能继续显示“等待讲解开始”

结果：

- 不会再出现“讲解没出现但 question 已弹出”的顺序倒挂
- lecture block 和 question 使用同一套 child session 投影时序

## Phase C：恢复原生 question 语义，不再自造 option shape

目标：

- runtime question 的结构不再被 lecture 层错误重写

实施：

1. `mapRuntimeQuestion()` 直接兼容 runtime 原生 option shape
2. 后端 DTO 应统一表达成最小语义：
   - `label`
   - `description`
   - `multiple`
   - `custom`
3. lecture domain 不再要求 option 具备人工加的 `kind === "choice"`
4. 前端 `QuestionOptionGrid` 直接渲染实际 options 数组
5. 开放式输入不是“伪造一个 freeform option 对象”，而是：
   - 如果 `custom !== false`
   - 在固定选项后追加一个 `D:` 输入框
6. 如果 question 本身没有任何 options，只允许那时渲染纯开放输入框

结果：

- 只要 runtime 给了 A/B/C，前端就一定能显示 A/B/C
- 开放输入恢复为 question 原生语义，不再靠 fake option 或截断补丁

## Phase D：重写 lecture prompt，让它只约束教学，不承载路由协议

目标：

- prompt 回到“教什么、怎么教、什么时候问、什么时候画图”
- 不再承担系统内部绑定、显式写容器、显式传 session id 的职责

实施：

1. `backend/agent/packages/opencode/src/agent/prompt/lecture.txt` 重写为连续完整的人设提示
2. 删除或改写这类路由型措辞：
   - “讲解文本会自动投影到 lecture container”
   - “lecture bridge auto-bound”
   - “写入讲解容器”
3. 保留真正必要的约束：
   - 一对一辅导节奏
   - 先诊断卡点再推进
   - question 用于 formative assessment
   - visualization 的适用条件与质量要求
   - LaTeX 书写标准
4. 系统内部的“谁负责投影到容器”不再放进 prompt

结果：

- prompt 不再臃肿为“教学指令 + 路由协议 + CLI 细则”的混合物
- agent 更不容易被系统实现细节牵着走偏

---

## 5. 推荐的重构顺序

这是一次性修复顺序，不是分散打补丁顺序：

1. 先移除 lecture prompt marker 与反查绑定逻辑
2. 再重构 child session 到 lecture container 的投影管线
3. 再修正 runtime question 的原生结构映射
4. 再调整前端 question 渲染
5. 最后精简 lecture prompt

原因：

- 如果先改 prompt，不改投影，问题会继续出现
- 如果先改前端，不改 mapper，A/B/C 还是拿不到
- 如果先补 condition，不改投影顺序，正文/提问顺序还会继续乱

---

## 6. 验收标准

必须同时满足以下条件，才算修好：

1. child lecture agent 首条 assistant 输出的正文能直接进入 Studio 中间讲解容器
2. 如果同一轮 assistant 输出里带 question，顺序表现为：
   - 先出现正文
   - 再出现 question dock
3. runtime 提供 A/B/C 选项时，前端必须完整显示 A/B/C
4. `custom` 开启时，在固定选项后显示 `D: 输入框`
5. question 完全开放时，才允许只显示输入框
6. prompt 中不再出现 lecture session marker
7. 后端不再通过 prompt marker 反查 lecture routing
8. lecture container 的内容投影不再依赖 agent 手动 bridge 写文本

---

## 7. 这次排查得到的关键证据

### 证据一：question options 被后端映射为空

数据库中的 `lecture_sessions.question_prompt_json` 已经是：

```json
{
  "questions": [
    {
      "question": "近日点 5 AU、远日点 7 AU，半长轴 a 是多少 AU？",
      "options": [],
      "custom": true
    }
  ]
}
```

但 child session 的原生 question tool 输入实际有：

```json
[
  { "label": "5 AU", "description": "只用了近日点距离" },
  { "label": "6 AU", "description": "近日点和远日点的平均值" },
  { "label": "7 AU", "description": "只用了远日点距离" },
  { "label": "12 AU", "description": "近日点和远日点相加" }
]
```

所以问题发生在 lecture backend mapper，而不是 agent 或前端。

### 证据二：child assistant message 已有正文，但 lecture block 为 0

child session 的首条 assistant `text part` 已包含：

- “你好！之前你做过这道题……”
- “今天我们就把这个卡点彻底打通……”
- 后面再接第一个问题

但 `lecture_sessions` 中仍然是：

- `last_block_id = null`
- `projected_child_message_count = 1`

这说明正文在投影阶段被拦掉了，而不是 agent 没讲。

### 证据三：当前代码仍通过 prompt marker 维持 lecture routing

当前代码中仍存在：

- `buildLectureSessionMarker()`
- `extractLectureSessionMarker()`
- `findLectureTaskBindingInParentSession()`

这证明 lecture routing 外壳并未真正去掉。

---

## 8. 交接结论

当前实现的主要问题不是单点 bug，而是架构边界又被拉歪了：

1. 把 runtime session 之外又套了一层 lecture routing 壳
2. 把 question 原生协议改造成了自定义 shape
3. 把正文投影和提问投影拆成了顺序不一致的两套处理

因此后续修复不能继续做：

- 再补一条 prompt
- 再加一个 if
- 再写一个兜底 freeform option
- 再加一个 lecture-specific 标记字段

后续必须按本文的 Phase A ~ D 做一次性纠偏。

---

## 9. 本文件用途

本文件同时承担两种用途：

1. 修复方案：明确后续必须如何整体纠偏
2. 交接日志：记录截至 2026-05-21 的真实排查结论，避免后续重复走错路

如果后续实现与本文件再次冲突，应优先回到用户已明确锁定的目标：

- subagent 直接讲
- runtime 自己管理 session
- 系统只负责把输出投到讲解容器

