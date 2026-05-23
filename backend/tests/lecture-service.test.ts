import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdirSync, readFileSync } from "node:fs"

process.env.LOCAL_SQLITE_PATH = path.join(process.cwd(), "tmp", "tests", "lecture-service.db")

const { getLocalSqlite } = await import("../src/lib/local-sqlite")
const { WorkroomService } = await import("../src/domains/workrooms/service")
const { StudioService } = await import("../src/domains/studio/service")
const {
  LectureService,
  buildLectureTaskPrompt,
  extractLectureAgentSessionIDFromMessages,
} = await import("../src/domains/lecture/service")
const { LectureRepository } = await import("../src/domains/lecture/repository")
const { LectureEvents } = await import("../src/domains/lecture/events")
const {
  analyzeLectureIntentPrompt,
  buildLectureIntentDirective,
} = await import("../src/domains/agent/service")

const dbPath = process.env.LOCAL_SQLITE_PATH

function resetDb() {
  if (!dbPath) throw new Error("LOCAL_SQLITE_PATH is required")
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = getLocalSqlite()
  db.exec(`
    DELETE FROM lecture_blocks;
    DELETE FROM lecture_sessions;
    DELETE FROM question_card_study_events;
    DELETE FROM question_card_learning_states;
    DELETE FROM question_card_learning_summaries;
    DELETE FROM question_card_grading_records;
    DELETE FROM question_card_knowledge_profiles;
    DELETE FROM question_card_weaknesses;
    DELETE FROM question_card_diagnoses;
    DELETE FROM question_card_attempts;
    DELETE FROM studio_question_cards;
    DELETE FROM studio_documents;
    DELETE FROM questions;
    DELETE FROM workroom_artifacts;
    DELETE FROM workroom_sources;
    DELETE FROM workrooms;
  `)
}

async function createFixture() {
  const userID = "user-lecture"
  const workroom = await WorkroomService.create({
    userID,
    name: "讲解服务测试",
    rootDirectory: path.join(process.cwd(), "tmp", "tests", "workrooms", `lecture-${Date.now()}`),
  })
  const document = await StudioService.createDocument({
    userID,
    workroomID: workroom.id,
    title: "讲解测试题卡集",
  })
  const [card] = await StudioService.appendQuestionCards({
    userID,
    workroomID: workroom.id,
    studioDocumentID: document.id,
    drafts: [
      {
        text: "已知一次函数 y = kx + b 经过点 A(1,3) 和点 B(3,7)，求解析式，并判断点 C(2,5) 是否在图像上。",
        page: 1,
        explanation: "先由两点求斜率，再回代求截距，最后验证点 C。",
      },
    ],
  })
  return {
    userID,
    workroomID: workroom.id,
    studioDocumentID: document.id,
    cardID: card.id,
  }
}

beforeEach(() => {
  resetDb()
})

test("LectureService.launchSession reuses only the matching origin message", { concurrency: false }, async () => {
  const fixture = await createFixture()

  const first = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-1",
    originMessageID: "message-1",
  })

  assert.equal(first.session.cardID, fixture.cardID)
  assert.equal(first.session.originAgentSessionID, "agent-session-1")
  assert.equal(first.session.status, "idle")
  assert.equal(first.reusedExisting, false)
  assert.equal(first.taskDescription, "Lecture 1")
  assert.ok(!first.taskPrompt.includes("[lecture-session-id:"))
  assert.ok(first.taskPrompt.includes("原生 question tool"))

  const second = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-1",
    originMessageID: "message-1",
  })

  assert.equal(second.session.id, first.session.id)
  assert.equal(second.reusedExisting, true)

  const third = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-1",
    originMessageID: "message-2",
  })

  assert.notEqual(third.session.id, first.session.id)
  assert.equal(third.reusedExisting, false)
})

test("extractLectureAgentSessionIDFromMessages binds the lecture child from task metadata directly", { concurrency: false }, async () => {
  const messages = [
    {
      info: { id: "msg-user-1", role: "user" },
      parts: [{ type: "text", text: "请讲解这题" }],
    },
    {
      info: { id: "msg-assistant-1", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "general task",
              prompt: "do something else",
              subagent_type: "general",
            },
            metadata: { sessionId: "general-child-session" },
            time: { start: 1, end: 2 },
            title: "general task",
            output: "done",
          },
        },
      ],
    },
    {
      info: { id: "msg-user-2", role: "user" },
      parts: [{ type: "text", text: "继续" }],
    },
    {
      info: { id: "msg-assistant-2", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "running",
            input: {
              description: "lecture task",
              prompt: "teach this question",
              subagent_type: "lecture",
            },
            metadata: { sessionId: "lecture-child-session" },
            time: { start: 3 },
            title: "lecture task",
          },
        },
      ],
    },
  ]

  assert.equal(extractLectureAgentSessionIDFromMessages(messages, "msg-assistant-2"), "lecture-child-session")
})

test("LectureService.appendBlock persists a running lecture step without custom pause state", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-2",
  })

  const lectureBlock = await LectureService.appendBlock({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    role: "lecture",
    text: "先盯住 A 点和 B 点。",
    highlightSpans: [{ sourceId: "stem", quote: "A 点和 B 点" }],
  })

  assert.equal(lectureBlock.pauseAfter, false)

  const payload = await LectureService.getSession({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
  })

  assert.equal(payload.session.status, "running")
  assert.deepEqual(payload.session.activeHighlightSpans, [{ sourceId: "stem", quote: "A 点和 B 点" }])
  assert.equal(payload.blocks.length, 1)
  assert.equal(payload.blocks[0]?.role, "lecture")
  assert.deepEqual(payload.blocks[0]?.highlightSpans, [{ sourceId: "stem", quote: "A 点和 B 点" }])
})

test("LectureService.appendBlock repairs bare math lines and infers highlights from exact source text", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-2b",
  })

  const lectureBlock = await LectureService.appendBlock({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    role: "lecture",
    text: "r_p = 5R,\\quad r_a = 7R",
  })

  assert.equal(lectureBlock.text, "$$r_p = 5R,\\quad r_a = 7R$$")
  assert.equal(lectureBlock.highlightSpans.length, 0)

  const exactStemBlock = await LectureService.appendBlock({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    role: "lecture",
    text: "已知一次函数 y = kx + b 经过点 A(1,3) 和点 B(3,7)，求解析式，并判断点 C(2,5) 是否在图像上。",
  })

  assert.ok(exactStemBlock.highlightSpans.some((span) => span.sourceId === "stem"))
  const payload = await LectureService.getSession({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
  })
  assert.ok(payload.session.activeHighlightSpans.some((span) => span.sourceId === "stem"))
})

test("LectureService.answerQuestion updates active highlights and completeSession stores summary", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-3",
  })

  await LectureService.appendBlock({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    role: "lecture",
    text: "先由 A 点和 B 点求斜率。",
    highlightSpans: [{ sourceId: "stem", quote: "A 点和 B 点" }],
  })

  const answered = await LectureService.answerQuestion({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    text: "因为 A、B 两点定义了解析式，而 C 点只是用来验证。",
    highlightSpans: [{ sourceId: "stem", quote: "点 C(2,5) 是否在图像上" }],
  })
  assert.equal(answered.session.status, "running")
  assert.deepEqual(answered.session.activeHighlightSpans, [{ sourceId: "stem", quote: "点 C(2,5) 是否在图像上" }])

  const completed = await LectureService.completeSession({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    teachingSummary: "本题主线是两点定函数，再用解析式验点。",
    nextSuggestion: "下一题继续练两点式转解析式。",
  })

  assert.equal(completed.session.status, "completed")
  assert.equal(completed.summary?.completed, true)
  assert.equal(completed.summary?.cardID, fixture.cardID)
  assert.match(completed.summary?.teachingSummary ?? "", /两点定函数/)
})

test("LectureService.closeSession preserves recoverable session state", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-4",
  })

  await LectureService.appendBlock({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    role: "lecture",
    text: "先看题干条件。",
    highlightSpans: [{ sourceId: "stem", quote: "点 A(1,3) 和点 B(3,7)" }],
  })

  await LectureService.closeSession({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
  })

  const recovered = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-4",
  })

  assert.equal(recovered.session.id, launched.session.id)
  assert.equal(recovered.blocks.length, 1)
  assert.equal(recovered.blocks[0]?.text, "先看题干条件。")
})

test("LectureService.setVisualizationHTML stores html and keeps it on session payload", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-5",
  })

  const html = "<div id=\"viz\">test</div><script>window.__lectureViz = true;</script>"
  const updated = await LectureService.setVisualizationHTML({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
    html,
  })

  assert.equal(updated.visualizationHTML, html)

  const payload = await LectureService.getSession({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    lectureSessionID: launched.session.id,
  })

  assert.equal(payload.session.visualizationHTML, html)
  assert.equal(payload.pendingQuestion, null)
})

test("LectureService.patchVisualizationHTML publishes incremental patch updates", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-viz-patch",
  })

  const events: Array<{ type: string; mode?: string; patches?: unknown[] }> = []
  const unsubscribe = LectureEvents.subscribe(launched.session.id, (event) => {
    events.push({
      type: event.type,
      mode: event.type === "lecture.visualization.updated" ? event.mode : undefined,
      patches: event.type === "lecture.visualization.updated" ? event.patches : undefined,
    })
  })

  try {
    await LectureService.setVisualizationHTML({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      lectureSessionID: launched.session.id,
      html: "<div id=\"viz-title\">初始标题</div>",
    })
    const session = await LectureService.patchVisualizationHTML({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      lectureSessionID: launched.session.id,
      patches: [
        { op: "set_text", targetId: "viz-title", text: "更新后的标题" },
        { op: "set_attr", targetId: "viz-title", name: "data-step", value: "2" },
      ],
    })

    assert.equal(session.id, launched.session.id)
    assert.equal(session.visualizationHTML, "<div id=\"viz-title\" data-step=\"2\">更新后的标题</div>")
  } finally {
    unsubscribe()
  }

  const patchEvent = events.find((event) => event.mode === "patch")
  assert.equal(patchEvent?.type, "lecture.visualization.updated")
  assert.equal(patchEvent?.patches?.length, 2)
})

test("LectureService.appendBlock emits lecture.session.ready only on the first visible lecture block", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-ready",
  })

  const events: string[] = []
  const unsubscribe = LectureEvents.subscribe(launched.session.id, (event) => {
    events.push(event.type)
  })

  try {
    await LectureService.appendBlock({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      lectureSessionID: launched.session.id,
      role: "lecture",
      text: "先锁定 A、B 两点，再建立解析式。",
      highlightSpans: [{ sourceId: "stem", quote: "点 A(1,3) 和点 B(3,7)" }],
    })

    await LectureService.appendBlock({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      lectureSessionID: launched.session.id,
      role: "lecture",
      text: "接着代入点 A 求出截距。",
      highlightSpans: [{ sourceId: "stem", quote: "A(1,3)" }],
    })
  } finally {
    unsubscribe()
  }

  assert.deepEqual(events, [
    "lecture.session.ready",
    "lecture.block.appended",
    "lecture.highlight.changed",
    "lecture.block.appended",
    "lecture.highlight.changed",
  ])
})

test("LectureService.projectRuntimeStreamEvent streams assistant text drafts without persisting lecture text", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-runtime-parent",
    originMessageID: "origin-message-runtime",
  })
  await LectureRepository.updateSession(fixture.userID, fixture.workroomID, launched.session.id, {
    lectureAgentSessionID: "agent-session-runtime-child",
  })

  const events: Array<{ type: string; text: string | null }> = []
  const unsubscribe = LectureEvents.subscribe(launched.session.id, (event) => {
    events.push({
      type: event.type,
      text: event.draftBlock?.text ?? ("block" in event ? event.block.text : null),
    })
  })

  try {
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-runtime-child",
      event: {
        type: "message.started",
        properties: {
          info: { id: "msg-runtime-1", role: "assistant" },
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-runtime-child",
      event: {
        type: "message.part.delta",
        properties: {
          messageID: "msg-runtime-1",
          partID: "part-runtime-1",
          field: "text",
          delta: "先看题干",
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-runtime-child",
      event: {
        type: "message.part.delta",
        properties: {
          messageID: "msg-runtime-1",
          partID: "part-runtime-1",
          field: "text",
          delta: "，再建立关系。",
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-runtime-child",
      event: {
        type: "message.completed",
        properties: {
          messageID: "msg-runtime-1",
          info: { id: "msg-runtime-1", role: "assistant" },
          parts: [],
        },
      },
    })
  } finally {
    unsubscribe()
  }

  assert.deepEqual(events, [
    { type: "lecture.block.streaming", text: "先看题干" },
    { type: "lecture.block.streaming", text: "先看题干，再建立关系。" },
    { type: "lecture.block.streaming", text: null },
  ])
  const persistedBlocks = await LectureRepository.listBlocks(fixture.userID, fixture.workroomID, launched.session.id)
  assert.equal(persistedBlocks.length, 0)
})

test("LectureService.projectRuntimeStreamEvent separates reasoning drafts from lecture text", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-reasoning-parent",
    originMessageID: "origin-message-reasoning",
  })
  await LectureRepository.updateSession(fixture.userID, fixture.workroomID, launched.session.id, {
    lectureAgentSessionID: "agent-session-reasoning-child",
  })

  const events: Array<{ type: string; text: string | null; status?: string | null }> = []
  const unsubscribe = LectureEvents.subscribe(launched.session.id, (event) => {
    events.push({
      type: event.type,
      text: event.reasoningDraft?.text ?? event.draftBlock?.text ?? null,
      status: event.reasoningDraft?.status ?? null,
    })
  })

  try {
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-reasoning-child",
      event: {
        type: "message.started",
        properties: {
          info: { id: "msg-reasoning-1", role: "assistant" },
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-reasoning-child",
      event: {
        type: "message.part.added",
        properties: {
          messageID: "msg-reasoning-1",
          part: {
            id: "part-reasoning-1",
            sessionID: "agent-session-reasoning-child",
            messageID: "msg-reasoning-1",
            type: "reasoning",
            text: "先判断用户卡点",
          },
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-reasoning-child",
      event: {
        type: "message.part.delta",
        properties: {
          messageID: "msg-reasoning-1",
          partID: "part-reasoning-1",
          field: "text",
          delta: "，再组织讲解。",
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-reasoning-child",
      event: {
        type: "message.part.added",
        properties: {
          messageID: "msg-reasoning-1",
          part: {
            id: "part-text-1",
            sessionID: "agent-session-reasoning-child",
            messageID: "msg-reasoning-1",
            type: "text",
            text: "正式讲解开始。",
          },
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-reasoning-child",
      event: {
        type: "message.completed",
        properties: {
          messageID: "msg-reasoning-1",
          info: { id: "msg-reasoning-1", role: "assistant" },
          parts: [],
        },
      },
    })
  } finally {
    unsubscribe()
  }

  assert.deepEqual(events, [
    { type: "lecture.reasoning.streaming", text: "先判断用户卡点", status: "thinking" },
    { type: "lecture.reasoning.streaming", text: "先判断用户卡点，再组织讲解。", status: "thinking" },
    { type: "lecture.block.streaming", text: "正式讲解开始。", status: null },
    { type: "lecture.reasoning.streaming", text: "先判断用户卡点，再组织讲解。", status: "complete" },
    { type: "lecture.block.streaming", text: null, status: null },
  ])
})

test("LectureService.projectRuntimeStreamEvent classifies reasoning deltas even when part_added was missed", { concurrency: false }, async () => {
  const fixture = await createFixture()
  const launched = await LectureService.launchSession({
    ...fixture,
    originAgentSessionID: "agent-session-late-reasoning-parent",
    originMessageID: "origin-message-late-reasoning",
  })
  await LectureRepository.updateSession(fixture.userID, fixture.workroomID, launched.session.id, {
    lectureAgentSessionID: "agent-session-late-reasoning-child",
  })

  const events: Array<{ type: string; text: string | null; status?: string | null }> = []
  const unsubscribe = LectureEvents.subscribe(launched.session.id, (event) => {
    events.push({
      type: event.type,
      text: event.reasoningDraft?.text ?? event.draftBlock?.text ?? null,
      status: event.reasoningDraft?.status ?? null,
    })
  })

  try {
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-late-reasoning-child",
      event: {
        type: "message.started",
        properties: {
          info: { id: "msg-late-reasoning-1", role: "assistant" },
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-late-reasoning-child",
      event: {
        type: "message.part.delta",
        properties: {
          messageID: "msg-late-reasoning-1",
          partID: "part-late-reasoning-1",
          partType: "reasoning",
          field: "text",
          delta: "这段是模型思考，不应该进入正文。",
        },
      },
    })
    await LectureService.projectRuntimeStreamEvent({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      agentSessionID: "agent-session-late-reasoning-child",
      event: {
        type: "message.part.delta",
        properties: {
          messageID: "msg-late-reasoning-1",
          partID: "part-text-1",
          partType: "text",
          field: "text",
          delta: "正式讲解。",
        },
      },
    })
  } finally {
    unsubscribe()
  }

  assert.deepEqual(events, [
    { type: "lecture.reasoning.streaming", text: "这段是模型思考，不应该进入正文。", status: "thinking" },
    { type: "lecture.block.streaming", text: "正式讲解。", status: null },
  ])
})

test("buildLectureTaskPrompt keeps lecture child focused on runtime streamed text and bridge side effects", { concurrency: false }, async () => {
  const taskPrompt = buildLectureTaskPrompt({
    lectureSessionID: "lecture_session_example",
    questionNumber: 5,
    stem: "已知近日点与远日点距离，判断先用哪个物理规律切入。",
    sourceBlocks: [
      {
        id: "stem",
        kind: "stem",
        text: "已知近日点与远日点距离，判断先用哪个物理规律切入。",
        label: "题干",
      },
    ],
  })

  assert.ok(taskPrompt.includes("原生 question tool"))
  assert.ok(taskPrompt.includes("普通讲解正文直接正常输出"))
  assert.ok(taskPrompt.includes("系统会原生流式投影到讲解容器"))
  assert.ok(taskPrompt.includes("不要再用 lecture bridge 写 lecture 正文"))
  assert.ok(!taskPrompt.includes("append-block --role lecture --text-file"))
  assert.ok(!taskPrompt.includes("[lecture-session-id:"))
  assert.ok(taskPrompt.includes("render-html-patch"))
  assert.ok(taskPrompt.includes("--html-file"))
  assert.ok(taskPrompt.includes("--patch-file"))
  assert.ok(taskPrompt.includes("--delete-after-read"))
  assert.ok(taskPrompt.includes("question.custom"))
  assert.ok(taskPrompt.includes("\"sourceId\""))
  assert.ok(!taskPrompt.includes("--text-env"))
  assert.ok(!taskPrompt.includes("lecture_checkpoint"))
})

test("lecture prompt source keeps bridge for visualization and runtime stream for text", { concurrency: false }, async () => {
  const lecturePromptPath = path.join(process.cwd(), "backend", "agent", "packages", "opencode", "src", "agent", "prompt", "lecture.txt")
  const lecturePrompt = readFileSync(lecturePromptPath, "utf8")

  assert.ok(lecturePrompt.includes("normal teaching text is projected into the lecture container automatically with native streaming"))
  assert.ok(lecturePrompt.includes("projected into the lecture container automatically"))
  assert.ok(lecturePrompt.includes("only when you need explicit visualization updates"))
  assert.ok(lecturePrompt.includes("render-html"))
  assert.ok(lecturePrompt.includes("render-html-patch"))
  assert.ok(!lecturePrompt.includes("append-block --role lecture --text-file"))
})

test("LectureService.launchSession returns source blocks for mcq content", { concurrency: false }, async () => {
  const userID = "user-lecture-mcq"
  const workroom = await WorkroomService.create({
    userID,
    name: "讲解服务测试-MCQ",
    rootDirectory: path.join(process.cwd(), "tmp", "tests", "workrooms", `lecture-mcq-${Date.now()}`),
  })
  const document = await StudioService.createDocument({
    userID,
    workroomID: workroom.id,
    title: "选择题",
  })
  const [card] = await StudioService.appendQuestionCards({
    userID,
    workroomID: workroom.id,
    studioDocumentID: document.id,
    drafts: [
      {
        text: "关于该小行星，下列说法正确的是（）\nA. 公转周期约为 6 年\nB. 从远日点到近日点所受太阳引力大小逐渐减小",
        page: 1,
      },
    ],
  })

  const launched = await LectureService.launchSession({
    userID,
    workroomID: workroom.id,
    studioDocumentID: document.id,
    cardID: card.id,
    originAgentSessionID: "agent-session-mcq",
  })

  assert.deepEqual(launched.sourceBlocks, [
    {
      id: "stem",
      kind: "stem",
      text: "关于该小行星，下列说法正确的是（）",
      label: "题干",
    },
    {
      id: "option.A",
      kind: "option",
      text: "公转周期约为 6 年",
      label: "选项 A",
    },
    {
      id: "option.B",
      kind: "option",
      text: "从远日点到近日点所受太阳引力大小逐渐减小",
      label: "选项 B",
    },
  ])
})

test("lecture intent helpers force lecture entry and child delegation wording", { concurrency: false }, async () => {
  const analyzed = analyzeLectureIntentPrompt("请像老师一样讲第 3 题，不要直接给答案")

  assert.equal(analyzed.isLectureIntent, true)
  assert.equal(analyzed.questionNumber, 3)

  const directive = buildLectureIntentDirective({
    questionNumber: analyzed.questionNumber,
  })

  assert.ok(directive.includes("confirmed lecture intent"))
  assert.ok(directive.includes("q-get --question-number 3"))
  assert.ok(directive.includes("delegate the lecture child subagent"))
})
