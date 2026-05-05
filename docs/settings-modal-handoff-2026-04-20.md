# 设置模态框交接

## 当前状态

当前设置中心已经从“AI-only 弹窗”收敛成统一产品设置模态框，入口在头像菜单的“设置”按钮。左侧是分区导航，右侧内容区当前真正落地的主要是 `账号` 和 `AI 设置`，其中 `AI 设置` 负责管理 provider 账号池、默认模型和 capability 绑定。

当前 UI 已按用户提供的参考稿重做了主体结构，并做了两轮明显调整：

- 左侧菜单项已居中
- 选中项右侧的蓝色短条已移除
- 设置模态框左右两个滚动容器已隐藏滚动条

## 后端能力现状

模型设置后端已经不是占位实现，真实路径如下：

- `GET /api/model-settings`
- `PUT /api/model-settings`
- `GET /api/model-settings/catalog`
- `GET /api/model-settings/resolve`

后端支持的 provider 当前收口为四个：

- `智谱`
- `阿里云百炼`
- `硅基流动`
- `ModelScope`

当前 OCR 适配已经按真实协议拆开：

- `智谱` 走原生 OCR/layout 解析
- `阿里云百炼`、`硅基流动`、`ModelScope` 走 OpenAI compatible 多模态 OCR

最近一次真实联调结果显示，这四个平台都已能跑通同一张本地预览图上的 OCR 调用。

## 历史上下文

这条线最早的问题不是 UI，而是整条架构边界反复偏航。用户已经明确锁定的要求包括：

- `backend` 是唯一主后端
- `opencode` 只能作为 `backend` 内部 runtime 并入
- 不允许把 `opencode` 做成独立服务、子进程、CLI 或 Web 产品
- 前端只调项目自己的 `/api/*`
- 不能用自定义 runtime skeleton 冒充并入结果

在这些约束下，后续工作又分成了几条主线：

1. 账号与登录迁移
   - PostgreSQL 作为账号真源
   - 本地 SQLite 只保存 session 和业务状态

2. workroom 与文档恢复
   - 重开应用后恢复文档、标签、上下文、agent 会话索引

3. OCR 与题卡链路
   - 框选 OCR、全文 OCR、题卡拆分、批改、闪卡、脑图都逐步接入统一能力解析

4. 设置中心重构
   - 从“AI 设置页”收敛成整个产品的设置模态框
   - 再按用户给的参考稿重做视觉和信息架构

## 关键文件

- [AIModelSettingsDialog.tsx](/D:/Exam-paper/frontend/src/components/AIModelSettingsDialog.tsx)
- [style.css](/D:/Exam-paper/frontend/src/style.css)
- [model-settings resolver](/D:/Exam-paper/backend/src/domains/model-settings/resolver.ts)
- [ocr provider client](/D:/Exam-paper/backend/src/domains/ocr/provider-client.ts)
- [studio OCR service](/D:/Exam-paper/backend/src/domains/studio/ocr-service.ts)
- [document pipeline service](/D:/Exam-paper/backend/src/domains/documents/pipeline/service.ts)
- [OCR provider verification script](/D:/Exam-paper/backend/scripts/verify-ocr-providers.ts)

## 未收口项

- 设置模态框里仍有部分分区是产品壳层，后续如果用户继续要求，可以继续裁掉不必要菜单。
- OCR 对阿里、硅基、ModelScope 目前是“可用的通用多模态实现”，不是完全原生结构化布局解析。
- 当前 provider catalog 仍不维护模型下拉列表，模型 ID 由用户手填。

## 备注

这份交接文档记录的是当前上下文和历史上下文里已经做过的工作，不是最终设计说明。后续如果继续改设置中心或模型配置，先对照这里的边界，不要再把内部实现语义泄漏到用户可见区。
