# 开发环境注意事项（Celery 自动启动）

当前 `main.py` 在 FastAPI 启动/关闭时会自动启动/结束一个 Celery worker，方便本地调试异步预览任务。由于我们在 Windows + `uvicorn --reload` 下开发，Celery 的默认多进程池会频繁 spawn/kill 子进程并触发 `WinError 5/6`、`BrokenPipe` 等噪音日志。因此：

- **开发模式**
  - `main.py` 中自动启动的 worker 使用 `--pool=solo`（单进程）。这样不会再创建多个 `SpawnPoolWorker-*`，热重载时也不会刷屏权限错误。
  - worker 通过 `.env` 里的 `REDIS_URL`（例如 `redis://localhost:6379/01`）连接 Redis，并使用专用队列 `exam_preview`，不会和其他项目冲突。

- **生产 / Docker 部署**
  - 不建议让 Web 容器自动启 worker。部署时应将 Celery worker 拆成独立容器，例如：
    ```bash
    celery -A app.celery_app.celery_app worker -l info  # 根据需要指定并发/队列
    ```
  - 可以改回默认的 `prefork` pool（或指定 `--pool=prefork`），按部署环境的 CPU/内存调高并发数。
  - FastAPI 容器只负责 HTTP 请求，Celery worker/beat 可通过 docker-compose 或 Kubernetes 单独定义。

- **切换提示**
  - 如果后续需要关闭自动启动（例如调试生产配置），可以给 `start_celery_worker` 增加环境开关，例如读取 `AUTO_START_CELERY`，以便在不同场景下灵活控制。

记录于 2025-12-28，用于提醒后续开发/部署不要忘记上述区别。

## 2025-12-31：多租户订阅 + Agent 数据结构

为学习 Agent 落地 Mode B（实时同步）方案，新增了以下表/模型，全部带 `tenant_id` 以确保隔离：

- `plans`：定义套餐，包含 `code`、`max_agent_tokens_month`、`max_agent_sessions_day`、`features`(JSON)。
- `subscriptions`：租户订阅实例，关联 `plan`，记录周期 `current_period_start/end` 与 `status`(`trialing/active/past_due/canceled`)。
- `documents`：右侧编辑区的“试卷/视图”，关联 `owner_user_id`、上传的 `file_id`、`session_id`。
- `questions`：文档内的题目；`sequence_index`、`page`、`content`(富文本/markdown)、`legend_images`(JSON)。
- `agent_sessions`：侧边栏问答会话，包含 `view_id`（前端的编辑视图标识）与 `status`。
- `agent_messages`：会话消息存档，记录 `role`、`content` 和 `token_usage`。

### 使用约定

1. **增量同步**：前端在 `QuestionEditor` 更新时调用 `/api/agent/sync_question`，写入 `questions` 表（需要前端发送 `document_id`、`question_id`、`content`、`legend_images`）。
2. **工具 `get_editor_snapshot`**：LangGraph 工具通过 `document_id + tenant_id` 查询 `questions`，返回按 `sequence_index` 排序的题目列表，供模型读取。
3. **订阅校验**：所有 Agent 入口（`sync_question`、`agent/chat` 等）需根据 `tenant_id` 查 `subscriptions + plans`，决定是否允许调用并统计配额。
4. **缓存策略**：若后续对 `questions` 查询压力大，可在写入后同步刷新 Redis key（例如 `questions:{tenant}:{document}`）供工具直接读取。

后续若增加更多 Agent 功能（如让模型直接改题），可在 Graph 中新增工具 `update_question`，但必须复用 `questions` 表并保持 `tenant_id` 过滤。

### 表结构快速创建脚本

在 `scripts/apply_schema.py` 中提供了一个可执行脚本，用于把 `db/schema.sql` 一次性导入到当前 `.env` 指向的 MySQL：

1. 确认 `.env` 中的 `MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DB` 或 `DATABASE_URL` 配置正确。
2. 安装依赖（如果尚未安装）：`pip install -r requirements.txt`，确保包含 `SQLAlchemy` 和 `pymysql`。
3. 运行：
   ```bash
   cd backend
   python -m scripts.apply_schema            # 使用默认 db/schema.sql
   # 或者指定其它 schema
   python -m scripts.apply_schema --schema ./db/schema.sql
   ```

脚本流程：

- 使用 `.env` 的数据库配置创建连接；
- 若 schema 中包含 `CREATE DATABASE ...` 则会先在 server 级别执行；随后切换到指定数据库执行剩余 `CREATE TABLE` 等语句；
- 控制台会打印每条语句，便于排查错误。

## 2026-01-21：题目信息 Skill 与上下文访问改造

为解决“新会话自动背整份题卡快照、token 快速膨胀、跨 session 串题”问题，同时保留题卡按钮注入的完整上下文与视觉补充能力，后端需引入 **fetch-question-context skill** 并重构上下文注入路径：

1. **数据字段要求**
   - `questions` 表已有题干、选项、解析、`legend_images`、`answer_mode` 等字段，未来统一通过 `fetch_question_context` 返回。
   - 新增/确认字段：`latest_user_answer`、`grading_result`、`grading_rubric`、`has_vision_asset`（布尔，取决于 `legend_images` 非空）、`answer_history`、`session_id`。
   - Skill 返回完整结构体，确保含图题能触发视觉代理（`has_vision_asset=true` 时 Supervisor/solver 可继续请求 `vision_node` 输出摘要）。

2. **Skill（工具）接口**
   - 名称：`fetch_question_context`。
   - 入参：`question_id`（必填），`sequence_index`（可选，兼容“第 X 题”自然语言）。
   - 出参：题目 JSON（含上述全部字段）＋推导属性：`display_label`（如“题目 #3”）、`vision_required`、`answer_summary`。
   - 实现位于 LangGraph 工具层，内部按 `tenant_id + document_id + question_id` 读取题目，并校验当前 session 是否有访问权。

3. **上下文注入策略**
   - `solver_node` **不再默认拼接 snapshot**。系统提示只包含 Supervisor 指令、批量配置、笔记摘录等必要信息。
   - 用户若点击题卡“发送给 AI”按钮，由前端直接调用 `fetch_question_context`，把返回结果（结构化 JSON）随同本轮 user 消息传入 `agent_run_stream`，由 router 写进 `state.messages` 里的最新 user turn。
   - 若用户在纯自然语言中提“题目 #X”“第 X 题”，在 Supervisor 节点前新增 `conversation_intent_parser`（Python 逻辑）解析序号，通过 `question_index_map` 映射到真实 `question_id`，然后自动调用 skill，将结果塞进系统提示 `doc_ctx`，并给 Supervisor 一个简短提示“当前对话显式引用题目 #X”。
   - 如果既没有按钮也没有可解析题号，模型不可自行加载整份题卡，只能提示用户指定题目或点击按钮。

4. **视觉能力衔接**
   - `fetch_question_context` 返回 `legend_images` 列表；当列表非空时，Supervisor 在 JSON 中将 `focus_sequence_index` 与 `require_vision` 一并设定。
   - `vision_node` 根据 `state.supervisor_focus_question_id` 调用 `QwenVisionClient` 生成摘要，仅覆盖被引用的题目，避免以前那种“遍历所有题目图片”的昂贵行为。

5. **前端配合**
   - 题卡按钮改为调用 `/agent/fetch_question_context`，把返回 JSON 直接插入输入框隐藏 payload（与 skill 输出保持一致），而不是简单写入“@题目X”。
   - 聊天输入法保留 `@题目X` 快捷语法，便于用户引用；后端解析逻辑统一复用。

6. **Supervisor / Solver 调整**
   - Supervisor prompt 中补充“题目信息 skill”说明：只有收到题卡上下文时才可引用题干；缺失时要提示用户。
   - Solver prompt 同步更新，强调“如需题卡详情，须调用 fetch_question_context 工具；不要假设默认可见”。

7. **迁移步骤**
   1. 后端实现 `fetch_question_context` 接口与 LangGraph 工具注册，确保返回字段完整。
   2. Router 增加 `question_index_map` 注入＋`conversation_intent_parser`，解析 `@题目`／“第 X 题”／“题目 #X”。
   3. 移除 `snapshot_questions` 自动写入 solver/supervisor system prompt，只保留标题/统计等轻量信息。
   4. 前端题卡按钮改走新接口，并在自然语言输入时保留 `@题目` 辅助提示。
   5. 观察视觉任务链路，确认只有被引用的题触发 `vision_node`。

该方案保证：
- 新会话默认不携带任何题目正文，token 成本与会话内容线性相关；
- 任意会话都能按需引用共享题卡，并保留图片/批改/作答上下文；
- 用户无需额外点击即可通过自然语言触发 skill，体验等同“AI IDE”；
- Supervisor/solver 能继续感知图片题并调度视觉代理，避免能力回退。
## 2026-03-28锛歀ayout KB Backfill

鏂板鍥炲～鑴氭湰锛?

- `python scripts/backfill_page_layout_cache.py --tenant 2`
  - 鎸夌幇鏈?preview 椤靛浘鍥炲～ `file_page_layout_cache`
  - 宸插畬鎴愮殑椤典細鎸夌紦瀛樺敮涓€閿烦杩囷紝鍏锋湁骞傜瓑鎬?
- `python scripts/backfill_kb_layout_blocks.py --tenant 2`
  - 瀵瑰凡鏈夐〉绾?layout cache 鐨勬枃浠堕噸璧?KB ingest锛屽啓鍏?layout-aware chunks/units
  - 榛樿鍙鐞?`workroom_id IS NULL` 鐨勬櫘閫?KB source
  - 濡傛灉鏈€鏂?source 宸叉槸 `ready`锛屽垯鐩存帴璺宠繃锛岄伩鍏嶉噸澶嶇墿鍖?

寤鸿鎵ц椤哄簭锛?

1. 鍏堣窇 `backfill_page_layout_cache.py`
2. 鍐嶈窇 `backfill_kb_layout_blocks.py`

杩欎袱涓剼鏈兘鏄悓姝ュ埗寮忚剼鏈紝涓嶄緷璧?Celery worker锛岄€傚悎鏈湴缁存姢鍜屾墜鍔ㄥ洖濉€?
