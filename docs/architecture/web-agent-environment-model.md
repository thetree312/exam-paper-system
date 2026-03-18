# 学习教练 Agent 的 Web 环境建模

## 目标

这份环境建模只回答一件事：

Agent 处在什么世界里，这个世界里有哪些区域、对象、关系、可见性和可执行动作。

它不负责替 agent 做任务判断、环境判断或策略切换。
也不把 UI 事实偷换成行为规则。

---

## 一、环境边界

当前 agent 的工作环境不是抽象文本世界，而是当前 web 应用。

agent 必须明确知道自己工作在以下三类 surface 中：

1. `chat`
   作用：
   用户与 agent 进行对话，提出任务、补充信息、确认结果。

2. `workspace`
   作用：
   展示当前文档、题目、题图、局部资产、聚焦对象。

3. `kb`
   作用：
   存放知识库 source、检索结果、证据片段、引用来源。

这三个 surface 共同构成 agent 的环境边界。

---

## 二、环境建模原则

### 1. 环境模型不是 prompt 文本

环境模型必须是一等状态，而不是“拼进 system prompt 的说明段落”。

prompt 只能消费环境模型，不能替代环境模型。

### 2. 环境模型不是内容灌输

agent 不需要把 workspace 或 kb 的全部内容灌进上下文。

环境模型只保存：

- 哪些 surface 存在
- 当前哪些对象可见
- 当前焦点在哪里
- 对象之间有什么关系
- 每个 surface 当前具备什么 affordance

具体内容按需通过工具获取。

### 3. 环境模型描述事实，不描述策略

例如：

- `workspace.content_state = empty`
- `kb.objects = ["source:1054"]`

这是事实。

但下面这种不属于环境模型：

- “如果 workspace 为空，就优先去 kb”

这是策略，必须由 agent 自己判断。

---

## 三、核心建模对象

环境模型建议拆成四层：

1. `Surface`
2. `Object`
3. `Relation`
4. `Affordance`

---

## 四、Surface 模型

### 1. chat

含义：
对话区。

最小字段：

```json
{
  "id": "chat",
  "kind": "conversation_surface",
  "position": "chat_panel",
  "content_state": "active",
  "visible_objects": ["chat:thread"],
  "selected_objects": [],
  "focus_object": null,
  "affordances": ["reply", "ask_user", "clarify", "summarize"]
}
```

### 2. workspace

含义：
当前工作区，可能承载题目、文档、图片、局部素材、当前聚焦项。

最小字段：

```json
{
  "id": "workspace",
  "kind": "document_surface",
  "position": "workspace_panel",
  "content_state": "empty",
  "visible_objects": [],
  "selected_objects": [],
  "focus_object": null,
  "affordances": ["inspect_index", "inspect_assets", "set_focus"]
}
```

### 3. kb

含义：
知识库 surface，承载 source 和检索证据。

最小字段：

```json
{
  "id": "kb",
  "kind": "retrieval_surface",
  "position": "kb_panel",
  "content_state": "has_source_content",
  "visible_objects": ["source:1054"],
  "selected_objects": [],
  "focus_object": null,
  "affordances": ["search_evidence", "cite_source"]
}
```

---

## 五、Object 模型

Object 是环境中可被感知、引用、聚焦、操作的实体。

agent 不需要一开始拿到对象全文，只需要知道对象存在以及对象类型。

### 当前建议支持的 object kinds

- `chat_thread`
- `document`
- `question`
- `asset`
- `image`
- `legend`
- `source`
- `evidence`
- `query`
- `selection`

### 示例

```json
{
  "id": "source:1054",
  "kind": "source",
  "surface": "kb",
  "label": "source:1054"
}
```

```json
{
  "id": "document:88",
  "kind": "document",
  "surface": "workspace",
  "label": "当前试卷文档"
}
```

```json
{
  "id": "question:6",
  "kind": "question",
  "surface": "workspace",
  "label": "第六题"
}
```

---

## 六、Relation 模型

relation 是环境建模的关键。

没有 relation，agent 只能看到一堆对象清单，无法理解这个 web 应用里的结构关系。

### 当前建议支持的 relation kinds

- `visible_in`
- `selected_in`
- `focuses_on`
- `contains`
- `derived_from`
- `references`
- `supports`

### 示例

```json
[
  { "from": "question:6", "to": "workspace", "type": "visible_in" },
  { "from": "source:1054", "to": "kb", "type": "visible_in" },
  { "from": "workspace", "to": "question:6", "type": "focuses_on" },
  { "from": "evidence:chunk:abc", "to": "source:1054", "type": "derived_from" }
]
```

### relation 的意义

它不直接告诉 agent “该怎么做”，但它允许 agent 自己推断：

- 当前问题对象是否在 workspace 可见
- 当前证据来自哪个 source
- 当前 surface 的焦点在哪个对象上
- 某个检索结果是否能支持当前任务

---

## 七、Affordance 模型

affordance 表示环境允许 agent 在当前 surface 上做什么。

affordance 不是策略，而是动作空间。

### chat affordances

- `reply`
- `ask_user`
- `clarify`
- `summarize`

### workspace affordances

- `inspect_index`
- `inspect_assets`
- `set_focus`

### kb affordances

- `search_evidence`
- `cite_source`

### 关键约束

affordance 只定义“可以做什么”，不定义“应该做什么”。

例如：

- `workspace` 有 `inspect_assets`

这只说明 agent 可以检查 workspace 资产。

但并不意味着：

- “当 workspace 非空时必须先 inspect_assets”

这属于策略，不能落进环境建模。

---

## 八、运行时视图

环境建模需要区分两层：

### 1. 静态世界模型 `world_model`

它定义：

- 当前 web 应用有哪些 surface
- 支持哪些 object kinds
- 支持哪些 relation kinds
- 每类 surface 的基本 affordance

这层较稳定。

### 2. 动态环境窗口 `environment_window`

它定义：

- 当前 active surface
- 当前 visible objects
- 当前 selected objects
- 当前 focus object
- 当前 relations
- 各 surface 的 content_state

这层每轮都会变化。

---

## 九、推荐状态结构

### world_model

```json
{
  "surfaces": {
    "chat": {
      "kind": "conversation_surface",
      "position": "chat_panel",
      "affordances": ["reply", "ask_user", "clarify", "summarize"]
    },
    "workspace": {
      "kind": "document_surface",
      "position": "workspace_panel",
      "affordances": ["inspect_index", "inspect_assets", "set_focus"]
    },
    "kb": {
      "kind": "retrieval_surface",
      "position": "kb_panel",
      "affordances": ["search_evidence", "cite_source"]
    }
  },
  "object_kinds": [
    "chat_thread",
    "document",
    "question",
    "asset",
    "image",
    "legend",
    "source",
    "evidence",
    "query",
    "selection"
  ],
  "relation_kinds": [
    "visible_in",
    "selected_in",
    "focuses_on",
    "contains",
    "derived_from",
    "references",
    "supports"
  ]
}
```

### runtime_snapshot.environment_window

```json
{
  "active_surface": "chat",
  "visible_objects": ["chat:thread", "source:1054"],
  "selected_objects": [],
  "focus_object": null,
  "relations": [
    { "from": "chat:thread", "to": "chat", "type": "visible_in" },
    { "from": "source:1054", "to": "kb", "type": "visible_in" }
  ],
  "surfaces": {
    "chat": {
      "content_state": "active",
      "visible_objects": ["chat:thread"]
    },
    "workspace": {
      "content_state": "empty",
      "visible_objects": []
    },
    "kb": {
      "content_state": "has_source_content",
      "visible_objects": ["source:1054"]
    }
  }
}
```

---

## 十、agent 在这个环境里必须“知道”的东西

agent 至少要意识到：

1. 自己工作在一个 web 应用里，而不是纯文本对话里。
2. chat、workspace、kb 是不同 surface，不同 surface 的对象和 affordance 不同。
3. workspace 为空，不等于 kb 为空。
4. kb 有 source，不等于 workspace 已经有题目对象。
5. 当前问题涉及哪个对象，不应靠猜，而应靠环境对象和工具观察逐步确认。
6. 对象的存在、可见性、聚焦关系、来源关系，都是后续行动的重要依据。

---

## 十一、哪些内容不该进环境建模

以下内容不该写进环境模型本体：

1. 行为规则
   例如：
   - “如果 workspace 空，就优先去 kb”

2. 停机规则
   例如：
   - “如果检索失败两次就结束”

3. 任务阶段定义
   例如：
   - “当前在分析阶段 / 回答阶段 / 检索阶段”

4. agent 对世界的解释
   例如：
   - “当前环境无法推进”

这些要么属于 agent 自己的判断，要么属于 runtime 协议，不属于环境建模。

---

## 十二、下一步落地顺序

如果按这份模型落代码，顺序应该是：

1. 先统一 `state.py` 里的 `world_model / runtime_snapshot.environment_window`
2. 再统一 `router_runtime.py` 的环境映射来源
3. 再把 workspace 的对象类型从 `document:*` 扩展到 `question / asset / image / legend`
4. 最后再让 graph 或 agent core 消费这些环境状态

先做环境世界的准确表达，再做行为层。

