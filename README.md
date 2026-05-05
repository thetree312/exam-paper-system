# Exam Paper System

Bun-only backend + React frontend for exam-paper workflows (OCR, question processing, and agent-assisted operations).

## Runtime
- Backend: Bun >= 1.3
- Frontend: Node.js >= 18

## Quick Start

1. Install backend deps
```bash
cd backend
bun install
```

2. Start backend
```bash
bun run dev
```
Backend API base: `http://localhost:3000/api/*`

3. Start frontend
```bash
cd frontend
npm install
npm run dev
```

## Project Structure

```text
exam-paper-system/
|- backend/
|  |- src/                 # Bun backend source
|  |- scripts/             # verification and maintenance scripts
|  |- tests/               # Bun test suite (*.test.ts)
|  |- package.json
|  `- README.md
|- frontend/
|  |- src/
|  `- package.json
|- docs/
|- README.md
`- README.zh-CN.md
```

## Backend Commands

Run inside `backend/`:
- `bun run dev` watch mode
- `bun run start` single-run start
- `bun run test` Bun tests
- `bun run typecheck` TypeScript check
- `bun run verify:runtime-boundary`
- `bun run verify:backend-migration-slice`
- `bun run verify:studio-selection-ocr`
- `bun run verify:learning-artifact-generation`
- `bun run verify:ocr-providers`

## Testing

```bash
cd backend
bun run test
bun run typecheck
```

```bash
cd frontend
npm test
```

## Notes
- Python/FastAPI backend path is removed and no longer supported.
- Frontend should call project-owned `/api/*` endpoints only.
