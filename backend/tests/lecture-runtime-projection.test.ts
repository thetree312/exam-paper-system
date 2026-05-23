import { expect, test } from "bun:test"
import {
  extractRuntimeLectureBlocksFromMessages,
  extractProjectedLectureText,
  extractRuntimeTextDelta,
  extractRuntimeTextPart,
  runtimeEventMessageID,
} from "../src/domains/lecture/runtime-projection"

test("extracts projected lecture text from assistant completion events", () => {
  expect(
    extractProjectedLectureText({
      type: "message.completed",
      properties: {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "第一段讲解。" },
          { type: "text", text: "第二段讲解。" },
        ],
      },
    }),
  ).toBe("第一段讲解。\n\n第二段讲解。")
})

test("ignores non-assistant completion events", () => {
  expect(
    extractProjectedLectureText({
      type: "message.completed",
      properties: {
        info: { role: "user" },
        parts: [{ type: "text", text: "用户消息" }],
      },
    }),
  ).toBeNull()
})

test("ignores completion events without text parts", () => {
  expect(
    extractProjectedLectureText({
      type: "message.completed",
      properties: {
        info: { role: "assistant" },
        parts: [{ type: "tool", state: { status: "completed" } }],
      },
    }),
  ).toBeNull()
})

test("extracts runtime text parts for native lecture streaming", () => {
  expect(
    extractRuntimeTextPart({
      type: "message.part.added",
      properties: {
        messageID: "msg_1",
        part: { id: "part_1", type: "text", text: "第一段正在生成" },
      },
    }),
  ).toEqual({
    messageID: "msg_1",
    partID: "part_1",
    text: "第一段正在生成",
  })
})

test("ignores empty runtime text parts so waiting state is not cleared before visible text", () => {
  expect(
    extractRuntimeTextPart({
      type: "message.part.added",
      properties: {
        messageID: "msg_1",
        part: { id: "part_1", type: "text", text: "" },
      },
    }),
  ).toBeNull()
})

test("extracts runtime text deltas without requiring bridge append-block", () => {
  expect(
    extractRuntimeTextDelta({
      type: "message.part.delta",
      properties: {
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "，继续流式追加。",
      },
    }),
  ).toEqual({
    messageID: "msg_1",
    partID: "part_1",
    text: "，继续流式追加。",
  })
})

test("resolves runtime message id from completion info when top-level messageID is absent", () => {
  expect(
    runtimeEventMessageID({
      type: "message.completed",
      properties: {
        info: { id: "msg_from_info", role: "assistant" },
      },
    }),
  ).toBe("msg_from_info")
})

test("extracts durable lecture blocks from child session assistant text parts", () => {
  expect(
    extractRuntimeLectureBlocksFromMessages({
      lectureSessionID: "lecture_session_1",
      fallbackCreatedAt: "2026-05-22T13:20:00.000Z",
      messages: [
        {
          info: { id: "msg_user", role: "user", time: { created: 1_779_456_000_000 } },
          parts: [{ id: "part_user", type: "text", text: "开始讲解" }],
        },
        {
          info: { id: "msg_summary", role: "assistant", summary: true, time: { created: 1_779_456_001_000 } },
          parts: [{ id: "part_summary", type: "text", text: "压缩摘要不应该进讲解页" }],
        },
        {
          info: { id: "msg_teacher", role: "assistant", time: { created: 1_779_456_002_000 } },
          parts: [
            { id: "part_reasoning", type: "reasoning", text: "hidden" },
            { id: "part_1", type: "text", text: "第一段讲解", time: { start: 1_779_456_003_000 } },
            { id: "part_ignored", type: "text", text: "被忽略", ignored: true },
            { id: "part_2", type: "text", text: "  第二段讲解  " },
          ],
        },
      ],
    }),
  ).toEqual([
    {
      id: "runtime.msg_teacher.part_1",
      sessionID: "lecture_session_1",
      role: "lecture",
      text: "第一段讲解",
      highlightSpans: [],
      pauseAfter: false,
      createdAt: "2026-05-22T13:20:03.000Z",
    },
    {
      id: "runtime.msg_teacher.part_2",
      sessionID: "lecture_session_1",
      role: "lecture",
      text: "第二段讲解",
      highlightSpans: [],
      pauseAfter: false,
      createdAt: "2026-05-22T13:20:02.000Z",
    },
  ])
})
