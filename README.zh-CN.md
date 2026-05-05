# 试卷系统

基于 Bun 后端与 React 前端的试卷处理系统，包含 OCR、题目处理与 Agent 辅助能力。

## 运行环境
- 后端：Bun >= 1.3
- 前端：Node.js >= 18

## 快速开始

1. 安装后端依赖
```bash
cd backend
bun install
```

2. 启动后端
```bash
bun run dev
```
后端 API 基地址：`http://localhost:3000/api/*`

3. 启动前端
```bash
cd frontend
npm install
npm run dev
```

## 项目结构

```text
exam-paper-system/
|- backend/
|  |- src/                 # Bun 后端源码
|  |- scripts/             # 校验与维护脚本
|  |- tests/               # Bun 测试集 (*.test.ts)
|  |- package.json
|  `- README.md
|- frontend/
|  |- src/
|  `- package.json
|- docs/
|- README.md
`- README.zh-CN.md
```

## 后端命令

在 `backend/` 目录执行：
- `bun run dev` 监听模式
- `bun run start` 单次启动
- `bun run test` Bun 测试
- `bun run typecheck` TypeScript 类型检查
- `bun run verify:runtime-boundary`
- `bun run verify:backend-migration-slice`
- `bun run verify:studio-selection-ocr`
- `bun run verify:learning-artifact-generation`
- `bun run verify:ocr-providers`

## 测试

```bash
cd backend
bun run test
bun run typecheck
```

```bash
cd frontend
npm test
```

## 说明
- Python/FastAPI 后端链路已删除，不再支持。
- 前端仅应调用项目自有 `/api/*` 接口。
