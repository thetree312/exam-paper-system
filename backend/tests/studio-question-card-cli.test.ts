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
const { executeStudioQuestionCardsCommand } = await import("../src/domains/studio/command-bridge")

const dbPath = process.env.LOCAL_SQLITE_PATH

function resetDb() {
  if (!dbPath) throw new Error("LOCAL_SQLITE_PATH is required")
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = getLocalSqlite()
  db.exec(`
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

async function createAmbiguousFixture() {
  const userID = "user-studio-cli"
  const workroom = await WorkroomService.create({
    userID,
    name: "题卡 CLI 歧义测试",
    rootDirectory: path.join(process.cwd(), "tmp", "tests", "workrooms", `studio-cli-ambiguous-${Date.now()}`),
  })
  const first = await StudioService.createDocument({
    userID,
    workroomID: workroom.id,
    title: "题卡集一",
  })
  const second = await StudioService.createDocument({
    userID,
    workroomID: workroom.id,
    title: "题卡集二",
  })
  return { userID, workroomID: workroom.id, studioDocumentIDs: [first.id, second.id] }
}

beforeEach(() => {
  resetDb()
})

test("executeStudioQuestionCardsCommand returns compact cards through query bridge only", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "原题一", page: 1 }, { text: "原题二", page: 1 }],
  })
  const existing = await StudioService.listQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
  })
  await StudioService.insertQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    anchorCardID: existing[0]!.id,
    position: "after",
    drafts: [{ text: "插入练习题", page: 1 }],
  })

  const listedResult = (await executeStudioQuestionCardsCommand("list-container-cards", fixture)) as {
    cards: Array<{ preview: string; sequenceIndex: number; questionNumber: number }>
  }
  assert.deepEqual(
    listedResult.cards.map((item) => item.questionNumber),
    [1, 2, 3],
  )
  assert.deepEqual(
    listedResult.cards.map((item) => item.sequenceIndex),
    [0, 1, 2],
  )
  assert.match(listedResult.cards[0]?.preview ?? "", /原题一/)
})

test("runStudioQuestionCardsCli supports compact query stdin json and stdout response", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "CLI 题一", page: 1 }],
  })

  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outputChunks: Buffer[] = []
  const errorChunks: Buffer[] = []
  stdout.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)))
  stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)))

  stdin.end(
    JSON.stringify({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      studioDocumentID: fixture.studioDocumentID,
    }),
  )

  const code = await runStudioQuestionCardsCli(["list-container-cards"], {
    stdin: stdin as any,
    stdout: stdout as any,
    stderr: stderr as any,
  })

  assert.equal(code, 0, Buffer.concat(errorChunks).toString("utf8"))
  const parsed = JSON.parse(Buffer.concat(outputChunks).toString("utf8")) as {
    command: string
    result: { cards: Array<{ preview: string }> }
  }
  assert.equal(parsed.command, "list-container-cards")
  assert.match(parsed.result.cards[0]?.preview ?? "", /CLI 题一/)
})

test("runStudioQuestionCardsCli returns compact cards for list-container-cards", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [
      {
        text: "这是一个很长的题干，用来验证 list-container-cards 默认不会把完整重字段全部吐给 agent，而是只返回紧凑摘要和必要定位信息。",
        page: 3,
        explanation: "完整解析不应该出现在紧凑列表里",
      },
    ],
  })

  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outputChunks: Buffer[] = []
  const errorChunks: Buffer[] = []
  stdout.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)))
  stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)))

  stdin.end(
    JSON.stringify({
      userID: fixture.userID,
      workroomID: fixture.workroomID,
      studioDocumentID: fixture.studioDocumentID,
    }),
  )

  const code = await runStudioQuestionCardsCli(["list-container-cards"], {
    stdin: stdin as any,
    stdout: stdout as any,
    stderr: stderr as any,
  })

  assert.equal(code, 0, Buffer.concat(errorChunks).toString("utf8"))
  const parsed = JSON.parse(Buffer.concat(outputChunks).toString("utf8")) as {
    result: {
      cards: Array<{
        id: string
        questionNumber: number
        sequenceIndex: number
        page: number | null
        preview: string
        text?: string
        explanation?: string | null
      }>
    }
  }
  assert.equal(parsed.result.cards.length, 1)
  assert.equal(parsed.result.cards[0]?.questionNumber, 1)
  assert.equal(parsed.result.cards[0]?.sequenceIndex, 0)
  assert.equal(parsed.result.cards[0]?.page, 3)
  assert.ok(parsed.result.cards[0]?.preview.length > 0)
  assert.equal("text" in (parsed.result.cards[0] ?? {}), false)
  assert.equal("explanation" in (parsed.result.cards[0] ?? {}), false)
})

test("runStudioQuestionCardsCli preserves structured error detail for invalid compact query payload", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const errorChunks: Buffer[] = []
  stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)))

  stdin.end(JSON.stringify({}))

  const code = await runStudioQuestionCardsCli(["list-container-cards"], {
    stdin: stdin as any,
    stdout: stdout as any,
    stderr: stderr as any,
  })

  assert.equal(code, 1)
  const parsed = JSON.parse(Buffer.concat(errorChunks).toString("utf8")) as {
    code: string
    detail: Array<{ path: string[] }>
  }
  assert.equal(parsed.code, "INVALID_INPUT")
  assert.ok(Array.isArray(parsed.detail))
  assert.ok(parsed.detail.length > 0)
})

test("runStudioQuestionCardsCli supports question create with business fields only", async () => {
  const fixture = await createFixture()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outputChunks: Buffer[] = []
  const errorChunks: Buffer[] = []
  stdout.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)))
  stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)))

  const code = await runStudioQuestionCardsCli(
    [
      "question",
      "create",
      "--user-id",
      fixture.userID,
      "--workroom-id",
      fixture.workroomID,
      "--stem",
      "业务题干",
      "--answer",
      "B",
      "--explanation",
      "这是解析",
      "--option-a",
      "选项A",
      "--option-b",
      "选项B",
      "--option-c",
      "选项C",
      "--option-d",
      "选项D",
    ],
    { stdout: stdout as any, stderr: stderr as any },
  )

  assert.equal(code, 0, Buffer.concat(errorChunks).toString("utf8"))
  const parsed = JSON.parse(Buffer.concat(outputChunks).toString("utf8")) as {
    command: string
    result: {
      mode: string
      card: { questionNumber: number; answerText: string | null; explanation: string | null; text: string }
    }
  }
  assert.equal(parsed.command, "question")
  assert.equal(parsed.result.mode, "create")
  assert.equal(parsed.result.card.questionNumber, 1)
  assert.equal(parsed.result.card.answerText, "B")
  assert.equal(parsed.result.card.explanation, "这是解析")
  assert.match(parsed.result.card.text, /A\.\s*选项A/)

  const detail = await StudioService.getQuestionCardDetail({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    cardID: parsed.result.card.id,
  })
  assert.equal(detail.card.canonicalAnswer, "B")
  assert.equal(detail.card.explanation, "这是解析")
})

test("runStudioQuestionCardsCli requires inline question text and does not accept file-style question input", async () => {
  const fixture = await createFixture()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const errorChunks: Buffer[] = []
  stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)))

  const code = await runStudioQuestionCardsCli(
    [
      "question",
      "create",
      "--user-id",
      fixture.userID,
      "--workroom-id",
      fixture.workroomID,
      "--stem-file",
      "stem_temp.txt",
    ],
    { stdout: stdout as any, stderr: stderr as any },
  )

  assert.equal(code, 1)
  const parsed = JSON.parse(Buffer.concat(errorChunks).toString("utf8")) as {
    code: string
    error: string
  }
  assert.equal(parsed.code, "INVALID_ARGUMENT")
  assert.match(parsed.error, /missing stem/)
})

test("runStudioQuestionCardsCli supports question insert by 1-based question number", async () => {
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "第一题", page: 1 }, { text: "第二题", page: 1 }, { text: "第三题", page: 1 }],
  })

  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const outputChunks: Buffer[] = []
  const errorChunks: Buffer[] = []
  stdout.on("data", (chunk) => outputChunks.push(Buffer.from(chunk)))
  stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)))

  let code = await runStudioQuestionCardsCli(
    [
      "question",
      "insert",
      "--user-id",
      fixture.userID,
      "--workroom-id",
      fixture.workroomID,
      "--question-number",
      "3",
      "--placement",
      "after",
      "--stem",
      "第三题后插入",
    ],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 0, Buffer.concat(errorChunks).toString("utf8"))
  outputChunks.length = 0
  errorChunks.length = 0

  code = await runStudioQuestionCardsCli(
    [
      "question",
      "insert",
      "--user-id",
      fixture.userID,
      "--workroom-id",
      fixture.workroomID,
      "--question-number",
      "1",
      "--placement",
      "before",
      "--stem",
      "第一题前插入",
    ],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 0, Buffer.concat(errorChunks).toString("utf8"))

  const listedCards = await StudioService.listQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
  })
  assert.deepEqual(
    listedCards.map((item) => item.text),
    ["第一题前插入", "第一题", "第二题", "第三题", "第三题后插入"],
  )
})

test("runStudioQuestionCardsCli rejects ambiguous target and out-of-range question number", async () => {
  const ambiguous = await createAmbiguousFixture()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const errorChunks: Buffer[] = []
  stderr.on("data", (chunk) => errorChunks.push(Buffer.from(chunk)))

  let code = await runStudioQuestionCardsCli(
    [
      "question",
      "create",
      "--user-id",
      ambiguous.userID,
      "--workroom-id",
      ambiguous.workroomID,
      "--stem",
      "无法确定目标",
    ],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 1)
  let parsed = JSON.parse(Buffer.concat(errorChunks).toString("utf8")) as {
    code: string
    detail: { totalDocuments?: number } | null
  }
  assert.equal(parsed.code, "TARGET_STUDIO_DOCUMENT_AMBIGUOUS")
  assert.equal(parsed.detail?.totalDocuments, 2)

  errorChunks.length = 0
  const fixture = await createFixture()
  await StudioService.appendQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    drafts: [{ text: "唯一题目", page: 1 }],
  })
  code = await runStudioQuestionCardsCli(
    [
      "question",
      "insert",
      "--user-id",
      fixture.userID,
      "--workroom-id",
      fixture.workroomID,
      "--question-number",
      "5",
      "--placement",
      "after",
      "--stem",
      "越界插入",
    ],
    { stdout: stdout as any, stderr: stderr as any },
  )
  assert.equal(code, 1)
  parsed = JSON.parse(Buffer.concat(errorChunks).toString("utf8")) as {
    code: string
    detail: { requested?: number; totalAvailable?: number } | null
  }
  assert.equal(parsed.code, "QUESTION_NUMBER_OUT_OF_RANGE")
  assert.equal(parsed.detail?.requested, 5)
  assert.equal(parsed.detail?.totalAvailable, 1)
})
