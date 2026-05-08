import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { PassThrough } from "node:stream"

process.env.LOCAL_SQLITE_PATH = path.join(process.cwd(), "tmp", "tests", "studio-question-card-cli.db")

const { getLocalSqlite } = await import("../src/lib/local-sqlite")
const { WorkroomService } = await import("../src/domains/workrooms/service")
const { StudioService } = await import("../src/domains/studio/service")
const { executeStudioQuestionCardsCommand, runStudioQuestionCardsCli } = await import("../src/cli/studio-question-cards")

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

beforeEach(() => {
  resetDb()
})

test("executeStudioQuestionCardsCommand dispatches append and insert", async () => {
  const fixture = await createFixture()
  const created = (await executeStudioQuestionCardsCommand("append", {
    ...fixture,
    drafts: [{ text: "原题一", page: 1 }, { text: "原题二", page: 1 }],
  })) as Array<{ id: string; sequenceIndex: number; text: string }>

  const inserted = (await executeStudioQuestionCardsCommand("insert", {
    ...fixture,
    anchorCardID: created[0].id,
    position: "after",
    drafts: [{ text: "插入练习题", page: 1 }],
  })) as Array<{ id: string; sequenceIndex: number; text: string }>

  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].sequenceIndex, 1)

  const listed = (await executeStudioQuestionCardsCommand("list-cards", fixture)) as Array<{
    text: string
    sequenceIndex: number
  }>
  assert.deepEqual(
    listed.map((item) => item.text),
    ["原题一", "插入练习题", "原题二"],
  )
  assert.deepEqual(
    listed.map((item) => item.sequenceIndex),
    [0, 1, 2],
  )
})

test("runStudioQuestionCardsCli supports stdin json and stdout response", async () => {
  const fixture = await createFixture()
  await executeStudioQuestionCardsCommand("append", {
    ...fixture,
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

  const code = await runStudioQuestionCardsCli(["list-cards"], {
    stdin: stdin as any,
    stdout: stdout as any,
    stderr: stderr as any,
  })

  const stderrText = Buffer.concat(errorChunks).toString("utf8")
  assert.equal(code, 0, stderrText)
  assert.equal(stderrText.trim(), "")

  const stdoutText = Buffer.concat(outputChunks).toString("utf8")
  const parsed = JSON.parse(stdoutText) as {
    ok: boolean
    command: string
    result: Array<{ text: string }>
  }
  assert.equal(parsed.ok, true)
  assert.equal(parsed.command, "list-cards")
  assert.equal(parsed.result.length, 1)
  assert.equal(parsed.result[0].text, "CLI 题一")
})
