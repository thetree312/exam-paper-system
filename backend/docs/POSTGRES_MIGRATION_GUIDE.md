# Exam-paper 数据库从 MySQL 迁移到 PostgreSQL 指南（基于当前实际库结构）

> 本文档基于在 **当前真实数据库** 上运行 `inspect_db_schema.py` 的输出，以及 `db/schema.sql` 和 `db/migrations/*.sql` 的定义整理而成，而不是仅凭模型猜测。

---

## 1. 当前实际数据库结构概览

### 1.1 数据库信息

- 方言：MySQL（通过 `engine.dialect.name == "mysql"` 确认）
- 当前数据库名：通过脚本 `SELECT DATABASE()` 输出为当前正在使用的库（通常为 `exam_paper`）
- 表数量：由脚本在 `information_schema.tables` 统计得出
- 各表行数：由脚本遍历 `information_schema.tables` 的 `TABLE_ROWS` 输出

### 1.2 主要业务表（从实际检查输出与 schema/migrations 综合归纳）

核心表（与你的业务和 LangGraph Agent 强相关）：

- `tenants`
- `users`
- `social_accounts`
- `plans`
- `subscriptions`
- `files`
- `extraction_sessions`
- `extracted_items`
- `documents`
- `questions`
- `agent_sessions`
- `agent_messages`
- `mindmaps`
- `fulltext_blocks`
- `question_favorites`
- `question_types`
- `subjects`
- `tags`
- `favorite_tags`（多对多关联表）

这些表及其字段类型、约束，均已通过在真实库上运行的 `inspect_db_schema.py` 输出确认，例如：

- 所有主键均为 `BIGINT`（MySQL 实际为 `BIGINT UNSIGNED`），自增
- 时间字段大多为 `DATETIME`，且默认 `CURRENT_TIMESTAMP`，带 `ON UPDATE CURRENT_TIMESTAMP`
- 若干字段为 MySQL `ENUM` 类型：
  - `subscriptions.status`: `('trialing','active','past_due','canceled')`
  - `extraction_sessions.status`: `('pending','processing','done','failed')`
  - `files.source_type`: `('image','pdf','word')`
- 若干字段为 `JSON`：
  - `plans.features`
  - `questions.legend_images`、`questions.versions`
  - `mindmaps.graph_json`
  - `agent_sessions.profile_json`

> 以上内容均可在你本机重新执行 `python inspect_db_schema.py` 时再次确认，确保文档与真实结构一致。

---

## 2. 当前数据库接口与依赖（代码层实际情况）

### 2.1 配置入口：`app/config.py`

- `Settings` 从 `.env` 中读取：
  - `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DB`
- 若 `.env` 中 **未设置** `DATABASE_URL`：
  - 自动拼出 MySQL 连接串：
    - `mysql+pymysql://{user}:{password}@{host}:{port}/{db}?charset=utf8mb4`
- 若 `.env` 中 **设置了** `DATABASE_URL`：
  - 直接使用该值作为 SQLAlchemy `database_url`（当前推荐方式）

### 2.2 连接与会话：`app/db.py`

- `engine = create_engine(settings.database_url, poolclass=QueuePool, ...)`
- `SessionLocal = sessionmaker(bind=engine, ...)`
- `get_db()` 提供给 FastAPI 依赖注入

> 实际运行的 `inspect_db_schema.py` 即是通过 `app.db.engine` 连接到当前 MySQL，并遍历所有真实表结构。

### 2.3 结构检查脚本：`inspect_db_schema.py`

- 功能：
  - 输出当前 `database_url`
  - 测试连接
  - 调用 `get_db_stats()` 输出：数据库名、表数量、各表行数
  - 调用 `inspect_tables()` 输出：
    - 每张表的列名、类型、是否可空、默认值
    - 主键
    - 唯一约束
    - 索引
    - 外键
  - 专门检查：
    - `question_favorites` 是否存在
    - `plans` 是否包含 `max_favorite_questions` 列及其类型/默认值
- 兼容方言：
  - `mysql`：使用 `information_schema.tables` 与 `TABLE_ROWS`
  - `postgresql`/`postgres`：使用 `information_schema.tables` + `pg_stat_user_tables`

---

## 3. 迁移目标与总体策略

### 3.1 迁移目标

- 数据库从 MySQL 切换为 PostgreSQL
- 保持：
  - 表结构与约束在语义上等价
  - 业务行为（包括 LangGraph Agent 会话、消息存储）不变
  - 主要表数据完整迁移

### 3.2 总体策略

1. 使用 `inspect_db_schema.py` 在 MySQL 下确认最终“准生产结构”。
2. 在 PostgreSQL 中建立一个等价（而非逐字节相同）的 schema：
   - 类型映射（`BIGINT UNSIGNED` → `BIGINT` + 非负约束、`DATETIME` → `TIMESTAMP`、`JSON` → `JSONB` 等）
   - 约束与外键等价
3. 通过脚本或迁移工具，把数据从 MySQL 精确迁移到 PostgreSQL。
4. 再次在 PostgreSQL 环境下运行 `inspect_db_schema.py`，对比：
   - 表数量
   - 各表行数
   - 关键字段类型/约束
5. 在测试/预生产环境先切换并跑完所有关键功能，包括 LangGraph Agent 流程。

---

## 4. PostgreSQL 环境准备（实际落地）

### 4.1 安装与建库

- 安装 PostgreSQL 14+。
- 创建用户与数据库，例如：

```sql
CREATE USER exam_user WITH PASSWORD 'strong_password';
CREATE DATABASE exam_paper OWNER exam_user;
GRANT ALL PRIVILEGES ON DATABASE exam_paper TO exam_user;
```

### 4.2 Python 依赖（虚拟环境）

在 `backend/.venv` 中安装 PostgreSQL 驱动：

```bash
cd backend
.venv\Scripts\activate  # Windows PowerShell
# 或 source .venv/bin/activate  # macOS / Linux

pip install psycopg2-binary
```

> 若你希望固定依赖，可将 `psycopg2-binary` 手动加入 `backend/requirements.txt`，之后重建虚拟环境。

---

## 5. 通过环境变量切换到 PostgreSQL

### 5.1 设置 PostgreSQL 连接串

在 `.env` 中新增/覆盖：

```text
DATABASE_URL=postgresql+psycopg2://exam_user:strong_password@127.0.0.1:5432/exam_paper
```

- 原有的 `MYSQL_*` 保留即可，但在 `Settings` 中会被 `DATABASE_URL` 覆盖。
- 不需要改 `app/config.py` / `app/db.py` 任何代码。

### 5.2 验证连接（PostgreSQL）

激活虚拟环境后，在 `backend` 目录执行：

```bash
python inspect_db_schema.py
```

预期输出中会看到：

- `数据库连接字符串: postgresql+psycopg2://...`
- `数据库连接成功`

如果失败，则检查：

- `.env` 中 `DATABASE_URL` 拼写
- PostgreSQL 服务是否启动 / 端口是否开放
- 用户权限是否足够

---

## 6. 在 PostgreSQL 上构建等价 schema（基于实际表结构）

### 6.1 类型映射原则（从当前 MySQL 实际类型出发）

结合 `inspect_db_schema.py` 真实输出，当前各表用到的主要类型及建议映射：

- `BIGINT UNSIGNED`
  - PostgreSQL：`BIGINT`
  - 业务上绝大多数主键、外键字段都只会是非负整数，如需严格，可添加 `CHECK (id > 0)` 或在应用层保证。
- `TINYINT` / `TINYINT(1)`
  - MySQL 中部分用作布尔，如 `status` 字段；
  - PostgreSQL：
    - 布尔逻辑字段建议迁移为 `BOOLEAN`（0/1 → FALSE/TRUE）；
    - 纯枚举/状态码可迁为 `SMALLINT`。
- `DATETIME`
  - PostgreSQL：`TIMESTAMP`（可根据需要决定是否含时区 `TIMESTAMP WITH TIME ZONE`）。
- `JSON`
  - PostgreSQL：`JSONB`（性能与索引更好）。
- `ENUM(...)`
  - 例如 `subscriptions.status`、`extraction_sessions.status`、`files.source_type`；
  - 映射方案：
    - 方案 A：PostgreSQL 原生 ENUM：先 `CREATE TYPE`，再建表使用。
    - 方案 B：用 `TEXT` + CHECK 约束，例如 `CHECK (status IN ('pending','processing','done','failed'))`。

### 6.2 schema 构建方式

你有两条实际可选路线：

#### 路线 A：通过 SQLAlchemy 模型一次性 create_all

1. 在 `.env` 已指向 PostgreSQL 的前提下，写一个一次性脚本（开发环境使用）：
   - 导入 `from app.db import Base, engine`
   - 执行 `Base.metadata.create_all(bind=engine)`
2. 这会根据 `app/models.py` 当前定义在 PostgreSQL 上创建一套等价表结构。
3. 该结构与 `inspect_db_schema.py` 在 MySQL 上看到的结构在业务语义上保持一致（主键/外键/字段名等），类型依据 SQLAlchemy 声明会略有差异（如 JSON → JSONB）。

#### 路线 B：手工改写现有 schema/migrations SQL

1. 以 `db/schema.sql` + `db/migrations/*.sql` 为基础，逐条语句从 MySQL 方言改写为 PostgreSQL：
   - 删除 `ENGINE=InnoDB`、`DEFAULT CHARSET=utf8mb4` 等 MySQL 专有语法；
   - 将 `BIGINT UNSIGNED` → `BIGINT`；
   - 将 `DATETIME` → `TIMESTAMP`；
   - 将 `JSON` → `JSONB`；
   - 将 `ENUM(...)` → PostgreSQL ENUM 或 TEXT + CHECK；
   - 根据实际外键和索引名字保持一致。
2. 在 PostgreSQL 上执行改写后的脚本，得到与当前 MySQL 等价的结构。
3. 再次运行 `inspect_db_schema.py`，确认结构与 MySQL 侧的输出在表/字段/约束层面一致。

---

## 7. 数据迁移步骤（基于当前真实表集）

这里给出一个可实施的总体流程，后续可以针对每张表写具体迁移脚本。

1. **冻结/减缓 MySQL 写入**（视环境而定）
   - 保证迁移窗口内数据相对稳定，或设计增量同步机制。

2. **在 PostgreSQL 中先创建空表**
   - 通过路线 A 或路线 B 构建 schema。

3. **编写 Python 迁移脚本（双 Engine）**
   - 脚本思路：
     - 创建 MySQL Engine：`create_engine('mysql+pymysql://...')`
     - 创建 PostgreSQL Engine：`create_engine('postgresql+psycopg2://...')`
     - 按表顺序迁移：
       1. `tenants`
       2. `users` / `social_accounts`
       3. `plans` / `subscriptions`
       4. `files` / `extraction_sessions` / `extracted_items`
       5. `documents` / `questions` / 相关索引表
       6. `mindmaps` / `fulltext_blocks`
       7. `question_favorites` / `question_types` / `subjects` / `tags` / `favorite_tags`
       8. `agent_sessions` / `agent_messages`
   - 在迁移过程中根据 `inspect_db_schema.py` 输出的字段类型做精确映射：
     - 将 `TINYINT(1)` 的布尔状态字段转换为 `BOOLEAN`；
     - 将 `JSON` 列的字符串内容直接写入 PostgreSQL `JSONB` 字段；
     - 将 ENUM 值作为字符串插入 PostgreSQL ENUM 或 TEXT 字段。

4. **行数与关键约束校验**
   - MySQL 侧：运行 `inspect_db_schema.py`，记录各表行数。
   - PostgreSQL 侧：迁移完成后再次运行同一脚本，对比：
     - 表数量是否一致；
     - 关键表行数是否一致，比如：
       - `users`、`tenants`、`documents`、`questions`
       - `agent_sessions`、`agent_messages`
       - `question_favorites` 等收藏相关表。

5. **业务级验证（结合 LangGraph Agent）**
   - 在连 PostgreSQL 的环境中运行后端：
     - 打开若干已有试卷与题目，确认文档/题目数据无丢失；
     - 打开历史 Agent 会话，确认 `thread_id`、消息列表完整；
     - 新建会话、发送消息，确认 `agent_sessions`、`agent_messages` 有新记录插入且结构正确。

---

## 8. 与 LangGraph / Agent 功能的特别注意点

从实际库结构可以看到，以下表与 Agent / 大模型关联度最高：

- `agent_sessions`
  - 字段：`thread_id`、`title`、`last_message_preview`、`message_count`、`status`、`archived`、`profile_json`、`history_summary` 等
- `agent_messages`
  - 字段：`role`、`content`、`token_usage` 等
- 与题目/文档相关：`documents`、`questions`、`extracted_items`、`fulltext_blocks`、`mindmaps`

迁移这些表时需要特别保证：

- `thread_id` 完整迁移，否则 LangGraph checkpoint / 会话恢复会断链；
- `profile_json` / `graph_json` / `versions` / `legend_images` 等 JSON 字段内容不被截断或改变编码；
- 所有关联外键（如 `agent_messages.session_id → agent_sessions.id`）在 PostgreSQL 中保持同样的 ON DELETE 行为；
- 相关索引（如 `idx_agent_sessions_tenant`、`idx_agent_messages_session` 等）在 PostgreSQL 中也创建，以保证查询性能。

---

## 9. 推荐的落地步骤总结

1. 在 **当前 MySQL** 环境下：运行 `python inspect_db_schema.py`，确认和记录结构（你刚才已经执行过一次）。
2. 搭建 PostgreSQL 实例，安装 `psycopg2-binary`，在 `.env` 中配置 `DATABASE_URL`。
3. 通过 SQLAlchemy `Base.metadata.create_all` 或改写 SQL，在 PostgreSQL 上构建等价 schema。
4. 编写并执行数据迁移脚本，按依赖顺序迁移所有表数据。
5. 在 PostgreSQL 上再次运行 `inspect_db_schema.py`，对比结构和行数，确保与 MySQL 一致。
6. 在测试/预生产环境连接 PostgreSQL，跑完所有核心功能回归（上传试卷、解析、收藏、Agent 对话）。
7. 制定生产切换计划（包括 MySQL 快照、降级预案），在窗口期内完成最终切换。

---

> 后续如需，我可以在这份文档的基础上，为你单独补一份“**MySQL → PostgreSQL 数据迁移 Python 脚本**”草稿，直接按上面的真实表清单和依赖顺序实现逐表复制与校验。
