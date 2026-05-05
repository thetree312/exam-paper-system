# Agent Provider Adapter Handoff 2026-05-02

## 背景

当前 agent runtime 已经完成两条关键收敛：

1. `models.dev` 已本地化，不再依赖在线 `https://models.dev/api.json`
2. `alibaba-cn` 已从 `@ai-sdk/openai-compatible` 切到 `@ai-sdk/alibaba`，并且用户已验证缓存创建与缓存命中确实开始生效

这说明当前问题已经从“本地化模型目录”转移到了“各平台应该各自走什么 adapter”。

下一阶段的核心任务，不再是继续解释 UI、也不是继续兜底，而是明确每个 provider 的 runtime adapter 策略，并验证缓存、usage、cost、reasoning、tool calling 这些能力是否和该 adapter 匹配。

## 当前已经确认的事实

### 1. 本地 `models.dev` 是当前 runtime 真值源

- 官方源目录：`backend/vendor/models.dev`
- 运行时产物：`backend/vendor/models.dev/dist/_api.json`
- backend 启动时默认使用：
  - `OPENCODE_MODELS_PATH=backend/vendor/models.dev/dist/_api.json`
  - `OPENCODE_DISABLE_MODELS_FETCH=1`

这条链已经落地，运行时不再依赖在线 `models.dev`。

参考文件：
- [agent-models-dev-localization.md](/d:/Exam-paper/docs/agent-models-dev-localization.md)
- [build-local-models-catalog.ts](/d:/Exam-paper/backend/scripts/build-local-models-catalog.ts)
- [service.ts](/d:/Exam-paper/backend/src/domains/agent/service.ts)

### 2. 前端模型设置面板不再是 runtime 元数据真值源

前端模型设置面板只负责：

- provider
- base URL
- API key
- 模型列表

runtime 的真正 adapter、默认 API、模型能力、limit、cost、reasoning、tool_call、attachment 等，统一来自本地化后的 `models.dev` catalog。

参考文件：
- [catalog.ts](/d:/Exam-paper/backend/src/domains/model-settings/catalog.ts)
- [resolver.ts](/d:/Exam-paper/backend/src/domains/model-settings/resolver.ts)
- [model-settings.ts](/d:/Exam-paper/backend/src/routes/model-settings.ts)
- [AIModelSettingsDialog.tsx](/d:/Exam-paper/frontend/src/components/AIModelSettingsDialog.tsx)

### 3. `alibaba-cn` 缓存问题的根因已经确认

之前 `alibaba-cn` 虽然填的是阿里百炼官方 URL 和 key，但 runtime 实际走的是：

- `@ai-sdk/openai-compatible`

这导致：

1. `opencode` 不会走 Alibaba 专用的 `applyCaching()` 分支
2. 不一定能触发阿里侧真正的 prompt cache 创建
3. 即使 provider 侧做了缓存，也不一定会把 cached token usage 以 `opencode` 能识别的方式回传

这不是前端问题，也不是用户配置错误，而是 adapter 语义不对。

### 4. `alibaba-cn` 已经切到 `@ai-sdk/alibaba`

当前本地 catalog 生成链里，已经在生成前强制把：

- `alibaba`
- `alibaba-cn`

改成：

- `npm = "@ai-sdk/alibaba"`

同时移除了 provider TOML 里的 `api = ...`，因为 `models.dev` schema 不允许在该 adapter 下继续保留 `api` 字段。

为保持默认百炼地址，catalog 读取层现在通过 fallback 显式提供：

- `alibaba-cn -> https://dashscope.aliyuncs.com/compatible-mode/v1`
- `alibaba -> https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

参考文件：
- [build-local-models-catalog.ts](/d:/Exam-paper/backend/scripts/build-local-models-catalog.ts)
- [catalog.ts](/d:/Exam-paper/backend/src/domains/model-settings/catalog.ts)

### 5. 用户已验证阿里缓存真实生效

这不是静态推断，而是运行时已被用户验证：

- 显式缓存创建 Token 总数非 0
- 显式缓存命中 Token 总数非 0

这说明：

1. 当前切到 `@ai-sdk/alibaba` 的方向正确
2. “adapter 选对，缓存链才真正工作”这个判断成立

## 当前系统性问题

`alibaba-cn` 的问题已经暴露出一个系统性事实：

> 平台 URL 和 key 正确，不等于 runtime adapter 语义正确。

当前真正的问题不是“前端有没有填对 base URL”，而是：

- 本地 `models.dev` catalog 里每个平台被定义成什么 adapter
- runtime 是否忠实使用这个 adapter
- 这个 adapter 是否能完整承载该平台的缓存、usage、cost、reasoning、tool_call、多模态等能力

因此，接下来必须把问题收束到：

## 各平台 adapter 策略

而不是继续围绕单个平台打补丁。

## 当前 catalog 中需要重点关注的平台

根据当前 vendored catalog，国内相关 provider 大致分成三类：

### A. 已确认有 first-class adapter

- `alibaba`
- `alibaba-cn`
- `minimax`
- `minimax-cn`

当前情况：

- `alibaba*` 已转到 `@ai-sdk/alibaba`
- `minimax*` 当前 catalog 本来就是 `@ai-sdk/anthropic`

下一步：

- 验证 `minimax-cn` 是否已经具备可用的 cache / usage / cost 行为

### B. 当前仍走 `@ai-sdk/openai-compatible`

当前需要重点审计：

- `zhipu`
- `zhipuai`
- `modelscope`
- `siliconflow`
- `deepseek`
- `moonshotai`
- `moonshotai-cn`
- `302ai`
- `zai`
- `tencent-tokenhub`
- `tencent-coding-plan`

这类 provider 当前默认策略是：

- 先跑通
- 先兼容

但不能默认认为：

- 缓存一定可创建
- usage 一定可统计
- reasoning 一定被正确映射
- tool calling / multimodal 一定没有差异

### C. 当前 catalog 中还没有用户直觉中的统一 provider

例如：

- 腾讯混元通用入口
- 百度文心通用入口
- 火山引擎 / 豆包通用入口

对这些平台，后续如果要接，需要先决定：

1. 在本地 `models.dev` vendor 中如何定义 provider
2. 是 first-class adapter 还是 `openai-compatible`
3. 默认 API / env / 文档 / 模型列表如何建模

## 下一阶段要解决的问题

下一阶段不是继续“补一个平台”，而是做一份正式的 provider adapter 策略清单。

至少要回答下面这些问题：

### 1. 每个平台最终走什么 adapter

对每个 provider 明确：

- `providerID`
- 当前 `adapterNpm`
- 是否保留
- 是否调整
- 调整原因

### 2. 每个平台的缓存预期是什么

对每个 provider 明确：

- 是否应该支持 prompt cache
- 是否应该能看到 cache creation / cache hit usage
- `opencode` 里是否应当能统计 `cache.read / cache.write`
- 如果当前 adapter 不能提供，是否接受这一限制

### 3. 每个平台还要验证哪些 runtime 能力

至少验证：

- cost 统计
- cache token 统计
- reasoning 参数映射
- tool calling
- attachment / multimodal

### 4. 前端是否需要对 adapter 结果继续做显式提示

原则已经明确：

- 前端不配置 adapter
- adapter 由 catalog 决定

但仍需考虑：

- 是否要在平台卡片级别展示“官方 adapter / openai-compatible”状态
- 是否要把“当前平台是兼容路径，因此缓存/统计可能受限”以只读方式提供给用户

这一步要谨慎，不要再把只读运行时信息做成像可编辑配置一样的 UI。

## 推荐的下一步执行顺序

### Step 1. 产出一份 provider adapter 策略表

当前已落地文档：

- [provider-adapter-strategy-2026-05-02.md](/d:/Exam-paper/docs/provider-adapter-strategy-2026-05-02.md)

建议文档或结构至少包含：

- `providerID`
- `displayName`
- `currentAdapterNpm`
- `currentAdapterKind`
- `currentBaseURL`
- `cacheExpectation`
- `reasoningExpectation`
- `toolCallingExpectation`
- `costStatisticsExpectation`
- `decision`
- `notes`

### Step 2. 逐个平台做最小验证

优先顺序建议：

1. `minimax-cn`
2. `zhipu`
3. `modelscope`
4. `siliconflow`
5. `deepseek`
6. `moonshotai-cn`

验证目标不是“平台能否调用”，而是：

- 当前 adapter 下，平台能力与 `opencode` 的统计/缓存/能力映射是否一致

### Step 3. 只在必要时偏离官方 catalog

原则已经调整为：

- 官方 catalog 有 first-class adapter 的，优先按官方
- 官方 catalog 没有 first-class adapter 的，先允许 `openai-compatible`
- 只有当业务价值明确，且当前 adapter 的 cache/usage/统计确实不足时，才为特定平台做定向增强

`alibaba-cn` 已经证明这类偏离是有价值的，但不应无差别扩散到所有平台。

## 本轮关键改动点

后续会话若要继续追踪，请先看这些文件：

- [backend/scripts/build-local-models-catalog.ts](/d:/Exam-paper/backend/scripts/build-local-models-catalog.ts)
- [backend/src/domains/model-settings/catalog.ts](/d:/Exam-paper/backend/src/domains/model-settings/catalog.ts)
- [backend/src/domains/model-settings/resolver.ts](/d:/Exam-paper/backend/src/domains/model-settings/resolver.ts)
- [backend/src/routes/model-settings.ts](/d:/Exam-paper/backend/src/routes/model-settings.ts)
- [backend/src/domains/agent/service.ts](/d:/Exam-paper/backend/src/domains/agent/service.ts)
- [frontend/src/components/AIModelSettingsDialog.tsx](/d:/Exam-paper/frontend/src/components/AIModelSettingsDialog.tsx)
- [frontend/src/types.ts](/d:/Exam-paper/frontend/src/types.ts)

## 本轮已经完成的验证

- backend 本地模型目录改造已落地
- backend 启动不再依赖在线 `models.dev`
- `alibaba-cn` 已经切到 `@ai-sdk/alibaba`
- 用户已验证阿里缓存创建与缓存命中真实生效
- `npm --prefix backend run typecheck` 在相关改动后通过

## 交接结论

当前工作已经证明：

1. 本地化 `models.dev` 是正确方向
2. adapter 决定了缓存链是否真正能工作
3. 现在真正需要继续推进的，不是继续解释 UI，也不是继续补 catalog 文案，而是：

> 为每个国内 provider 明确 runtime adapter 策略，并逐个平台验证缓存、usage、cost 与能力映射是否匹配。

下一会话接手时，不要再从“为什么阿里没有缓存”重新开始。  
这个问题已经解决。  
新的主问题是：

> 哪些平台继续走 `openai-compatible`，哪些平台需要 first-class adapter，以及每个平台在当前 adapter 下的能力边界是什么。
