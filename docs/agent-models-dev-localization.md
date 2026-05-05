# Agent `models.dev` 本地化

本仓库的 agent runtime 不再依赖在线 `https://models.dev/api.json`。

## 真值来源

- 官方源：`backend/vendor/models.dev`
- 运行时产物：`backend/vendor/models.dev/dist/_api.json`

`backend/local-data/agent/xdg/cache/opencode/models.json` 只保留为 opencode 运行时 cache，不作为维护源。

## 生成方式

在 `backend/` 下执行：

```bash
bun run models:build
```

这条命令会：

1. 确保 `backend/vendor/models.dev` 的依赖已安装
2. 直接调用官方 `packages/core/src/generate.ts`
3. 生成：
   - `backend/vendor/models.dev/dist/_api.json`
   - `backend/vendor/models.dev/dist/api.json`

## 运行时行为

backend 启动时默认设置：

- `OPENCODE_MODELS_PATH=backend/vendor/models.dev/dist/_api.json`
- `OPENCODE_DISABLE_MODELS_FETCH=1`

如果本地产物缺失，agent runtime 会直接报错，而不是退回在线拉取。

## 更新纪律

后续更新只允许两类改动：

1. 跟随上游 `models.dev` 更新 vendor 源
2. 在 vendor 源的官方 TOML 结构内补充项目必须的 provider/model

不要再维护第二套 catalog，不要把前端模型面板当成 runtime 元数据源。

## 当前本地补充

- `providers/zhipu/`

这是为了对齐项目现有 `providerID = "zhipu"` 的存量配置。  
`bun run models:build` 会在生成前根据 `zhipuai/models` 自动同步这组 alias，仍然使用官方 TOML 结构和 `extends` 机制，不在 runtime 内做名称桥接。

## Windows 兼容说明

官方 `models.dev` 源里包含一部分符号链接和带 `:` 的模型文件名。  
在 Windows 压缩包落地后，这些内容会失真：

- 符号链接会变成“仅包含相对路径文本”的 TOML 文件
- 带 `:` 的文件名会落成 `_`

`bun run models:build` 会先把这些 Windows 特有失真修复掉，再调用官方生成器输出最终 `_api.json`。
