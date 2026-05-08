import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdirSync } from "node:fs"

process.env.LOCAL_SQLITE_PATH = path.join(process.cwd(), "tmp", "tests", "studio-question-card-api.db")

const { getLocalSqlite } = await import("../src/lib/local-sqlite")
const { WorkroomService } = await import("../src/domains/workrooms/service")
const { StudioService } = await import("../src/domains/studio/service")
const { QuestionsRepository } = await import("../src/domains/questions/repository")
const { StudioQuestionCardApi } = await import("../src/domains/studio/internal-api")

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
  const userID = "user-studio-api"
  const workroom = await WorkroomService.create({
    userID,
    name: "题卡 API 测试",
    rootDirectory: path.join(process.cwd(), "tmp", "tests", "workrooms", `studio-api-${Date.now()}`),
  })
  const document = await StudioService.createDocument({
    userID,
    workroomID: workroom.id,
    title: "测试题卡集",
  })
  return { userID, workroomID: workroom.id, studioDocumentID: document.id }
}

beforeEach(() => {
  resetDb()
})

test("appendStudioQuestionCards appends cards and syncs projected questions", async () => {
  const fixture = await createFixture()

  const created = await StudioQuestionCardApi.appendStudioQuestionCards({
    ...fixture,
    drafts: [
      { text: "第一题", page: 1 },
      { text: "第二题", page: 2, canonicalAnswer: "B", explanation: "解析二" },
    ],
  })

  assert.equal(created.length, 2)
  assert.deepEqual(
    created.map((item) => item.sequenceIndex),
    [0, 1],
  )

  const cards = await StudioService.listQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
  })
  assert.deepEqual(
    cards.map((item) => item.text),
    ["第一题", "第二题"],
  )

  const questions = await QuestionsRepository.listByStudioDocument({
    userID: fixture.userID,
    studioDocumentID: fixture.studioDocumentID,
  })
  assert.deepEqual(
    questions.map((item) => ({
      sequenceIndex: item.sequenceIndex,
      content: item.content,
      explanation: item.explanation,
      studioCardID: item.studioCardID,
    })),
    [
      {
        sequenceIndex: 0,
        content: "第一题",
        explanation: null,
        studioCardID: created[0].id,
      },
      {
        sequenceIndex: 1,
        content: "第二题",
        explanation: "解析二",
        studioCardID: created[1].id,
      },
    ],
  )
})

test("insertStudioQuestionCards inserts before/after anchor and keeps projection ordered", async () => {
  const fixture = await createFixture()
  const seed = await StudioQuestionCardApi.appendStudioQuestionCards({
    ...fixture,
    drafts: [{ text: "题一", page: 1 }, { text: "题二", page: 1 }],
  })

  const insertedBefore = await StudioQuestionCardApi.insertStudioQuestionCards({
    ...fixture,
    anchorCardID: seed[1].id,
    position: "before",
    drafts: [{ text: "插入前", page: 1 }],
  })
  const insertedAfter = await StudioQuestionCardApi.insertStudioQuestionCards({
    ...fixture,
    anchorCardID: seed[0].id,
    position: "after",
    drafts: [{ text: "插入后1", page: 1 }, { text: "插入后2", page: 1 }],
  })

  assert.equal(insertedBefore[0].sequenceIndex, 1)
  assert.deepEqual(
    insertedAfter.map((item) => item.sequenceIndex),
    [1, 2],
  )

  const cards = await StudioService.listQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
  })
  assert.deepEqual(
    cards.map((item) => item.text),
    ["题一", "插入后1", "插入后2", "插入前", "题二"],
  )
  assert.deepEqual(
    cards.map((item) => item.sequenceIndex),
    [0, 1, 2, 3, 4],
  )

  const questions = await QuestionsRepository.listByStudioDocument({
    userID: fixture.userID,
    studioDocumentID: fixture.studioDocumentID,
  })
  assert.deepEqual(
    questions.map((item) => item.content),
    ["题一", "插入后1", "插入后2", "插入前", "题二"],
  )
})

test("attachDerivedPracticeCards and writeStudioQuestionExplanation persist derived relation and explanation", async () => {
  const fixture = await createFixture()
  const [source] = await StudioQuestionCardApi.appendStudioQuestionCards({
    ...fixture,
    drafts: [{ text: "原题", page: 1 }],
  })
  const practice = await StudioQuestionCardApi.appendStudioQuestionCards({
    ...fixture,
    drafts: [{ text: "练习1", page: 1 }, { text: "练习2", page: 1 }],
  })

  await StudioQuestionCardApi.attachDerivedPracticeCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    sourceCardID: source.id,
    createdCardIDs: practice.map((item) => item.id),
  })
  await StudioQuestionCardApi.writeStudioQuestionExplanation({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    cardID: source.id,
    explanation: "这是原题讲解",
  })

  const sourceDetail = await StudioService.getQuestionCardDetail({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    cardID: source.id,
  })
  assert.equal(sourceDetail.card.explanation, "这是原题讲解")

  const cards = await StudioService.listQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
  })
  const practiceCards = cards.filter((item) => item.derivedFromCardID === source.id)
  assert.equal(practiceCards.length, 2)
  assert.ok(practiceCards.every((item) => item.relationType === "practice_generated"))

  const questions = await QuestionsRepository.listByStudioDocument({
    userID: fixture.userID,
    studioDocumentID: fixture.studioDocumentID,
  })
  const projectedSource = questions.find((item) => item.studioCardID === source.id)
  assert.equal(projectedSource?.explanation, "这是原题讲解")
})
