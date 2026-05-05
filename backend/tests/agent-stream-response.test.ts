import test from "node:test"
import assert from "node:assert/strict"

import { streamJsonResponse } from "../src/routes/agent"

test("streamJsonResponse converts handler failures into error events instead of crashing", async () => {
  const response = streamJsonResponse(async (write) => {
    await write({ type: "session", session_id: "ses_test" })
    throw new Error("boom")
  })

  const body = await response.text()
  const lines = body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

  assert.equal(response.status, 200)
  assert.deepEqual(lines[0], { type: "session", session_id: "ses_test" })
  assert.deepEqual(lines[1], { type: "error", error: "boom" })
})
