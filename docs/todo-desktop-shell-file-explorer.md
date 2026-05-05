# TODO: 桌面壳层接入文件资源管理器打开能力

当前 `POST /api/workrooms/:workroomID/fs/reveal-in-os` 仅为占位接口，返回：

```json
{ "supported": false, "reason": "web_runtime_unsupported" }
```

后续在 Electron / Tauri 桌面壳层接入后，需要由后端桥接系统能力，实现：

1. 定位到目标文件并在系统文件资源管理器中显示。
2. 失败时返回可诊断错误码（权限、路径不存在、平台不支持）。
3. 保持 workroom 边界校验，禁止越界路径。
