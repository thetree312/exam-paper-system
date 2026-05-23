import { describe, expect, test } from "bun:test"
import { publishRuntimeStream, subscribeRuntimeStream } from "../src/domains/agent/runtime-stream"

describe("runtime-stream", () => {
  test("publishes to active subscribers and stops after unsubscribe", () => {
    const seen: string[] = []
    const stop = subscribeRuntimeStream("ses_test", (event) => {
      seen.push(event.type)
    })

    publishRuntimeStream("ses_test", { type: "message.part.delta", properties: { delta: "hello" } })
    stop()
    publishRuntimeStream("ses_test", { type: "message.part.delta", properties: { delta: "world" } })

    expect(seen).toEqual(["message.part.delta"])
  })
})
