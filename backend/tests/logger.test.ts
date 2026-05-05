import assert from "node:assert/strict"
import test from "node:test"

import { createLogger, runWithLogContext, setLogSink } from "../src/lib/logger"

test("backend logger merges async context into emitted entries", async () => {
  const entries: Array<Record<string, unknown>> = []
  const restore = setLogSink((entry) => {
    entries.push(entry as Record<string, unknown>)
  })

  try {
    const logger = createLogger({ domain: "agent", source: "opencode" })

    await runWithLogContext(
      {
        request_id: "req_test",
        user_id: "user_1",
        workroom_id: "workroom_1",
        session_id: "session_1",
      },
      async () => {
        logger.warn("duplicate skill name", {
          service: "skill",
          name: "brainstorming",
        })
      },
    )
  } finally {
    restore()
  }

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.level, "warn")
  assert.equal(entries[0]?.message, "duplicate skill name")
  assert.deepEqual(entries[0]?.context, {
    domain: "agent",
    source: "opencode",
    request_id: "req_test",
    user_id: "user_1",
    workroom_id: "workroom_1",
    session_id: "session_1",
    service: "skill",
    name: "brainstorming",
  })
})
