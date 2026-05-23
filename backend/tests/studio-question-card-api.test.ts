import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdirSync } from "node:fs"

process.env.LOCAL_SQLITE_PATH = path.join(process.cwd(), "tmp", "tests", "studio-question-card-api.db")

const { getLocalSqlite } = await import("../src/lib/local-sqlite")
const { WorkroomService } = await import("../src/domains/workrooms/service")
const { StudioService } = await import("../src/domains/studio/service")
const { QuestionsRepository } = await import("../src/domains/questions/repository")
const { insertQuestionByIntent } = await import("../src/domains/studio/question-write-service")

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

test("StudioService.appendQuestionCards appends cards and syncs projected questions", async () => {
  const fixture = await createFixture()

  const created = await StudioService.appendQuestionCards({
    ...fixture,
    drafts: [
      { text: "第一题", page: 1 },
      { text: "第二题", page: 2, canonicalAnswer: "B", explanation: "解析二", questionType: "单选题", difficulty: "medium", knowledgePoints: ["函数"] },
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

test("StudioService.insertQuestionCards inserts before/after anchor and keeps projection ordered", async () => {
  const fixture = await createFixture()
  const seed = await StudioService.appendQuestionCards({
    ...fixture,
    drafts: [{ text: "题一", page: 1 }, { text: "题二", page: 1 }],
  })

  const insertedBefore = await StudioService.insertQuestionCards({
    ...fixture,
    anchorCardID: seed[1].id,
    position: "before",
    drafts: [{ text: "插入前", page: 1 }],
  })
  const insertedAfter = await StudioService.insertQuestionCards({
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

test("StudioService.attachDerivedPracticeCards and writeQuestionExplanation persist derived relation and explanation", async () => {
  const fixture = await createFixture()
  const [source] = await StudioService.appendQuestionCards({
    ...fixture,
    drafts: [{ text: "原题", page: 1 }],
  })
  const practice = await StudioService.appendQuestionCards({
    ...fixture,
    drafts: [{ text: "练习1", page: 1 }, { text: "练习2", page: 1 }],
  })

  await StudioService.attachDerivedPracticeCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    sourceCardID: source.id,
    createdCardIDs: practice.map((item) => item.id),
  })
  await StudioService.writeQuestionExplanation({
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

test("StudioService.searchQuestionCards and getQuestionCardDetail expose compact summary and full learning detail", async () => {
  const fixture = await createFixture()
  const [card] = await StudioService.appendQuestionCards({
    ...fixture,
    drafts: [{ text: "第8题 二次函数求值", page: 3, answerText: "A", explanation: "解析", questionType: "单选题", difficulty: "easy", knowledgePoints: ["二次函数"] }],
  })

  const searchResults = await StudioService.searchQuestionCards({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    studioDocumentID: fixture.studioDocumentID,
    query: "第8题",
  })
  assert.equal(searchResults.length, 1)
  assert.equal(searchResults[0]?.cardID, card.id)
  assert.match(searchResults[0]?.stemPreview ?? "", /二次函数/)
  assert.equal(searchResults[0]?.questionType, "单选题")
  assert.equal(searchResults[0]?.difficulty, "easy")
  assert.equal(searchResults[0]?.masteryLevel, "unknown")

  const detail = await StudioService.getQuestionCardDetail({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    cardID: card.id,
  })
  assert.equal(detail.content.cardID, card.id)
  assert.equal(detail.content.answer, "A")
  assert.equal(detail.content.explanation, "解析")
  assert.equal(detail.content.questionType, "单选题")
  assert.equal(detail.content.difficulty, "easy")
  assert.deepEqual(detail.content.knowledgePoints, ["二次函数"])
  assert.equal(detail.learningProfile.problemCard.id, card.id)
  assert.ok(Array.isArray(detail.learningProfile.raw_recent_attempts))
  assert.ok(Array.isArray(detail.learningProfile.summaries.monthly_summaries))
})

test("insert reuses generation recommendation from learning state when fields are omitted", async () => {
  const fixture = await createFixture()
  const [seed] = await StudioService.appendQuestionCards({
    ...fixture,
    drafts: [{ text: "第1题 初始题干", page: 1, canonicalAnswer: "A" }],
  })
  const db = getLocalSqlite()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO question_card_learning_states
      (id, user_id, workroom_id, card_id, mastery_level, total_attempts, correct_attempts, consecutive_correct_count, last_attempt_at, last_review_at, unresolved_weaknesses_json, repeated_mistakes_json, progress_signal, progress_summary, generation_recommendation_json, updated_at, created_at)
      VALUES
      (@id, @user_id, @workroom_id, @card_id, 'basic', 3, 1, 0, @last_attempt_at, @last_review_at, '[]', '[]', 'stagnant', 'summary', @generation_recommendation_json, @updated_at, @created_at)`,
  ).run({
    id: "learning_state_test_seed",
    user_id: fixture.userID,
    workroom_id: fixture.workroomID,
    card_id: seed.id,
    last_attempt_at: now,
    last_review_at: now,
    generation_recommendation_json: JSON.stringify({
      recommended_difficulty: "easy",
      recommended_question_types: ["选择题"],
      recommended_knowledge_points: ["受迫振动"],
    }),
    updated_at: now,
    created_at: now,
  })

  const inserted = await insertQuestionByIntent({
    userID: fixture.userID,
    workroomID: fixture.workroomID,
    questionNumber: 1,
    placement: "after",
    stem: "后续训练题（不显式传题型难度）",
  })

  assert.ok(inserted.card.questionType)
  assert.ok(inserted.card.difficulty)
  assert.ok(Array.isArray(inserted.card.knowledgePoints))
  assert.ok(inserted.card.knowledgePoints.length > 0)
  assert.equal(inserted.card.questionType, "选择题")
  assert.equal(inserted.card.difficulty, "easy")
  assert.deepEqual(inserted.card.knowledgePoints, ["受迫振动"])
})
