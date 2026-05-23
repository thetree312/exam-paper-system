import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { PassThrough } from "node:stream"

process.env.LOCAL_SQLITE_PATH = path.join(process.cwd(), "tmp", "tests", "studio-question-card-cli.db")

const { getLocalSqlite } = await import("../src/lib/local-sqlite")
const { WorkroomService } = await import("../src/domains/workrooms/service")
const { StudioService } = await import("../src/domains/studio/service")
const { runStudioQuestionCardsCli } = await import("../src/cli/studio-question-cards")
const {
  buildAgentBridgeWrapper,
  buildStudioQuestionCardsCommandGuide,
} = await import("../src/domains/agent/service")

const dbPath = process.env.LOCAL_SQLITE_PATH

function resetDb() {
  if (!dbPath) throw new Error("LOCAL_SQLITE_PATH is required")
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = getLocalSqlite()
  db.exec(`
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
  const userID = "user-studio-cli"
  const workroom = await WorkroomService.create({
    userID,
    name: "题卡 CLI 测试",
    rootDirectory: path.join(process.cwd(), "tmp", "tests", "workrooms", `studio-cli-${Date.now()}`),
  })
  const document = await StudioService.createDocument({
    userID,
    workroomID: workroom.id,
    title: "CLI 题卡集",
  })
  return { userID, workroomID: workroom.id, studioDocumentID: document.id }
}

beforeEach(() => {
  resetDb()
})

test("old question commands are deprecated", async () => {
  const stderr = new PassThrough()
  const chunks: Buffer[] = []
  stderr.on("data", (c) => chunks.push(Buffer.from(c)))

  const code = await runStudioQuestionCardsCli(["question", "search"], { stderr: stderr as any })
  assert.equal(code, 1)
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code: string; error: string }
  assert.equal(parsed.code, "DEPRECATED_COMMAND")
  assert.match(parsed.error, /q-search/)
})

test("q-insert --help exits successfully", async () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on("data", (c) => out.push(Buffer.from(c)))
  stderr.on("data", (c) => err.push(Buffer.from(c)))
  const code = await runStudioQuestionCardsCli(["q-insert", "--help"], { stdout: stdout as any, stderr: stderr as any })
  assert.equal(code, 0, Buffer.concat(err).toString("utf8"))
  assert.match(Buffer.concat(out).toString("utf8"), /q-insert --anchor-question-number/)
})

test("q-search returns compact summaries", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "第1题 受迫振动", page: 1, explanation: "解析" }],
  })

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on("data", (c) => out.push(Buffer.from(c)))
  stderr.on("data", (c) => err.push(Buffer.from(c)))

  const code = await runStudioQuestionCardsCli(
    ["q-search", "--user-id", fixture.userID, "--workroom-id", fixture.workroomID, "--query", "受迫振动", "--limit", "5"],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 0, Buffer.concat(err).toString("utf8"))
  const parsed = JSON.parse(Buffer.concat(out).toString("utf8")) as { result: { cards: Array<Record<string, unknown>> } }
  assert.equal(parsed.result.cards.length, 1)
  assert.equal(Object.hasOwn(parsed.result.cards[0] ?? {}, "explanation"), false)
})

test("q-get supports --question-number without search fallback", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "第一题", page: 1, answerText: "A", explanation: "解析A" }],
  })

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on("data", (c) => out.push(Buffer.from(c)))
  stderr.on("data", (c) => err.push(Buffer.from(c)))

  const code = await runStudioQuestionCardsCli(
    ["q-get", "--user-id", fixture.userID, "--workroom-id", fixture.workroomID, "--question-number", "1", "--json"],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 0, Buffer.concat(err).toString("utf8"))
  const parsed = JSON.parse(Buffer.concat(out).toString("utf8")) as {
    result: {
      anchor: { questionNumber: number }
      content: { answer: string; explanation: string | null }
      learningProfile: { currentState: { total_attempts: number } | null }
    }
  }
  assert.equal(parsed.result.anchor.questionNumber, 1)
  assert.equal(parsed.result.content.answer, "A")
  assert.equal(parsed.result.content.explanation, "解析A")
  assert.equal(parsed.result.learningProfile.currentState?.total_attempts ?? 0, 0)
})

test("q-get outputs plain text by default", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "第一题", page: 1 }],
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on("data", (c) => out.push(Buffer.from(c)))
  stderr.on("data", (c) => err.push(Buffer.from(c)))
  const code = await runStudioQuestionCardsCli(
    ["q-get", "--user-id", fixture.userID, "--workroom-id", fixture.workroomID, "--question-number", "1"],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 0, Buffer.concat(err).toString("utf8"))
  const text = Buffer.concat(out).toString("utf8")
  assert.match(text, /cardID:/)
  assert.match(text, /定位信息:/)
  assert.match(text, /原题:/)
  assert.match(text, /答案:/)
  assert.match(text, /解析:/)
  assert.match(text, /建议出题:/)
  assert.match(text, /建议难度:/)
  assert.match(text, /上次做错原因:/)
  assert.equal(text.includes('"ok"'), false)
})

test("q-get --full is rejected in the agent bridge", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "第一题", page: 1 }],
  })

  const stderr = new PassThrough()
  const err: Buffer[] = []
  stderr.on("data", (c) => err.push(Buffer.from(c)))

  const code = await runStudioQuestionCardsCli(
    ["q-get", "--user-id", fixture.userID, "--workroom-id", fixture.workroomID, "--question-number", "1", "--full"],
    { stderr: stderr as any },
  )
  assert.equal(code, 1)
  const parsed = JSON.parse(Buffer.concat(err).toString("utf8")) as { code: string; error: string }
  assert.equal(parsed.code, "COMMAND_EXECUTION_FAILED")
  assert.match(parsed.error, /UNSUPPORTED_ARGUMENT: q-get --full is disabled/i)
})

test("q-get payload avoids duplicate stem and diagnosis", async () => {
  const fixture = await createFixture()
  const [card] = await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "第一题", page: 1 }],
  })
  await StudioService.submitAttempt({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    cardID: card.id,
    answerText: "A",
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on("data", (c) => out.push(Buffer.from(c)))
  stderr.on("data", (c) => err.push(Buffer.from(c)))
  const code = await runStudioQuestionCardsCli(
    ["q-get", "--user-id", fixture.userID, "--workroom-id", fixture.workroomID, "--question-number", "1", "--json"],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 0, Buffer.concat(err).toString("utf8"))
  const body = Buffer.concat(out).toString("utf8")
  assert.match(body, /"cardID":/)
  assert.match(body, /"anchor":/)
  assert.match(body, /"content":/)
})

test("agent question-card guide makes q-get launch-ready", () => {
  const guide = buildStudioQuestionCardsCommandGuide({
    userID: "user-studio-cli",
    workroomID: "workroom-studio-cli",
    workroomRootDirectory: "D:/Exam-paper/backend/local-data/workrooms/workroom-studio-cli",
  })
  assert.equal(guide.includes("[--full]"), false)
  assert.match(
    guide,
    /q-get returns a launch-ready detail view by default: cardID, question number, original question text, answer, explanation, grading-AI question recommendation, suggested difficulty, and the latest wrong-reason summary\./,
  )
  assert.match(guide, /After q-get --question-number <n>, use the returned cardID directly\./)
  assert.match(guide, /Debugging must go to backend logs or request dumps, not back into agent tool context\./)
})

test("agent bridge wrapper is emitted as a valid module with top-level await", () => {
  const wrapper = buildAgentBridgeWrapper({
    bridgeBaseURL: "http://127.0.0.1:3000",
    bridgeToken: "token-demo",
    userID: "user-studio-cli",
    workroomID: "workroom-studio-cli",
    cliImportPath: "D:/Exam-paper/backend/src/cli/lecture.ts",
    entrypoint: "runLectureCli",
  })

  assert.match(wrapper, /^export \{\}\n/m)
  assert.match(wrapper, /const \{ runLectureCli \} = await import\("D:\/Exam-paper\/backend\/src\/cli\/lecture\.ts"\)/)
  assert.match(wrapper, /const exitCode = await runLectureCli\(process\.argv\.slice\(2\)\)/)
})

test("q-similar inserts around question number in one command", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "第一题", page: 1 }, { text: "第二题", page: 1 }],
  })

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on("data", (c) => out.push(Buffer.from(c)))
  stderr.on("data", (c) => err.push(Buffer.from(c)))

  const code = await runStudioQuestionCardsCli(
    [
      "q-similar",
      "--user-id",
      fixture.userID,
      "--workroom-id",
      fixture.workroomID,
      "--question-number",
      "1",
      "--placement",
      "after",
      "--text",
      "类似题",
    ],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 0, Buffer.concat(err).toString("utf8"))
  const parsed = JSON.parse(Buffer.concat(out).toString("utf8")) as { result: { mode: string; source: { questionNumber: number } } }
  assert.equal(parsed.result.mode, "similar")
  assert.equal(parsed.result.source.questionNumber, 1)
})

test("q-insert out-of-range returns structured error", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "唯一题", page: 1 }],
  })

  const stderr = new PassThrough()
  const err: Buffer[] = []
  stderr.on("data", (c) => err.push(Buffer.from(c)))

  const code = await runStudioQuestionCardsCli(
    [
      "q-insert",
      "--user-id",
      fixture.userID,
      "--workroom-id",
      fixture.workroomID,
      "--question-number",
      "9",
      "--placement",
      "after",
      "--text",
      "越界题",
    ],
    { stderr: stderr as any },
  )
  assert.equal(code, 1)
  const parsed = JSON.parse(Buffer.concat(err).toString("utf8")) as {
    code: string
    detail: { requested?: number; totalAvailable?: number } | null
  }
  assert.equal(parsed.code, "QUESTION_NUMBER_OUT_OF_RANGE")
  assert.equal(parsed.detail?.requested, 9)
  assert.equal(parsed.detail?.totalAvailable, 1)
})
