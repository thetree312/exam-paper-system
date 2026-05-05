import assert from "node:assert/strict"
import test from "node:test"

import { streamJsonResponse } from "../src/routes/agent"
import { getLogContext, runWithLogContext } from "../src/lib/logger"

test("streamJsonResponse preserves log context for async streaming handlers", async () => {
  const response = streamJsonResponse(
    async (write) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await write({
        type: "context",
        request_id: getLogContext().request_id,
        session_id: getLogContext().session_id,
      })
    },
    {
      request_id: "req_stream",
      session_id: "session_stream",
    },
  )

  const body = await response.text()
  const lines = body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

  assert.equal(response.status, 200)
  assert.deepEqual(lines[0], {
    type: "context",
    request_id: "req_stream",
    session_id: "session_stream",
  })
})
