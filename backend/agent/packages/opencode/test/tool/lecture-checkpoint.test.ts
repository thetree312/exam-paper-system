import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { LectureCheckpointTool } from "../../src/tool/lecture_checkpoint"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("test-message"),
  callID: "test-call",
  agent: "lecture",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(Question.defaultLayer, CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const pending = Effect.fn("LectureCheckpointToolTest.pending")(function* (question: Question.Interface) {
  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Effect.sleep("10 millis")
  }
})

describe("tool.lecture_checkpoint", () => {
  it.live("publishes a single interactive checkpoint question and resumes with the answer", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const question = yield* Question.Service
        const toolInfo = yield* LectureCheckpointTool
        const tool = yield* toolInfo.init()

        const fiber = yield* tool
          .execute(
            {
              goal: "diagnose the student's first reasoning move",
              header: "切入点",
              question: "先从哪个物理规律切入最自然？",
              options: [
                { label: "A", description: "先看周期与半长轴关系" },
                { label: "B", description: "先看引力与距离关系" },
                { label: "C", description: "先看速度与能量关系" },
              ],
              allowCustom: true,
            },
            ctx,
          )
          .pipe(Effect.forkScoped)

        const item = yield* pending(question)
        expect(item.questions).toHaveLength(1)
        expect(item.questions[0]?.header).toBe("切入点")
        expect(item.questions[0]?.custom).toBe(true)
        yield* question.reply({ requestID: item.id, answers: [["A"]] })

        const result = yield* Fiber.join(fiber)
        expect(result.title).toBe("Lecture checkpoint: 切入点")
        expect(result.output).toContain("A")
      }),
    ),
  )
})
