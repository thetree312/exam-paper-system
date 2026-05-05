# TS 后端迁移执行规范

日期：2026-04-17

## 目标

本规范用于约束后续把旧 Python 后端业务迁移到 `backend/src` TS 主后端时的执行方式，确保：

- 不丢功能
- 不做简化降级
- 不用 placeholder / skeleton 冒充进度
- 不把代码堆成几千行不可维护文件

## 一、完整性约束

### 1.1 每个迁移域必须先建立功能对照表

每个旧业务域迁移前，必须先列出：

- 旧 router 文件
- 旧 service 文件
- 旧输入 DTO / Query 参数
- 旧输出 DTO
- 旧副作用
- 新 TS domain 落点
- 新 TS route 落点
- 迁移状态
- 验证状态

没有这张表，不允许开始迁移。

### 1.2 迁移对象必须按“功能项”验收，不按“目录完成”验收

不允许用以下说法作为完成标准：

- 某个目录已经建好
- 某个 route 已经存在
- 某个 domain 已经初始化

必须按功能项验收，例如：

- PDF 上传
- Word 预览图生成
- 题型列表读取
- 标签创建
- 闪卡 review 调度
- 脑图生成与读取

### 1.3 不允许迁移时擅自优化或改语义

除非用户明确批准，否则迁移时：

- 不改业务语义
- 不改接口含义
- 不改能力边界
- 不删旧行为中的复杂分支

如果需要重构接口面，只能在完成旧行为对齐后进行第二阶段重构。

## 二、禁止简化清单

### 2.1 文档链路

禁止：

- 把 PDF 处理简化成纯文本抽取
- 把 Word 处理简化成只提文本不做预览图
- 去掉页级 preview / block / layout / bbox 映射
- 去掉 markdown raw source 中的图片引用
- 把 selection resolve 简化成只返回文本

### 2.2 Agent 相关

禁止：

- 把 opencode 原生 file / command / diff / patch 改写成自定义简化工具
- 去掉 approval / HITL
- 去掉 session / compression / memory / MCP / skill
- 把 runtime 重新做成独立服务或子进程

### 2.3 学习产物

禁止：

- 把脑图只保留静态生成，不保留读取/保存/回流
- 把闪卡只保留生成，不保留 due/review/stats/mastery
- 把 artifact 和 wiki / document block / agent run 的关联省略掉

### 2.4 配置类业务

禁止：

- 把 subjects / tags / question-types 直接写死在前端
- 把翻译 / 导出做成前端临时逻辑绕过后端
- 用 mock 数据替代真实存储

## 三、代码结构约束

### 3.1 目录约束

所有新业务代码只能进入：

- `backend/src/routes/*`
- `backend/src/domains/*`
- `backend/src/lib/*`

不允许新增：

- `legacy`
- `compat`
- `adapter-runtime`
- `internal` 作为主业务目录

### 3.2 Domain 结构约束

每个业务域默认结构：

```text
backend/src/domains/<domain>/
  service.ts
  repository.ts
  types.ts
  <capability-a>-service.ts
  <capability-b>-service.ts
```

要求：

- `service.ts` 只做门面编排
- `repository.ts` 只做持久化读写
- `types.ts` 只放本域模型
- 能力复杂时必须拆 `*-service.ts`
- `routes/*.ts` 不写业务逻辑

### 3.3 文件大小约束

硬约束：

- `routes/*.ts` 超过 200 行必须拆辅助函数
- `domains/*/service.ts` 超过 350 行必须按能力拆分
- 任一单文件超过 600 行，默认视为结构失败，必须先拆再继续

### 3.4 跨域逻辑约束

只有跨多个 domain 复用且不带业务语义的逻辑，才能进入 `backend/src/lib/*`。

例如：

- 文件系统辅助
- 路径策略
- 加密
- JSON store
- 通用 ID 生成

不能进入 `lib` 的内容：

- flashcard scheduling
- question grading
- OCR selection logic
- wiki evidence binding

## 四、迁移执行顺序

### 4.1 第一优先级

- `documents`
- `questions`
- `favorites`
- `taxonomies`

原因：这些是前端当前仍直接依赖、且后续脑图/闪卡/wiki/agent 都要依赖的基础业务。

### 4.2 第二优先级

- `learning-artifacts`
  - `mindmaps`
  - `flashcards`

### 4.3 第三优先级

- `translation`
- `export`

说明：

- 旧 Python 中的向量知识库 / KB / RAG 能力不再迁移到 TS 主后端。
- 该部分按产品决策标记为“废弃”，不再作为漏迁项推进。
- 后续如果需要知识层能力，统一以 `workroom/wiki` 文件真相源和 agent 工作流为主，不恢复旧向量 KB 路线。

## 五、验证约束

### 5.1 每个迁移域都必须有黑盒行为验证

至少验证：

- 成功路径
- 重复创建路径
- 空列表路径
- 不合法输入路径
- 持久化结果

### 5.2 验证必须针对真实新路径

例如迁移后：

- 只测 `backend/src` 的 route
- 不允许再通过旧 Python route 证明“功能还在”

### 5.3 旧实现只能作为对照，不是验收结果

旧 Python 代码的意义仅是：

- 提供功能来源
- 提供行为基准
- 提供迁移核对依据

不能把“旧代码还没删”当成迁移完成。

## 六、当前执行起点

补充废弃项：

- `backend/app/services/kb/*`
- 旧 `KB ingest / evidence graph / retrieval / embeddings / manifest` 路线

这些能力保留在旧代码中仅作为历史参考，不进入新的 TS 迁移目标。

当前从 `taxonomies` 域开始，覆盖：

- `subjects`
- `tags`
- `question-types`

对应旧代码：

- `backend/app/routers/subjects.py`
- `backend/app/routers/tags.py`
- `backend/app/routers/question_types.py`
- `backend/app/services/subject_service.py`
- `backend/app/services/tag_service.py`
- `backend/app/services/question_type_service.py`

目标落点：

- `backend/src/domains/taxonomies/*`
- `backend/src/routes/taxonomies.ts`

验收标准：

- 列表读取正常
- 创建时 get-or-create 语义保留
- 数据按用户归属存储
- 已正式接入 `backend/src/app.ts`

## 七、实际进度快照

截至 2026-04-17 当前代码状态：

### 7.1 已完成并已有真实黑盒结果

- `auth`
- `workrooms`
  - current
  - runtime state
  - source bindings
  - panel artifacts
- `documents`
  - upload
  - preview
  - source markdown
  - source package
  - layout
  - blocks
  - selection resolve
- `studio`
  - documents
  - question cards
  - selection OCR
  - legend crop
- `questions`
  - CRUD
  - sync
  - snapshot
  - split
  - grading
  - grade-run
- `favorites`
- `taxonomies`
- `translation`
- `export`
- `learning-artifacts`
  - current/save/review/stats/escalate

黑盒验证入口：

- `backend/scripts/verify-backend-migration-slice.ts`
- `backend/scripts/verify-studio-selection-ocr.ts`

### 7.2 已有正式 TS 路由，但还缺专项黑盒验收

- `agent`
  - sessions
  - messages
  - run
  - run-stream
  - run-resume-stream
  - approvals
  - files / file-search / file-status
  - commands / shell
  - providers / tools / skills / mcp-status

### 7.3 仍未完成的迁移项

- `learning-artifacts` 正式生成入口
  - mindmap generate
  - flashcard generate
  - question card 批量生成
- `documents/workroom` 预览恢复契约
  - workroom 重新进入后的 preview tabs 恢复
  - extraction session 风格恢复是否还需要保留，需要按新模型收敛
- `agent` 专项黑盒验收与前端 DTO 对齐

### 7.4 已明确废弃

- 向量 KB / embeddings / retrieval / evidence graph
- 旧 `/api/workspaces/*`
- 旧 `/api/files/*`
- 旧 `/api/ocr/*`
- 旧 `/api/legend/*`
