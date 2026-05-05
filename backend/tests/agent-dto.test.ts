import assert from "node:assert/strict"
import test from "node:test"

import { mapAgentHistoryMessages, mapAgentSessionListItems } from "../src/domains/agent/dto"

test("mapAgentHistoryMessages normalizes opencode messages into frontend DTO shape", () => {
  const result = mapAgentHistoryMessages([
    {
      info: {
        id: "msg_1",
        role: "assistant",
        time: { created: 1776501893177 },
      },
      parts: [
        { type: "reasoning", text: "ignored" },
        { type: "text", text: "你好" },
        { type: "text", text: "！" },
      ],
    },
  ])

  assert.deepEqual(result, [
    {
      id: "msg_1",
      role: "assistant",
      content: "你好！",
      created_at: new Date(1776501893177).toISOString(),
      citations: [],
      citation_status: null,
      used_rag_evidence: false,
    },
  ])
})

test("mapAgentSessionListItems derives preview and message count from normalized histories", () => {
  const result = mapAgentSessionListItems({
    sessions: [
      {
        id: "ses_1",
        title: "问候",
        time: {
          created: 1776501892917,
          updated: 1776501961155,
        },
      },
    ],
    messagesBySessionID: {
      ses_1: [
        {
          id: "m1",
          role: "user",
          content: "你好",
          created_at: new Date(1776501892917).toISOString(),
          citations: [],
          citation_status: null,
          used_rag_evidence: false,
        },
        {
          id: "m2",
          role: "assistant",
          content: "你好！有什么我可以帮你的吗？",
          created_at: new Date(1776501961155).toISOString(),
          citations: [],
          citation_status: null,
          used_rag_evidence: false,
        },
      ],
    },
  })

  assert.deepEqual(result, [
    {
      id: "ses_1",
      title: "问候",
      last_message_preview: "你好！有什么我可以帮你的吗？",
      message_count: 2,
      status: "active",
      archived: false,
      created_at: new Date(1776501892917).toISOString(),
      updated_at: new Date(1776501961155).toISOString(),
    },
  ])
})
