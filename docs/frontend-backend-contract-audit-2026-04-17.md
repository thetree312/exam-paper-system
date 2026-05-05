# TS 后端漏迁功能审计

日期：2026-04-17

## 目标

这份文件不再讨论“前端该改哪些接口”，而是回到当前真实目标：

- 旧 Python 后端里，哪些业务已经迁到 `backend/src`
- 哪些已经有正式 TS 路由和持久化
- 哪些虽然有代码，但还没有被黑盒验证
- 哪些已经明确废弃，不再迁移

## 当前 TS 后端正式暴露面

- `/api/auth/*`
- `/api/workrooms/*`
- `/api/wiki/*`
- `/api/documents/*`
- `/api/learning-artifacts/*`
- `/api/agent/*`
- `/api/model-settings/*`
- `/api/questions/*`
- `/api/studio/*`
- `/api/favorites/*`
- `/api/taxonomies/*`
- `/api/translation/*`
- `/api/export/*`

## 按旧 Python router 的迁移状态

| 旧 Python router | 旧能力 | TS 落点 | 当前状态 | 验证状态 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `auth.py` | 注册、登录 | `src/routes/auth.ts` + `domains/auth/service.ts` | 已迁移 | 已验证 | 返回 `user + token + sessionID`，Bearer 模式成立 |
| `workroom.py` | current、state、sources、artifacts | `src/routes/workrooms.ts` + `domains/workrooms/*` | 已迁移 | 已验证 | 本轮已补齐 `GET /current`、`GET/PUT state`、`GET/POST sources`、`GET/PUT artifacts` |
| `workspace.py` | workspace 列表、创建、launch、删除 | 无 | 不迁移 | 不适用 | 已按架构决策废弃，真实主实体是 `workroom`，不再保留 workspace 中间层 |
| `files.py` | 上传、预览、session、workroom tabs、KB manifest | `src/routes/documents.ts` + `domains/documents/*` | 部分迁移 | 已验证主链路 | 已有 upload/list/detail/source-package/source-markdown/layout/blocks/selection/preview；其中 `selection/resolve` 仅负责框选命中现有 layout block，不负责云 OCR 识别；旧 `session`、`tabs`、`kb-manifest` 不再按原接口迁移 |
| `questions.py` | 题目 CRUD | `src/routes/questions.ts` + `domains/questions/*` | 已迁移 | 已验证 | 列表、创建、更新、删除、按文档读取已通 |
| `favorites.py` | 收藏、限额、检查 | `src/routes/favorites.ts` + `domains/favorites/*` | 已迁移 | 已验证 | 收藏主链路已通 |
| `subjects.py` | 学科 | `src/routes/taxonomies.ts` + `domains/taxonomies/*` | 已迁移 | 已验证 | get-or-create 语义保留 |
| `tags.py` | 标签 | `src/routes/taxonomies.ts` + `domains/taxonomies/*` | 已迁移 | 已验证 | get-or-create 语义保留 |
| `question_types.py` | 题型 | `src/routes/taxonomies.ts` + `domains/taxonomies/*` | 已迁移 | 已验证 | get-or-create 语义保留 |
| `translation.py` | 翻译 | `src/routes/translation.ts` + `domains/translation/*` | 已迁移 | 已验证 | 已移除多模型 fallback，改为走用户模型控制面 |
| `export.py` | 模板列表、Word 导出 | `src/routes/export.ts` + `domains/export/*` | 已迁移 | 已验证 | 已改为显式解析本地 `pandoc.exe` |
| `flashcards.py` | 生成、列表、due、review、stats、agent escalate | `src/routes/learning-artifacts.ts` + `domains/learning-artifacts/service.ts` | 部分迁移 | 已验证核心闭环前段 | 已有 create/list/due/review/stats/escalate；旧 `/generate` 仍未迁移 |
| `mindmap.py` | generate、current、save | `src/routes/learning-artifacts.ts` + `domains/learning-artifacts/service.ts` | 部分迁移 | 已验证 current/save | 已有 create/current/update；旧 `/generate` 语义仍未迁移 |
| `ocr.py` | 预览图自由框选后调用云 OCR 识别并落到中间题卡 | `src/routes/studio.ts` + `domains/studio/*` | 已迁移 | 已验证 | 已和 `documents` 的 layout/source-package 流程分离；新链路是 `preview bbox -> cloud OCR -> studio question card` |
| `legend.py` | 题目图例区域裁切与绑定 | `src/routes/studio.ts` + `domains/studio/*` | 已迁移 | 已验证 | 作为框选识别的附属区域输入存在，不再伪装成 layout block 命中 |
| `agent_v2.py` | session、messages、run、run-stream、resume、审批、文件、命令、provider/model | `src/routes/agent.ts` + `domains/agent/service.ts` | 已迁移 | 部分验证 | 本轮未跑全量 runtime 黑盒，但 route 面已齐；问题主线不在路由缺失，而在后续前端接入与 runtime 深测 |

## 已迁移并已黑盒验证的能力

本轮通过 `backend/scripts/verify-backend-migration-slice.ts` 已实测成功：

- `auth`
  - `POST /api/auth/register`
  - Bearer 鉴权
- `workrooms`
  - `POST /api/workrooms`
  - `GET /api/workrooms/current`
  - `GET /api/workrooms/:id/state`
  - `GET /api/workrooms/:id/sources`
  - `GET /api/workrooms/:id/artifacts/:type/:ref`
- `documents`
  - `POST /api/documents/upload`
  - 上传后自动生成 preview/layout/raw markdown/source package
  - 上传后自动绑定到 workroom source
  - `POST /api/documents/:documentID/selection/resolve`
  - 仅返回框选与现有 layout block 的空间命中结果
- `questions`
  - `POST /api/questions/split`
  - `POST /api/questions`
  - `PATCH /api/questions/:id`
  - `POST /api/questions/sync`
  - `POST /api/questions/:id/grading`
  - `POST /api/questions/grade-run`
  - `GET /api/questions/snapshot/:documentID`
  - `GET /api/questions?document_id=...`
- `favorites`
  - `POST /api/favorites`
  - `GET /api/favorites/:questionID/check`
  - `GET /api/favorites/quota`
  - `GET /api/favorites`
  - `DELETE /api/favorites/:questionID`
- `taxonomies`
  - `POST /api/taxonomies/subjects`
  - `POST /api/taxonomies/tags`
  - `POST /api/taxonomies/question-types`
- `translation`
  - `POST /api/translation/lookup`
  - 返回了真实翻译结果
- `export`
  - `GET /api/export/templates`
  - `POST /api/export/word`
  - 返回真实 docx 字节流
- `learning-artifacts`
  - `POST /api/learning-artifacts/mindmaps`
  - `GET /api/learning-artifacts/mindmaps/current`
  - `PUT /api/learning-artifacts/mindmaps/:id`
  - `POST /api/learning-artifacts/flashcards`
  - `GET /api/learning-artifacts/flashcards/due`
  - `GET /api/learning-artifacts/flashcards/stats`
  - `POST /api/learning-artifacts/:id/review`
  - `POST /api/learning-artifacts/flashcards/:id/agent-escalate`

## 已迁移并已专项黑盒验证的能力

- `studio`
  - `GET /api/studio/documents`
  - `POST /api/studio/documents`
  - `GET /api/studio/question-cards`
  - `POST /api/studio/question-cards/recognize-selection`
  - `PATCH /api/studio/question-cards/:cardID`
  - `DELETE /api/studio/question-cards/:cardID`

说明：

- 这一组接口对应的是“用户在预览图上自由框选，然后后端调用云端 OCR 识别，再把结果落到中间 studio 题卡”的链路。
- 它不是 `documents/layout` 的一部分，也不是原始文件转 markdown 的 layout OCR。
- 已通过 `backend/scripts/verify-studio-selection-ocr.ts` 跑通真实云 OCR，实际返回题卡文本：
  - `## mitmweb --listen-host 127.0.0.1 --listen-port 58888 --web-open-browser`

## 当前仍未完成的 TS 后端迁移项

### 1. `learning-artifacts` 仍缺旧产品里的生成入口

当前已有：

- artifact 持久化
- current/save/review/stats/escalate
- workroom panel artifact 映射

仍缺：

- mindmap 的正式 `generate` 入口
- flashcard 的正式 `generate` 入口
- question card 的批量生成入口

结论：

- 当前 TS 后端已经能承载“已有产物的读取、修改、调度、回流”
- 但“从文档或 wiki 主动生成产物”的正式业务入口还没有补齐

### 2. `documents` 还没有补“会话式预览恢复”专门接口

当前已有：

- 文档上传
- preview/layout/blocks/selection/source-package/source-markdown
- workroom source binding

仍缺：

- 旧 `/api/files/session/:id` 风格的显式 extraction session 恢复接口
- 旧 `/api/files/workroom/:id/tabs` 风格的专门 tabs 恢复接口

说明：

- 这并不阻断新架构
- 但如果前端还保留“重进工作间后恢复预览标签页”的 UI，就要在新契约里明确由 `workroom runtime state + documents list + bound sources` 组合恢复，或者补一个新的正式恢复接口

### 3. `agent` 还缺针对新架构的一轮专门黑盒验证

当前代码面已有：

- session create/list/get/update/delete
- messages list/send
- run
- run-stream
- run-resume-stream
- approvals
- files/file-status/file-search
- commands/shell
- providers/default-model/tools/skills/mcp-status

仍缺：

- 一份独立的 TS backend 黑盒验收，证明这些路由在当前 `backend/agent/dist/agent.mjs` 集成状态下全通
- 前端最终 DTO 对齐验证

说明：

- 这不是“接口缺失”问题
- 是“还没跑完一轮整体验证”问题

## 明确废弃、不再迁移的旧后端能力

- `backend/app/services/kb/*`
- 向量知识库 / embedding / retrieval / evidence graph
- 旧 `/api/workspaces/*`
- 旧 `/api/files/*` 原接口面
- 旧 `/api/ocr/*`
- 旧 `/api/legend/*`
- 任何以 `tenant_id/user_id` 作为前端授权主路径的接口面

## 当前代码结构落点

### 已成立的主后端结构

```text
backend/src/
  app.ts
  routes/
    auth.ts
    workrooms.ts
    documents.ts
    studio.ts
    wiki.ts
    questions.ts
    favorites.ts
    taxonomies.ts
    translation.ts
    export.ts
    learning-artifacts.ts
    model-settings.ts
    agent.ts
  domains/
    auth/
    workrooms/
    documents/
    studio/
    wiki/
    questions/
    favorites/
    taxonomies/
    translation/
    export/
    learning-artifacts/
    model-settings/
    agent/
```

### 本轮新增/纠正的落点

- `backend/src/domains/workrooms/types.ts`
- `backend/src/domains/workrooms/repository.ts`
- `backend/src/domains/workrooms/service.ts`
- `backend/src/domains/questions/llm-service.ts`
- `backend/src/domains/questions/split-service.ts`
- `backend/src/domains/questions/grading-service.ts`

## 当前结论

如果只看“旧 Python 后端还剩多少主业务没迁到 TS”：

- `auth / workrooms / documents / questions / favorites / taxonomies / translation / export` 已经有正式 TS 后端落点
- `learning-artifacts` 已经覆盖保存、读取、回流，但“生成入口”还没补齐
- `agent` 的 TS route 面已经齐，但还缺一轮专门黑盒验收
- 向量 KB 路线已明确废弃，不作为漏迁项

所以现在真正剩下的后端迁移主任务，不是再补基础 CRUD，而是：

1. 补 `learning-artifacts` 正式生成入口
2. 补 `documents/workroom` 的预览恢复契约
3. 对 `agent` 做完整黑盒验收并收敛 DTO
