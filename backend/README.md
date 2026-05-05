# Backend Runtime (Bun Only)

## Prerequisites
- Bun `>=1.3`

## Install
```bash
cd backend
bun install
```

## Run
```bash
bun run dev
```

## Scripts
- `bun run dev`: watch mode backend server
- `bun run start`: single-run backend server
- `bun run test`: test suite
- `bun run typecheck`: TypeScript type-check
- `bun run verify:runtime-boundary`
- `bun run verify:backend-migration-slice`
- `bun run verify:studio-selection-ocr`
- `bun run verify:learning-artifact-generation`
- `bun run verify:ocr-providers`

## Notes
- Backend runtime is Bun-only. Node `tsx` startup path has been removed.
- Local SQLite backend uses `bun:sqlite`.
