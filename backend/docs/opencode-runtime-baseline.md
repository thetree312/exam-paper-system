# Opencode Runtime Baseline (Bun Backend)

## Official Baseline
- Source of truth: `temp/opencode-official-dev/opencode-dev/packages/opencode/src`
- Local runtime root: `backend/agent/packages/opencode/src`

## Allowed Local Differences (Whitelist)
Only the following are allowed to diverge from official source semantics:
1. Bun backend API adapter glue under `backend/src/routes/agent.ts` and `backend/src/domains/agent/*`
2. Auth/session scope injection required by project user model
3. Workroom boundary mapping (`workroom/wiki`) and filesystem guard integration
4. Event envelope adaptation between runtime stream and project SSE payload

Any runtime-core behavior change outside this whitelist is forbidden.

## Runtime Core Must Stay Official-Equivalent
The following modules must keep official behavior semantics:
- `session/prompt.ts`
- `session/compaction.ts`
- `tool/task.ts`
- `mcp/index.ts`
- `skill/index.ts`
- `provider/{provider.ts,transform.ts,auth.ts,models.ts,error.ts,schema.ts}`

## Review Gate
Before merging runtime changes:
1. Verify modified runtime files are either in whitelist adapter areas or official-equivalent core files.
2. If core files changed, attach source-to-source diff against official baseline and justify each local delta.
3. Reject placeholder/skeleton/compat-layer substitutions.
