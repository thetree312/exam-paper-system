# Frontend Alignment Handoff

Date: 2026-04-18
Audience: 下一位继续做前端对齐与迁移的人
Purpose: 记录本轮前端对齐到哪里、哪些文件已经改过、哪些地方仍未完成、如何从当前停点继续，不需要重新做一轮全仓审计。

## 1. 本轮目标与实际停点

本轮做的不是“完成前端全量切换”，而是把前端从旧接口面开始往当前 TS 后端正式接口面迁移，并优先清掉最明显的结构错位：

- 后端真实正式接口已经以这些业务域为主：
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
- 前端原来仍大量依赖旧接口：
  - `/api/workspaces/*`
  - `/api/files/*`
  - `/api/ocr/*`
  - `/api/glm-ocr/*`
  - `/api/flashcards/*`
  - `/api/mindmaps/*`
  - 若干 numeric id 假设
- 这轮已经开始把前端往新接口面收拢，但还没有收尾。

当前真实停点：

- 文档上传链路已经切到 `/api/documents/upload`
- studio 框选识别链路已经切到 `/api/studio/*`
- flashcard service 已切到 `/api/learning-artifacts/*`
- mindmap service 已切到 `/api/learning-artifacts/*`
- workroom/workspace 入口服务已经开始改为基于 `/api/workrooms/*`
- workroom 重开恢复已经不再只是“恢复到 workroom 页面”，而是已开始恢复实际工作内容：
  - 打开的 documents tabs
  - 当前 active document
  - studio/extraction document context
  - OCR cards
  - flashcard panel 进度
  - agent 当前 session
  - 左侧 preview pane 的折叠/宽度/收藏视图/滚动位置
- 认证默认后端地址已经从 `8000` 改到 `3000`
- 但前端仍未达到可交付状态，主要卡在：
  - 类型系统还没收敛干净
  - `AgentWorkspacePanel/useAgentSync/useConversation/useAgentChat` 还带着旧问题编辑器语义
  - `App.tsx` 仍然承担了过多旧状态编排，里面仍有不少 string/number 兼容残留
  - 还有一批 UI 组件仍默认旧 DTO 和旧 numeric id

## 2. 已经修改过的文件

下面这些文件这轮已经动过，后续接手时不要再按“未迁移”处理。

### 2.1 路由与全局状态

- `frontend/src/appRoutes.ts`
  - `workspaceId` 路由参数已从 number 改成 string 路径语义
  - `buildWorkroomPath()` 已按 string id 处理
- `frontend/src/store/appStore.ts`
  - `previewScrollPositions` 改为 `Record<string, number>`
  - `agentDocumentId` 改为 `string | null`
- `frontend/src/types.ts`
  - 已开始把大量前端实体从纯 numeric id 放宽为 `string | number`
  - flashcard 相关类型已经改到 learning-artifact 形态
  - 但这个文件仍然是后续类型清理的核心热点，不能认为已结束
- `frontend/src/utils/secureStorage.ts`
  - 存储的用户 `id` 已允许 `string | number`

### 2.2 认证

- `frontend/src/hooks/useAuth.ts`
  - 登录、注册、恢复登录态时，不再把后端返回的 string id 强行抹成 `0`
  - 仍然残留 `tenant_id: 0` 占位语义，因为当前后端主鉴权不再走 tenant，但前端旧类型暂时还没完全清掉
  - 下一步应该继续清 tenant 语义，而不是扩散它

### 2.3 workroom / workspace 入口

- `frontend/src/services/workspaceApi.ts`
  - 已重写，不再按旧 workspace 服务去找老接口
  - `fetchWorkspaces()` 现在走 `/api/workrooms`
  - `createWorkspace()` 现在走 `/api/workrooms`
  - `launchWorkspace()` 现在优先消费 `/api/workrooms/:id` 的完整恢复载荷
  - 已开始恢复并写回：
    - `documents`
    - `restoration`
    - `runtime_state`
    - `artifacts`
  - `deleteWorkspace()` 现在走 `/api/workrooms/:id`
- `frontend/src/services/workroomApi.ts`
  - workroom 相关 ID 已切成 string
  - artifact 的 upsert/fetch 已开始走 `/api/workrooms/:workroomID/artifacts/:artifactType/:artifactRefID`

注意：
- 文件名还是 `workspaceApi.ts`，但它的职责已经越来越像 workroom 首页入口服务。
- 如果下一步要继续做结构收敛，可以评估改名，但改名前先把调用方全量理顺，不要只改文件名不改语义。

### 2.4 文档上传与预览

- `frontend/src/hooks/useFileUpload.ts`
  - 已从旧 `/api/files/upload-image` 切到 `/api/documents/upload`
  - 已移除旧 `/api/files/session/*` 轮询逻辑
  - 现在上传完成后直接用新后端返回的 document 数据构造 tab
  - 预览页 URL 现在走 `/api/documents/:id/preview?workroom_id=...&page=...`
  - tab 的 `sessionId/fileId` 已改为真实 document id
  - placeholder tab 也已改为 string id
  - 当前 tab 的 preview scroll 已开始写入并恢复自 workroom runtime state

当前注意点：
- 这个 hook 现在已经不应该再接回旧 files/session 接口。

### 2.5 studio 框选识别链路

- `frontend/src/services/studioApi.ts`
  - 新增，真实对接当前 TS backend 的 `/api/studio/*`
  - 已包括：
    - `listStudioDocuments()`
    - `createStudioDocument()`
    - `listStudioQuestionCards()`
    - `recognizeStudioSelection()`
    - `updateStudioQuestionCard()`
    - `deleteStudioQuestionCard()`
- `frontend/src/hooks/useOcrManager.ts`
  - 已移除对旧 `/api/ocr/extract` 和 `/api/legend/extract` 的依赖
  - `handleAddToEditor()` 现在调用 `/api/studio/question-cards/recognize-selection`
  - 返回结果已转成 `AggregatedOcrItem`
  - 更新题卡和删除题卡已经切到 `/api/studio/question-cards/:id`

关键语义已经对齐：
- 框选识别是：`preview bbox -> 云 OCR -> studio question card`
- 它不是 documents layout 识别，也不是 raw source markdown 生成链路

当前未完：
- `useOcrManager.ts` 里虽然已经去掉了一部分 `0` fallback，但仍未彻底收干净
- grading/split 相关连接仍带旧问题编辑器的数据假设

### 2.6 flashcard

- `frontend/src/services/flashcardApi.ts`
  - 已整文件重写到 `/api/learning-artifacts/*`
  - 已支持：
    - generate
    - list
    - due
    - review
    - stats
    - agent escalate
  - 已把后端 learning artifact 映射成新的 `FlashcardItem`
- `frontend/src/components/FlashcardPanel.tsx`
  - props 已切到 `workroomId + documentId + ensureDocument`
  - 调用已改到新 flashcard service
  - 不再应该回退到旧 `/api/flashcards/*`
  - 已增加 `flashcard_panel/current` artifact 持久化
  - 当前 mode / currentIndex / currentCardId / revealed 状态已支持重开恢复

当前未完：
- 组件内部仍有一些旧数据依赖和类型不收敛问题
- 要继续对齐 `documentId` 的 string 语义

### 2.7 mindmap

- `frontend/src/features/mindmap/domain/types.ts`
  - mindmap document/source/question 引用 id 已开始放宽
- `frontend/src/features/mindmap/api/mindmapApi.ts`
  - 已整文件重写到 `/api/learning-artifacts/mindmaps/*`
  - 已支持 generate/current/save
  - 已添加 artifact -> UI document payload 的映射逻辑
- `frontend/src/features/mindmap/MindMapPanel.tsx`
  - props 已开始切到新的 `workroomId/documentId/fileId`
  - source mapping 已开始改成新 artifact source 语义
  - panel state 已经在 `mindmap_panel/current` 中持久化，并在 workroom 打开后恢复

当前未完：
- `mindmapApi.ts` 仍有几处 string/number 到 string 的类型错误
- `MindMapPanel.tsx` 内部还有若干调用链没有彻底清理旧 numeric 假设

### 2.8 agent / editor 相关组件

这些文件已经开始改，但还没有收尾：

- `frontend/src/hooks/useConversation.ts`
- `frontend/src/hooks/useAgentSync.ts`
- `frontend/src/hooks/useAgentChat.ts`
- `frontend/src/components/AgentChatPanel.tsx`
- `frontend/src/components/AgentWorkspacePanel.tsx`
- `frontend/src/components/EditorWorkspaceShell.tsx`
- `frontend/src/components/PreviewPaneShell.tsx`
- `frontend/src/App.tsx`

这些文件当前的真实状态是：
- 已经开始把 `userId/workroomId/documentId` 放宽到 `string | number`
- 部分 props 已做 string 化处理
- `App.tsx` 已接入统一 workroom 恢复逻辑，当前会恢复：
  - documents tabs
  - active document
  - studio document
  - agent session
  - preview pane state
  - flashcard / mindmap / agent drawer 的主要上下文
- `App.tsx` 已接入 studio 文档恢复逻辑，去掉了旧 `fetchSnapshot` 的一部分路径
- `handleRunGlmOcr()` 已不再走旧 `/api/glm-ocr/*`，而是改成：
  - 查找或创建 studio document
  - 拉取已有 studio question cards
  - 将其恢复到中间编辑器
- `useConversation/useAgentChat/useAgentSync/useQuestionTypeOptions` 中与 `tenant_id: 0` 冲突的 truthy 判断已经开始修正

但这些文件目前仍是前端迁移的主要阻塞点。

## 3. 这轮已经确认的关键事实

### 3.1 登录报 `ERR_CONNECTION_REFUSED` 的直接原因

用户之前截图里的登录失败，不是鉴权代码本身先报业务错误，而是浏览器请求不到后端。

已确认的直接原因：
- 前端默认请求地址当时还是 `http://localhost:8000`
- 当前 TS backend 运行端口是 `3000`

这轮已修改：
- `frontend/src/App.tsx` 中 `FALLBACK_BACKEND` 已改为 `http://localhost:3000`

但注意：
- 其他位置如果还存在写死的 8000，仍需要继续清。
- 继续对齐前，先全局搜一遍 `localhost:8000`。

### 3.2 当前后端 ID 语义不是 number

当前 TS backend 广泛使用 string 型 id，例如 `createID(...)` 产物。

因此前端原来那种：
- 路由参数只接受数字
- documentId/fileId/sessionId/workroomId 全按 number 处理
- `parseInt()` 后继续传给后端

都会导致新的 TS 后端契约无法稳定工作。

所以这轮的一个大方向就是：
- 先允许 `string | number`
- 再逐步收缩为明确 string

现在还停在这个中间态。

### 3.3 studio 与 documents 语义必须继续分离

已经明确过：
- documents/layout/source-package/raw markdown 是原始文件处理链路
- studio/question-cards/recognize-selection 是用户在预览图上的自由框选识别链路

下一位接手时不能再把这两条链路重新揉回一个 OCR 接口模型里。

## 4. 当前没有完成的部分

### 4.1 仍未完成前端类型收敛

虽然已经把很多核心实体放宽到 `string | number`，但这只是过渡，不是完成。

当前还没收干净的热点：
- `frontend/src/App.tsx`
- `frontend/src/hooks/useOcrManager.ts`
- `frontend/src/hooks/useFileUpload.ts`
- `frontend/src/hooks/useConversation.ts`
- `frontend/src/hooks/useAgentChat.ts`
- `frontend/src/hooks/useAgentSync.ts`
- `frontend/src/components/AgentWorkspacePanel.tsx`
- `frontend/src/components/EditorWorkspaceShell.tsx`
- `frontend/src/components/AgentChatPanel.tsx`
- `frontend/src/components/FlashcardPanel.tsx`
- `frontend/src/features/mindmap/api/mindmapApi.ts`
- `frontend/src/features/mindmap/MindMapPanel.tsx`

### 4.2 旧 question editor / agent sync 语义仍然在拽住新前端

当前最大结构阻塞不是文件上传，也不是 flashcard service，而是下面这条旧链：

- `useAgentSync`
- `useConversation`
- `useAgentChat`
- `AgentWorkspacePanel`
- 一部分 `agentApi.ts` 里的旧快照/同步/批改接口语义

这条链仍然带着：
- 旧 question snapshot
- 旧 numeric document id
- 旧 agent/document 绑定关系
- 旧前端编辑器与 agent 的耦合方式

如果不处理这条链，前端很难真正和现在的 workroom + studio + documents + learning-artifacts 模型对齐。

补充说明：
- `AgentWorkspacePanel` 现在已把远端 snapshot 拉取降级成“版本信息补全兜底”，不再把 snapshot 当主数据源
- 但 questions/snapshot 同步接口本身仍然属于旧 editor 时代语义，后续仍需继续收口

### 4.3 `App.tsx` 仍然过重

`frontend/src/App.tsx` 现在已经被用来兼容很多迁移中状态：
- auth
- workroom launch
- runtime state restore
- studio document restore
- toast
- upload status
- route sync
- agent drawer state
- preview pane state

它当前不是单纯“风格不好”，而是会继续放大迁移难度。

但当前建议不是先重构 `App.tsx`，而是：
- 先把契约完全切对
- 再拆分 `App.tsx`

否则容易一边改契约一边拆状态，导致更乱。

## 5. 当前建议的续做顺序

下一位接手时，建议严格按这个顺序继续，而不是跳着修：

1. 先把 migration 相关类型错误继续清掉
2. 再把 agent/editor 旧链路改到新 DTO
3. 再回头做 mindmap/flashcard 面板的最终收口
4. 最后做 `App.tsx` 的结构拆分和前端全量验证

更具体一点：

### Step 1. 先清这些文件的迁移型错误

按顺序：
- `frontend/src/App.tsx`
- `frontend/src/components/EditorWorkspaceShell.tsx`
- `frontend/src/components/FlashcardPanel.tsx`
- `frontend/src/features/mindmap/api/mindmapApi.ts`
- `frontend/src/features/mindmap/MindMapPanel.tsx`
- `frontend/src/hooks/useFileUpload.ts`
- `frontend/src/hooks/useOcrManager.ts`
- `frontend/src/hooks/useAgentChat.ts`
- `frontend/src/hooks/useQuestionTypeOptions.ts`

### Step 2. 再处理 agent/editor 老链路

按顺序：
- `frontend/src/hooks/useConversation.ts`
- `frontend/src/hooks/useAgentChat.ts`
- `frontend/src/hooks/useAgentSync.ts`
- `frontend/src/components/AgentWorkspacePanel.tsx`
- `frontend/src/components/AgentChatPanel.tsx`

核心目标：
- 不再围绕旧 snapshot/editor 流程编排
- 以当前后端真实实体为主：
  - workroom
  - source document
  - studio document
  - studio question card
  - agent session

### Step 3. 全局搜索并拔掉旧接口残留

继续搜这些模式：
- `/api/files`
- `/api/ocr`
- `/api/glm-ocr`
- `/api/flashcards`
- `/api/mindmaps`
- `localhost:8000`
- `tenant_id` 作为鉴权主路径
- `parseInt(` 针对 document/workroom/session id

只要还留着，就说明前端没对齐完。

## 6. 如何从我停下的地方继续

### 6.1 先读这些文件

进入下一轮之前，先读：
- `AGENTS.md`
- `docs/codex-reflection-2026-04-16.md`
- `docs/frontend-backend-contract-audit-2026-04-17.md`
- 本交接文档

### 6.2 接着看这些代码文件

先看已经改过的入口：
- `frontend/src/App.tsx`
- `frontend/src/hooks/useFileUpload.ts`
- `frontend/src/hooks/useOcrManager.ts`
- `frontend/src/services/studioApi.ts`
- `frontend/src/services/workspaceApi.ts`
- `frontend/src/services/workroomApi.ts`
- `frontend/src/services/flashcardApi.ts`
- `frontend/src/features/mindmap/api/mindmapApi.ts`

然后再看阻塞链：
- `frontend/src/hooks/useConversation.ts`
- `frontend/src/hooks/useAgentSync.ts`
- `frontend/src/hooks/useAgentChat.ts`
- `frontend/src/components/AgentWorkspacePanel.tsx`
- `frontend/src/components/AgentChatPanel.tsx`

### 6.3 继续时不要做的事

不要：
- 把旧 `/api/files/*` 再接回来当过渡
- 把 studio 框选识别和 documents layout 识别揉成同一个接口
- 再引入兼容层、fallback、placeholder DTO
- 因为类型冲突就把 string id 强行 `Number(...)` 回去
- 在契约没切对前先大拆 UI 结构

### 6.4 继续时应采用的判断标准

判断前端是否继续在往正确方向走，不看“页面暂时能不能凑合显示”，看这些：
- 是否还在调用旧接口
- 是否还在用 numeric-only id 假设
- 是否仍把 studio/document/agent 混成旧 question editor 模型
- 是否仍把 tenant_id/user_id 当授权主路径

## 7. 当前已知但尚未再次验证的事项

这轮我没有在写交接文档前重新跑一轮新的前端验证。

我保留的已知状态是：
- 前端没有 `npm run typecheck` 脚本
- 之前实际用过的检查命令是：
  - `npx tsc --noEmit`
- 上一次检查时，前端仍然存在一批 TypeScript 错误
- 这些错误里，既有迁移相关错误，也有仓库里更早就存在的非本轮问题

因此下一位接手时，应该在做出下一批代码改动后，再用：

```powershell
cd frontend
npx tsc --noEmit
```

去收敛迁移相关错误。

## 9. 本轮新增的恢复能力

这部分是本轮后续追加的，前面章节未完全覆盖，单独列出：

- workroom 当前页打开时，前端已不再靠 `/api/documents` 临时拼 tabs，而是直接使用 `/api/workrooms/:id` 返回的：
  - `documents`
  - `restoration`
  - `runtime_state`
- `runtime_state` 当前已写回并恢复这些字段：
  - `active_file_id`
  - `active_session_id`
  - `active_tab_index`
  - `active_studio_document_id`
  - `active_agent_session_id`
  - `active_extraction_session_id`
  - `open_document_ids`
  - `left_panel_state_json`
  - `center_panel_state_json`
  - `right_panel_state_json`
- `left_panel_state_json` 当前已开始覆盖：
  - `app_view`
  - `is_preview_collapsed`
  - `left_width`
  - `preview_scroll_positions`
- workroom 当前 source document 改变时，会自动重新解析对应的 studio document；若当前 studio/agent 上下文已失配，会主动清掉旧上下文，避免串文档恢复
- agent 会话恢复已经接上 `active_agent_session_id`
- flashcard 当前浏览位置已持久化到 `flashcard_panel/current`
- mindmap 面板当前状态已持久化到 `mindmap_panel/current`

### 9.1 本轮顺手清掉的假值/误导性 UI

- `sessionId/fileId/workroomId/documentId` 的多个 `0` fallback 已经开始清理，尤其是：
  - `EditorConnector`
  - `AgentConnector`
  - `useOcrManager`
- UI 上直接显示 `Tenant #0` 的地方已隐藏，避免继续把占位值展示给用户
- `SourcePaneConnector` 若被走到，也不再同时渲染 source pane 与 favorites，且 favorites -> editor 不再是空操作

## 8. 一句话总结

这轮不是“前端已对齐完成”，而是已经把前端从旧 `files/ocr/flashcards/mindmaps` 接口面，推到了新的 `documents/studio/learning-artifacts/workrooms` 契约方向上；真正还没打通的，是 agent/editor 老链路、全局 string id 收敛，以及最终的前端类型清理。
