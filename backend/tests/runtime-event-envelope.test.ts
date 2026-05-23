import { describe, expect, test } from "bun:test"
import { toRuntimeStreamEnvelope } from "../src/domains/agent/runtime-event-envelope"

describe("runtime-event-envelope", () => {
  test("passes through native opencode bus events that already use dotted event names", () => {
    expect(
      toRuntimeStreamEnvelope({
        type: "message.part.delta",
        properties: {
          sessionID: "ses_child",
          messageID: "msg_1",
          partID: "part_1",
          field: "text",
          delta: "正在流式进入讲解页",
        },
      }),
    ).toEqual({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_child",
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "正在流式进入讲解页",
      },
    })
  })

  test("normalizes dotted bus events that carry fields at top level", () => {
    expect(
      toRuntimeStreamEnvelope({
        type: "message.part.delta",
        sessionID: "ses_child",
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "继续追加",
      }),
    ).toEqual({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_child",
        messageID: "msg_1",
        partID: "part_1",
        field: "text",
        delta: "继续追加",
      },
    })
  })

  test("normalizes top-level part type for part delta events", () => {
    expect(
      toRuntimeStreamEnvelope({
        type: "part_delta",
        messageID: "msg_1",
        partID: "part_1",
        partType: "reasoning",
        field: "text",
        delta: "模型思考",
      }),
    ).toEqual({
      type: "message.part.delta",
      properties: {
        sessionID: undefined,
        messageID: "msg_1",
        partID: "part_1",
        partType: "reasoning",
        field: "text",
        delta: "模型思考",
      },
    })
  })
})
