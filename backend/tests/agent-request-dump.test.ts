import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

test("writeInitialRequestDump writes a readable utf8 txt with payload sections", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-request-dump-"))
  process.env.XDG_DATA_HOME = path.join(root, "xdg", "data")
  process.env.XDG_STATE_HOME = path.join(root, "xdg", "state")
  process.env.XDG_CACHE_HOME = path.join(root, "xdg", "cache")
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg", "config")

  const { appendProviderParamsDump, writeInitialRequestDump } = await import(
    "../agent/packages/opencode/src/session/request-dump.ts"
  )

  const filePath = await writeInitialRequestDump({
    agent: "build",
    modelID: "qwen3.5-plus",
    providerID: "alibaba-cn",
    sessionID: "ses_test",
    userMessageID: "msg_test",
    system: ["policy", "skills"],
    messages: [{ role: "user", content: "hello" }],
    tools: {
      read: {
        description: "read file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      } as any,
    },
    options: { someOption: true },
    params: {
      temperature: 0,
      topP: 1,
      topK: 20,
      maxOutputTokens: 4096,
      toolChoice: "auto",
      activeTools: ["read"],
      headers: { "x-test": "1" },
      providerOptions: { openai: { reasoningEffort: "medium" } },
    },
  })

  await appendProviderParamsDump({
    filePath,
    type: "stream",
    params: { prompt: "final-prompt" },
  })

  const text = await fs.readFile(filePath, "utf8")
  assert.match(text, /=== META ===/)
  assert.match(text, /session_id: ses_test/)
  assert.match(text, /=== TOOLS JSON ===/)
  assert.match(text, /"name": "read"/)
  assert.match(text, /=== PROVIDER PARAMS ===/)
  assert.match(text, /"prompt": "final-prompt"/)
})
