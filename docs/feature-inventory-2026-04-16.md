# 全项目功能清单（代码库扫描版）

生成时间：2026-04-16
扫描范围：`frontend/`、`backend/`、`docs/` 中与实际功能相关的代码入口、路由、服务、组件、hooks、数据模型
说明：
- 本文目标是做“功能项盘点”，不是架构方案。
- 以当前代码实现为准，尽量覆盖用户可见功能、后台处理链路、Agent Runtime 能力、基础设施能力。
- 某些功能存在“前端已露出 / 后端部分支持 / 仍在演进”的情况，也一并记录，便于后续迁移时判断保留、合并或下线。

---

## 1. 账号与身份体系

### 1.1 注册 / 登录
- 用户邮箱注册
- 注册时自动创建租户（tenant）
- 注册时自动创建管理员角色用户
- 登录校验邮箱与密码
- 支持旧密码哈希兼容校验后自动升级为 PBKDF2 哈希
- 登录 / 注册接口限流
- 注册邮箱唯一性校验
- 注册显示名可选，未填时回退为邮箱前缀

### 1.2 用户会话与前端持久化
- 前端登录态恢复
- 优先从 `sessionStorage` 恢复用户信息
- 兼容旧版 `localStorage` 中的用户信息并迁移
- 退出登录时清空本地用户态
- 顶部用户菜单展示显示名、邮箱、租户 ID

### 1.3 多租户基础隔离
- 绝大多数核心接口要求 `tenant_id`
- 工作区、文档、题目、闪卡、收藏、Agent 会话均按租户隔离
- 注册时自动分配租户 code
- 工作区 / 工作室 / 文档访问带租户和用户维度校验

---

## 2. 工作区与工作室（Workspace / Workroom）

### 2.1 Workspace 列表页
- Workspace 列表展示
- 按时间段视觉分组展示（Today / Yesterday / Older 风格）
- 搜索框 UI
- 空状态页
- 新建 Workspace 按钮
- 删除 Workspace 按钮
- 点击进入 Workspace 对应 Workroom

### 2.2 Workspace 生命周期
- 创建 Workspace
- 创建 Workspace 时一并创建 Workroom
- 打开已有 Workspace
- 删除 Workspace
- Workspace 主题（topic）字段
- Workspace 名称字段

### 2.3 Workroom 当前上下文
- 获取当前 Workroom
- 获取 Workroom 的 runtime state
- 获取 Workroom 的 source bindings
- 获取 Workroom 的 artifacts
- 从 Workspace launch 接口一次性恢复 workroom、runtime_state、sources、artifacts

### 2.4 Workroom 运行时状态持久化
- 当前激活文件 ID
- 当前激活 extraction session ID
- 当前激活 tab index
- 当前激活 studio document ID
- 当前激活 agent session ID
- 当前 center panel 状态 JSON
- 当前 right panel 状态 JSON
- 前端节流同步 runtime state 到后端
- 前端支持 pending task 合并，避免重复同步
- 刷新页面后恢复工作室界面状态

### 2.5 Workroom 数据绑定
- 将上传文件绑定到 Workroom source
- 查询 Workroom source 列表
- 按 artifact_type + artifact_ref_id 存储 Workroom artifact
- 查询单个 Workroom artifact
- 用 artifact 保存脑图面板状态等工作室衍生状态

---

## 3. 文档上传与源文件管理

### 3.1 文件上传入口
- 前端上传按钮
- 支持上传图片
- 支持上传 PDF
- 支持上传 Word (`.doc` / `.docx`)
- 文件上传时自动携带 tenant_id / user_id / workroom_id
- 上传后创建 `File`
- 上传后创建 `ExtractionSession`
- 上传后自动绑定到当前 Workroom

### 3.2 文件标签页管理
- 多文件 Tab 展示
- 新建空白占位标签页
- 关闭标签页
- 切换标签页
- 文件图标按类型显示（image / pdf / word）
- 前端还预留了 excel / powerpoint / onenote 的图标逻辑
- 横向滚动 Tab 栏
- 左侧预览面板折叠 / 展开

### 3.3 上传状态与轮询
- 上传中状态展示
- 上传后轮询 extraction session 状态
- 图片型多页 session 的逐页轮询
- 单文件 session 的统一轮询
- 处理状态：`pending / processing / ready / failed`
- 上传完成后自动更新预览 URL / 预览页数组

### 3.4 文件级元数据
- 原始文件名保存
- 存储路径保存
- MIME type 保存
- 文件大小保存
- `source_type` 保存（`image / pdf / word`）
- 文件内容哈希保存
- 预览图路径保存

### 3.5 Workroom 文件恢复
- 从 Workroom tabs 接口恢复标签页
- 从 snapshot 恢复 OCR items 到编辑器
- 根据 file_id / session_id / file_name 恢复当前文档上下文

---

## 4. 文档预览体系

### 4.1 预览面板基础能力
- 左侧源文件预览面板
- 移动端 / 平板适配下的预览折叠逻辑
- 预览区滚动容器
- 预览滚动位置记忆
- 切换 tab 后恢复每个 session 对应的 scrollTop
- 预览空状态展示
- 上传按钮悬浮在预览面板底部

### 4.2 页级预览图生成
- 图片文件直接作为预览源
- PDF 每页渲染为 PNG 预览图
- Word 先转 PDF，再渲染为页级 PNG 预览图
- 预览图按 `.page{n}.png` 命名
- 自动检测预览页数
- 会话完成后返回 `preview_pages`
- 提供 `/api/files/preview/{file_id}` 获取预览资源

### 4.3 文档处理异步化
- 上传请求不阻塞预览生成
- 预览生成由 Celery 任务异步执行
- 预览生成完成后继续触发布局解析调度
- 任务失败时会话状态标记为 failed

### 4.4 预览与引用联动
- Agent 引用定位到指定文件 / 页码
- 预览页自动滚动到被引用页面
- `pageRefs` / `imageRefs` 维护页面与图像 DOM 引用

---

## 5. 预览区框选、排除区、图例区

### 5.1 框选交互基础
- 鼠标 / 指针在预览图上拖拽框选
- 支持多页预览中的页面级定位
- 记录当前 selection box
- 把像素选区转换为后端需要的归一化 payload

### 5.2 排除区（Exclusion）
- 进入排除区模式
- 在页面上框出排除区
- 展示排除区红色覆盖层
- 删除已选排除区
- 展示 pending exclusion 的虚线框
- 构建 OCR 请求所需 `regions` 时考虑排除区

### 5.3 图例区（Legend）
- 进入图例区模式
- 在页面上框出图例区
- 展示图例区绿色覆盖层
- 删除已选图例区
- 展示 pending legend 的虚线框
- 构建 legend 提取请求所需 `legends` payload

### 5.4 框选工具栏
- 添加到编辑器按钮
- 清空选择按钮
- 排除区模式切换按钮
- 图例区模式切换按钮
- 提取中禁用部分操作

### 5.5 选择快照同步
- `SelectionPane` 向外暴露 selection snapshot
- snapshot 含 selection、pendingExclusions、pendingLegends
- snapshot 暴露 `buildRegionsPayload`
- snapshot 暴露 `buildLegendsPayload`
- snapshot 暴露 `clearSelection`
- OCR 管理器可消费该 snapshot

---

## 6. OCR 与题目抽取

### 6.1 局部 OCR
- 基于用户框选区域执行 OCR
- OCR 请求按 session_id + regions 提交
- OCR 返回多个 item
- OCR item 带 `region_index`
- OCR item 文本可进入编辑器

### 6.2 图例裁剪提取
- 基于用户框选的 legend 区域裁剪图片
- 图例图片进行预处理（按 image / pdf / word 区分）
- 裁剪结果以 data URL 返回前端
- 题目可携带 legend images 进入后续流程

### 6.3 OCR 结果聚合
- 前端维护 `ocrItems`
- OCR item 支持新增到编辑器
- OCR item 支持更新
- OCR item 支持删除
- OCR item 支持 answerText 编辑
- OCR item 支持附带来源页码、文件名、legendImages

### 6.4 OCR 结果拆题
- 对 OCR 大块文本调用 agent 接口进行拆题
- 拆题返回多个子题目
- 拆题有 `max_questions` 限制
- 拆题过程带 loading / splitting 状态

### 6.5 OCR 结果批改
- 对题目列表批量提交评分
- 输入包括题目内容、学生答案、legend 图片、页码、文件名
- 返回 judgement、predicted_answer、reasoning、confidence
- 支持 `correct / incorrect / skipped / uncertain / error`

### 6.6 GLM OCR 导入链路
- 基于 session 触发 GLM OCR import
- 根据页级预览图做 layout parsing
- 读取 `layout_details` / `md_results`
- 自动按题号切分试题
- 跳过头尾、元信息、答案区等无关内容
- 图表 / 插图 / 表格裁剪并挂到题目 `legend_images`
- 生成 `Document` 与 `Question`
- 保存 OCR 原始缓存与 layout 缓存
- 提供局部 crop 图片访问接口

---

## 7. 文档解析与知识摄取流水线

### 7.1 全文抽取
- PDF 全文抽取（PyMuPDF）
- Word 全文抽取（python-docx）
- Word 表格内容抽取
- 文本抽取结果缓存到 `FulltextBlock`
- 图片全文抽取当前为占位逻辑

### 7.2 页级布局解析
- 以预览图为输入做 page-level layout parsing
- 单页布局缓存 `FilePageLayoutCache`
- 布局解析并发租约控制
- 布局解析失败记录 error
- 布局解析完成后触发 finalize

### 7.3 Block 标准化与裁剪资产
- 标准化 block label
- 统一 bbox 归一化 / 像素坐标
- 为每个 block 生成 `crop_asset_ref`
- 按 block bbox 从页面预览图裁切局部 PNG
- 为 image / table 等视觉 block 保留裁剪资产

### 7.4 KB / Wiki ingest
状态：`已废弃（不迁移到 TS 主后端）`

- 将 source file upsert 为 KB source
- 创建 ingest job
- 读取 pages + layout blocks
- 构建 layout chunk rows
- 过滤 boilerplate 内容
- 构建 evidence nodes
- 构建 evidence edges
- 构建 retrieval units
- 文本向量 embedding
- 图片向量 embedding
- retrieval unit embedding
- 写入 evidence graph
- source status 流转（layout_scheduling / layout_queued / embedding / ready / failed）

### 7.5 KB manifest / 观测接口
状态：`已废弃（不迁移到 TS 主后端）`

- 获取文件对应 KB manifest
- 返回 source、jobs、layout pages、nodes、edges、blocks
- 用于排查摄取链路是否完成、是否失败、是否缺页

### 7.6 内容缓存体系
- `FileOcrCache`
- `FilePageLayoutCache`
- `Document.ocr_md_cache`
- `Document.ocr_layout_cache`
- `Document.long_summary_cache`
- content_hash 去重与缓存命中

---

## 8. 编辑器与题目工作台

### 8.1 编辑器工作台总体
- 中央编辑区工作台
- 能接收 OCR item 插入
- 能接收收藏题目插入
- 能切换 studio 视图：`editor / mindmap / flashcard`
- 能切换 answer mode

### 8.2 题目实体与文档管理
- 确保 / 创建 `Document`
- 文档支持绑定 file_id / session_id / workroom_id
- 编辑器对应 studio document
- 题目按 sequence_index 排序
- 题目 catalog 维护与版本更新

### 8.3 题目增删改同步
- 从 OCR / 收藏插入题目
- 替换题目内容
- 删除题目
- 同步题目到 document
- 维护题目分组、序号、展示编号
- 题目更新后刷新 catalog

### 8.4 题型与题目渲染
- 题型配置读取
- 题型新建
- 题型下拉选择
- Multiple Choice 解析与渲染
- 阅读理解题渲染
- 段落匹配题渲染
- 完形 / 填空题渲染
- 解析答案映射与序列化
- 编辑文本中剥离选择块

### 8.5 题目附属字段
- `legend_images`
- `studentAnswer`
- `canonical_answer`
- `gradingJudgement`
- `gradingPredictedAnswer`
- `gradingReasoning`
- `gradingConfidence`

### 8.6 引用与正文增强
- Markdown with Math 渲染
- 行内引用渲染
- Agent 回答中的 citation anchor 渲染
- 数学公式显示

---

## 9. 翻译功能

### 9.1 翻译查询
- `/api/translation/lookup` 查询翻译
- 词 / 短语翻译服务
- 翻译配额服务

### 9.2 编辑区翻译辅助
- TranslationToolbar
- TranslationInlineIndicator
- 自定义编辑器扩展：`TranslationBlock` / `TranslationFootnote`
- 行内翻译提示 UI

---

## 10. 收藏夹体系

### 10.1 收藏操作
- 添加题目到收藏
- 检查题目是否已收藏
- 移除收藏
- 查询收藏配额
- 获取收藏列表

### 10.2 收藏附加元信息
- 科目（subject）
- 标签（tag）
- 题型（question type）
- 自定义配置弹窗

### 10.3 收藏页
- 收藏列表页
- 从收藏中回插到编辑器
- 收藏状态按钮
- 收藏动画按钮（heart）

---

## 11. 科目 / 标签 / 题型配置

### 11.1 科目管理
- 获取科目列表
- 新建科目

### 11.2 标签管理
- 获取标签列表
- 新建标签

### 11.3 题型管理
- 获取题型列表
- 新建题型
- 题型选择字段
- 前端 `useQuestionTypeOptions` 读取与缓存

---

## 12. 导出功能

### 12.1 导出模板
- 获取 Word 导出模板列表
- 模板弹窗选择
- 当前内置 Word 模板资源

### 12.2 导出 Word
- 提交导出请求生成 Word
- 响应为文件下载
- 文件名带 URL 编码处理

---

## 13. 脑图（MindMap）

### 13.1 脑图数据源模式
- 支持 document 模式生成脑图
- 支持 file 模式生成脑图
- 支持 workroom 维度保存脑图产物
- 支持 knowledge_structure / review 等模式切换

### 13.2 脑图生成与读取
- 读取当前脑图
- 生成脑图
- 强制重新生成脑图
- 多 source 合并生成脑图
- 生成过程多阶段 loading 文案

### 13.3 脑图编辑
- 节点选中
- 节点编辑器
- 节点快速操作
- 节点上下文菜单
- 径向菜单
- 工具栏
- 画布模式切换
- 布局切换（side / left / right）
- 焦点模式
- 悬停状态
- 多选状态

### 13.4 脑图保存与恢复
- 保存脑图到后端
- Workroom artifact 恢复脑图面板状态
- 保存当前 viewState
- 恢复面板级 UI 状态

### 13.5 脑图与题目联动
- 从脑图节点跳转到题目
- 节点引用 question ref
- 以题目 / 文档为知识源生成结构树

---

## 14. 闪卡（Flashcards）

### 14.1 闪卡生成
- 为指定文档生成闪卡
- 支持 `force` 强制重生成
- 支持 `max_cards`
- 生成结束刷新卡片列表和统计
- 短文档与长文档走不同 pipeline 模式

### 14.2 闪卡列表
- 获取某文档全部闪卡
- 按 `concept_tag` 过滤
- 获取待复习闪卡
- 限制 due 列表返回数量
- 前端支持 `all / due` 模式切换

### 14.3 闪卡学习交互
- 正反面翻转 / reveal
- 上一张 / 下一张导航
- 当前卡片计数
- 自评按钮
- 自评后自动推进下一张
- 一轮完成提示

### 14.4 闪卡间隔重复调度
- 记录 review 分数 `0 / 1 / 2`
- 维护 mastery_state
- 维护 bucket
- 计算 next_review_at
- 获取 mastery stats
- 统计总数 / 未复习 / 已掌握 / 复习中 / 薄弱 / 今日到期

### 14.5 闪卡升级到 Agent
- 对单张闪卡发起 agent escalate
- 附带用户备注
- 返回提示消息

### 14.6 闪卡附带证据
- 每张卡可带 `source_ref`
- 每张卡可带 `legend_images`
- 可从题目 / chunk 派生

---

## 15. Agent Runtime（opencode 未来承接的核心边界）

### 15.1 Agent 会话管理
- 创建 / 复用 Agent session
- 获取会话列表
- 获取会话消息历史
- 重命名会话
- 归档 / 更新会话状态
- 删除会话
- 刷新后恢复历史会话
- 会话预加载首个历史消息集

### 15.2 Agent 运行方式
- 同步 `run`
- 流式 `run-stream`
- 中断后 `run-resume`
- 中断后流式 `run-resume-stream`
- 支持 `thread_id`
- 支持 `view_id`
- 支持 `studio_document_id`
- 支持 `source_file_ids`
- 支持 `note_focus`
- 支持 `agent_max_steps`

### 15.3 Agent 对话体验
- 用户消息 / 助手消息流式显示
- Thinking traces 展示
- Tool traces 展示
- Assistant optimistic rendering
- requestAnimationFrame 节流 token 更新
- 错误状态展示
- OpenUI HITL 渲染

### 15.4 Agent 中断 / 人机协作
- LangGraph interrupt
- 中断 payload 返回前端
- 需要用户澄清时中断
- resume_payload 续跑
- 支持伪工具语义的中断指令保护

### 15.5 Agent 环境建模
- 读取 workroom 当前环境状态
- 读取当前 layout 视图
- 读取当前 studio 文档
- 读取 source bindings
- 读取 artifacts
- 读取 selection / note focus
- 形成 environment state snapshot
- 世界模型（world model）记录用户输入和工具结果

### 15.6 Agent 工具集
- `list_studio_sources`
- `get_studio_resource_summary`
- `resolve_question_card_candidates`
- `read_studio_question_card`
- `gather_wiki_context`
- `read_wiki_index`
- `read_raw_evidence`

### 15.7 Agent 的 Studio 定位能力
- 统计当前工作室 question card / flashcard / OCR item / mindmap 节点数量
- 在当前 studio 文档里按题号解析候选题卡
- 精确读取单个题卡
- 读取工作室资源摘要但不泄露可答证据

### 15.8 Agent 的 Wiki / 证据能力
- 读取 wiki index
- 按 query 聚合 wiki context
- 读取 raw immutable evidence blocks
- 把 evidence 转为 citation candidates
- 生成 final answer payload
- 行内引用 `[n]` 解析与注入
- 返回 citation anchors
- 返回 `citation_status`
- 返回 `used_rag_evidence`

### 15.9 Agent 检索与治理
- retrieval query rewrite
- 多次 retrieval call 合并
- retrieval budget guard
- 证据不足时阻止直接作答
- 工具结果写入 observation memory
- 短期消息压缩
- runtime snapshot 演进

### 15.10 Agent 与编辑器联动
- `ensure-document`
- `snapshot`
- `sync-question`
- `delete-question`
- `split-questions`
- `grade`
- 从工作台内容构造 snapshot 给 agent 使用
- Agent 产出的 AG-UI 事件回灌前端编辑器

---

## 16. Wiki / 知识对象 / 检索层

### 16.1 Wiki 编译与页面体系
- Wiki compile service
- Wiki 页面索引
- 内容导向 index
- 绑定 raw evidence truth layer

### 16.2 Evidence Graph
- evidence nodes
- evidence edges
- retrieval units
- lexical terms / search_text
- semantic grouping
- page-level policy
- 图像证据节点

### 16.3 检索服务
- Evidence retrieval service
- 向量检索
- 图片向量 / 文本向量混合检索
- 基于 source_file_ids 的作用域过滤
- query 与 object refs 的组合读取

### 16.4 引用对象
- citation anchor from unit
- citation anchor from chunk
- citation anchor from evidence node
- citation 去重
- 引用锚点携带 `file_id / page_no / unit_key / asset_ref / bbox`

---

## 17. 前端基础能力

### 17.1 路由与导航
- `/workspaces`
- `/workspaces/:id`
- 路径解析与构造
- 打开 Workspace 时更新地址栏
- 404 / 网络错误的 Workroom 加载错误态

### 17.2 全局状态管理
- 用户信息
- workroom
- runtime state
- sources
- artifacts
- fileTabs
- activeTabIndex
- preview scroll positions
- conversations
- conversationMessages
- activeConversationKey

### 17.3 多语言
- 中英文资源包
- 浏览器语言探测
- localStorage 缓存当前 UI 语言
- LanguageSelector 切换语言

### 17.4 视觉 / 交互基础
- Toast 提示
- 动画按钮
- 品牌图标
- 机器人发光头像
- 金属风输入框
- 无滚动条样式
- 响应式预览面板
- 折叠侧边栏 icon rail

### 17.5 工具函数层
- 表单校验
- 防抖
- 并发控制
- 速率限制器
- LRU 缓存
- 数学辅助工具
- workroom restore
- secure storage

---

## 18. 后端基础设施与系统能力

### 18.1 HTTP 服务基础（现为 Bun 实现）
- `/health` 健康检查
- CORS 配置
- Request body size 限制中间件
- UTF-8 日志输出

### 18.2 Celery / 异步任务
- 后端启动自动拉起 Celery worker
- 后端关闭自动终止 Celery worker
- 预览生成队列
- GLM layout 队列
- embed 队列
- ingest / materialize / finalize / parse layout 等任务

### 18.3 限流与保护
- auth-register 限流
- auth-login 限流
- agent-run / stream / resume / grade / split / snapshot / sync 限流
- 翻译 / 其他服务可扩展限流

### 18.4 资源与资产处理
- AssetResolver
- 本地路径 / data_url / http_url 解析
- 图片尺寸读取
- 局部裁剪资产保存

### 18.5 模型与外部服务接入
- Qwen client
- GLM OCR / layout parsing
- Bailian file service
- embedding service
- translation service
- 未来可替换为 TS 主后端下的新 provider adapter

---

## 19. 数据模型与持久化对象

### 19.1 用户与租户
- Tenant
- User
- Plan
- Subscription

### 19.2 文档与抽取
- File
- ExtractionSession
- ExtractedItem
- FulltextBlock
- FileOcrCache
- FilePageLayoutCache
- Document
- Question
- QuestionCatalog
- QuestionVersion / QuestionState 相关迁移

### 19.3 工作区 / 工作室
- Workspace
- Workroom
- WorkroomRuntimeState
- WorkroomSourceBinding
- WorkroomArtifact

### 19.4 学习产物
- MindMap 相关表
- FlashcardConcept
- FlashcardReview
- FlashcardGenerationJob
- 收藏相关表

### 19.5 Agent 持久化
- AgentSession
- AgentMessage
- agent message metadata
- session meta

### 19.6 KB / RAG 层
状态：`已废弃（不迁移到 TS 主后端）`

- kb_sources
- kb_ingest_jobs
- kb_evidence_nodes
- kb_retrieval_units
- observability tables
- lexical terms / trigram 索引 / semantic groups

---

## 20. 已暴露但需迁移时特别注意的功能边界

### 20.1 明确属于 Agent Runtime 的功能
- Agent 会话管理
- Agent 流式对话
- Agent 中断与恢复
- Agent 工具调用协议
- Agent 对 wiki / studio / evidence 的读取能力
- Agent 引用与 final answer payload 组装

### 20.2 不属于 Agent Runtime、但当前业务强依赖的功能
- 文件上传
- 文档页级预览图生成
- Word 转 PDF / 转页图
- OCR / GLM OCR
- 图例裁剪
- 题目导入与编辑器同步
- 脑图生成与编辑
- 闪卡生成与复习调度
- 收藏、翻译、导出
- Workspace / Workroom 状态持久化
- 旧 KB ingest / evidence graph / embeddings
  说明：该向量知识库路线已标记废弃，不再纳入 TS 主后端迁移目标

### 20.3 迁移时不能漏掉的“前端基础能力”
- 登录态恢复
- i18n
- Tab 管理
- 预览滚动位置恢复
- 引用跳页
- 选择框 / 排除区 / 图例区
- Toast / loading / 错误态
- Workroom runtime state 节流同步
- 会话历史恢复

---

## 21. 用于 TS 迁移拆包的建议清单视角

后续迁移时可把上面功能按以下包进行勾选追踪：
- `auth-and-tenant`
- `workspace-and-workroom`
- `source-upload-and-preview`
- `selection-and-ocr`
- `document-pipeline`
- `editor-and-questions`
- `translation`
- `favorites`
- `export`
- `mindmap`
- `flashcards`
- `wiki-and-kb`
- `agent-runtime`
- `frontend-foundation`
- `backend-infra`

---

## 22. 一句话结论

当前项目不是“上传文件 + 一个 Agent”这么简单，而是已经形成了：`认证/租户 + Workspace/Workroom + 文档预览与视觉解析 + 编辑器题目工作台 + 脑图 + 闪卡 + 收藏/翻译/导出 + Wiki/KB + Agent Runtime` 的完整产品骨架。后续迁移到 TS 主后端时，`opencode` 只应承接其中的 `agent-runtime` 边界，其余能力需要分别迁移或重构。
