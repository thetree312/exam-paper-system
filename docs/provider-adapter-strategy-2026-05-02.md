# Provider Adapter Strategy 2026-05-02

## 目标

这份文档用于承接 [agent-provider-adapter-handoff-2026-05-02.md](/d:/Exam-paper/docs/agent-provider-adapter-handoff-2026-05-02.md) 的 Step 1，把当前本地 `models.dev` catalog 中重点 provider 的 adapter 现状、能力预期、暂定决策和后续验证顺序固定下来。

这份文档只回答四件事：

1. 当前每个 provider 实际走什么 adapter
2. catalog 当前显式建模了哪些能力元数据
3. 现阶段应保留还是调整该 adapter
4. 下一轮最小验证应该验证什么

## 依据

本轮判断仅基于以下真实来源：

- [build-local-models-catalog.ts](/d:/Exam-paper/backend/scripts/build-local-models-catalog.ts)
- [catalog.ts](/d:/Exam-paper/backend/src/domains/model-settings/catalog.ts)
- [resolver.ts](/d:/Exam-paper/backend/src/domains/model-settings/resolver.ts)
- [service.ts](/d:/Exam-paper/backend/src/domains/agent/service.ts)
- [schema.ts](/d:/Exam-paper/backend/vendor/models.dev/packages/core/src/schema.ts)
- `backend/vendor/models.dev/dist/_api.json`

注意：

- `adapterKind = official` 在当前代码里是“非 `@ai-sdk/openai-compatible`”的统称，不等于“每个平台都有独立 first-class SDK”。
- `@ai-sdk/anthropic` 路径也会被当前代码归入 `official`，因此需要单独标注。
- 以下 `cacheExpectation` 分成两层：
  - `catalog-metadata`：本地 catalog 是否已经显式存在 `cost.cache_read` / `cost.cache_write`
  - `runtime-behavior`：当前 adapter 路径下，是否应期待 `opencode` 能稳定拿到真实缓存 usage

## 当前策略表

| providerID | currentAdapterNpm | currentAdapterKind | currentBaseURL | catalogMetadata | decision | notes |
| --- | --- | --- | --- | --- | --- | --- |
| `alibaba` | `@ai-sdk/alibaba` | `official` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | 47 models, priced 47, reasoning 22, tool 42, cache_read 1, cache_write 1 | `keep` | 已切到 Alibaba 官方 adapter，继续作为对照组验证 usage/cost/cache。 |
| `alibaba-cn` | `@ai-sdk/alibaba` | `official` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 80 models, priced 80, reasoning 41, tool 75, cache_read 7, cache_write 2 | `keep` | 用户已验证真实 cache create / hit 生效，当前是已确认正确路径。 |
| `minimax` | `@ai-sdk/anthropic` | `official` | `https://api.minimax.io/anthropic/v1` | 6 models, priced 6, reasoning 6, tool 6, cache_read 4, cache_write 4 | `keep_and_verify` | 不是 MiniMax 专有 SDK，而是 Anthropic 语义路径；先验证 cache/usage 是否能闭环。 |
| `minimax-cn` | `@ai-sdk/anthropic` | `official` | `https://api.minimaxi.com/anthropic/v1` | 6 models, priced 6, reasoning 6, tool 6, cache_read 4, cache_write 4 | `keep_and_verify` | 当前优先级最高的下一验证对象。 |
| `zhipu` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://open.bigmodel.cn/api/paas/v4` | 12 models, priced 12, reasoning 12, tool 12, attachment 3, cache_read 10, cache_write 10 | `keep_for_now_high_audit` | catalog 宣称缓存与推理能力较完整，但 runtime 仍走兼容层，必须验证 usage 回传是否真实可用。 |
| `zhipuai` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://open.bigmodel.cn/api/paas/v4` | 12 models, priced 12, reasoning 12, tool 12, attachment 3, cache_read 10, cache_write 10 | `keep_alias_with_zhipu` | 与 `zhipu` 本质同源，验证时应视为同一平台，避免重复结论。 |
| `zai` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api.z.ai/api/paas/v4` | 13 models, priced 13, reasoning 13, tool 13, attachment 3, cache_read 11, cache_write 11 | `keep_for_now_high_audit` | 能力画像与智谱系接近，但域名和平台品牌不同，需要单独验证缓存 usage 与推理字段映射。 |
| `modelscope` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api-inference.modelscope.cn/v1` | 7 models, priced 7, reasoning 4, tool 7, cache_read 0, cache_write 0 | `keep_for_now` | 先接受无缓存元数据，不把 prompt cache 作为默认预期；重点看 tool calling、多模型能力映射、cost。 |
| `siliconflow` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api.siliconflow.com/v1` | 74 models, priced 74, reasoning 30, tool 74, attachment 18, cache_read 1, cache_write 2 | `keep_for_now_high_audit` | 大量模型经由统一兼容入口暴露，能力跨度大，需重点验证多模态、tool、cache usage 是否稳定。 |
| `deepseek` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api.deepseek.com` | 4 models, priced 4, reasoning 3, tool 4, attachment 2, cache_read 4, cache_write 0 | `keep_for_now` | 当前可先接受只有 `cache_read` 元数据；重点确认 reasoning 参数与 usage 统计。 |
| `moonshotai` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api.moonshot.ai/v1` | 7 models, priced 7, reasoning 4, tool 7, attachment 1, cache_read 7, cache_write 0 | `keep_for_now` | 优先级低于 `moonshotai-cn`，先不改 adapter，等待最小验证结果。 |
| `moonshotai-cn` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api.moonshot.cn/v1` | 7 models, priced 7, reasoning 4, tool 7, attachment 1, cache_read 7, cache_write 0 | `keep_for_now_verify` | 下一轮验证队列中靠前，重点确认缓存 usage 是否只有读没有写。 |
| `302ai` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api.302.ai/v1` | 97 models, priced 97, reasoning 52, tool 92, attachment 66, cache_read 3, cache_write 3 | `keep_but_deprioritize` | 聚合平台能力差异大，不适合先追求严格语义一致；先允许兼容路径，后续再看是否值得单独增强。 |
| `tencent-tokenhub` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://tokenhub.tencentmaas.com/v1` | 1 model, priced 1, reasoning 1, tool 1, cache_read 1, cache_write 1 | `keep_for_now_verify` | 体量小，适合作为腾讯系最小样本，先验证 usage/cost 是否能被 runtime 稳定识别。 |
| `tencent-coding-plan` | `@ai-sdk/openai-compatible` | `openai_compatible` | `https://api.lkeap.cloud.tencent.com/coding/v3` | 8 models, priced 8, reasoning 5, tool 8, attachment 1, cache_read 8, cache_write 8 | `keep_for_now_verify` | catalog 能力声明很满，但仍是兼容层；必须确认 reasoning、tool、缓存统计不是“目录里有，运行时拿不到”。 |

## 决策原则

当前暂定按以下原则推进，不做无依据的大范围改 adapter：

1. `models.dev` 已有非 `openai-compatible` adapter 的，先保留，并优先验证其 runtime 语义是否闭环。
2. 当前仍是 `openai-compatible` 的 provider，默认先保留，不因为 catalog 元数据看起来丰富就直接改 adapter。
3. 只有当某 provider 已明确出现“平台支持，但兼容 adapter 让 cache/usage/reasoning/tool 映射失真”的证据，才考虑做定向 adapter 偏离。
4. alias provider 共享同一上游时，验证结论尽量合并，避免重复劳动。

## 各类 provider 的缓存预期

### A. 已确认或应高预期缓存闭环

- `alibaba`
- `alibaba-cn`
- `minimax`
- `minimax-cn`

说明：

- 这组 provider 当前不走 `openai-compatible`。
- 除 `alibaba-cn` 外，其余还没有实测结论。
- 这组平台应该优先验证 `cache.write` / `cache.read` usage 是否能被 runtime 稳定拿到。

### B. catalog 声明有缓存元数据，但 runtime 仍需审计

- `zhipu`
- `zhipuai`
- `zai`
- `siliconflow`
- `deepseek`
- `moonshotai`
- `moonshotai-cn`
- `tencent-tokenhub`
- `tencent-coding-plan`

说明：

- 这些 provider 在目录里已经带有部分或完整 `cache_*` 成本元数据。
- 这不等于当前 adapter 一定能把真实缓存 usage 回传给 `opencode`。
- 这组平台是后续审计重点。

### C. 当前不把缓存作为默认目标

- `modelscope`
- `302ai`

说明：

- `modelscope` 当前 catalog 没有 `cache_*` 元数据。
- `302ai` 是聚合入口，能力一致性天然较弱。
- 这两类平台先以“调用、cost、tool、reasoning 映射可用”为目标，不把 prompt cache 闭环作为首要验收条件。

## 下一轮最小验证清单

按当前信息密度和业务价值，推荐顺序调整为：

1. `minimax-cn`
2. `zhipu`
3. `siliconflow`
4. `moonshotai-cn`
5. `tencent-coding-plan`
6. `modelscope`

每个平台统一验证以下五项：

1. 请求是否确实通过 catalog 指定 adapter 发出，而不是被其他配置绕回兼容路径。
2. usage 中是否能稳定拿到输入、输出、缓存读、缓存写相关统计。
3. reasoning 模型是否需要额外 provider body/field 才能正确输出推理内容。
4. tool calling 在当前 adapter 下是否能被 `opencode` 原生链路正确识别。
5. 多模态或附件能力是否只是目录声明，还是 runtime 真能走通。

## 暂不做的事

当前阶段不建议直接做以下动作：

1. 不因为某平台“看起来像 OpenAI 接口”就先手写新 adapter。
2. 不把前端模型设置面板重新做成 adapter 配置面板。
3. 不把 catalog 的能力元数据直接当成 runtime 已验证事实。
4. 不为尚未验证的平台提前补 UI 文案或能力承诺。

## 结论

当前可以正式把 provider adapter 问题拆成两层：

1. catalog 事实层：每个平台现在被定义成什么 adapter，目录里声明了哪些能力
2. runtime 验证层：这些能力在 `opencode` 当前 adapter 路径下是否真的可用

现阶段结论不是“把更多 provider 改成 first-class adapter”，而是：

- 先保留现有 adapter 布局
- 用最小验证找出真正失真的平台
- 只对已证明兼容层语义不够的平台做定向增强
