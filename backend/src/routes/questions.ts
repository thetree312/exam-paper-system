import { Hono } from "hono"
import { z } from "zod"
import { QuestionGradingService } from "../domains/questions/grading-service"
import { QuestionSplitService } from "../domains/questions/split-service"
import { QuestionsService } from "../domains/questions/service"
import { requireAuth } from "./auth-context"

const createQuestionSchema = z.object({
  workroomID: z.string().min(1),
  studioDocumentID: z.string().min(1),
  sourceDocumentID: z.string().min(1).optional().nullable(),
  sequenceIndex: z.number().int().min(0),
  content: z.string().min(1),
  legendImages: z.array(z.string().min(1)).optional(),
  page: z.number().int().min(1).nullable().optional(),
  studentAnswer: z.string().optional().nullable(),
  canonicalAnswer: z.string().optional().nullable(),
  explanation: z.string().optional().nullable(),
  gradingJudgement: z.enum(["pending", "correct", "incorrect", "skipped", "uncertain", "error"]).optional().nullable(),
  gradingPredictedAnswer: z.string().optional().nullable(),
  gradingReasoning: z.string().optional().nullable(),
  gradingConfidence: z.number().min(0).max(1).optional().nullable(),
})

const updateQuestionSchema = z.object({
  content: z.string().min(1).optional(),
  legendImages: z.array(z.string().min(1)).optional(),
  page: z.number().int().min(1).nullable().optional(),
  studentAnswer: z.string().optional().nullable(),
  canonicalAnswer: z.string().optional().nullable(),
  explanation: z.string().optional().nullable(),
  gradingJudgement: z.enum(["pending", "correct", "incorrect", "skipped", "uncertain", "error"]).optional().nullable(),
  gradingPredictedAnswer: z.string().optional().nullable(),
  gradingReasoning: z.string().optional().nullable(),
  gradingConfidence: z.number().min(0).max(1).optional().nullable(),
})

const syncQuestionSchema = z.object({
  workroomID: z.string().min(1),
  studioDocumentID: z.string().min(1),
  sourceDocumentID: z.string().min(1).optional().nullable(),
  questionID: z.string().min(1).optional().nullable(),
  sequenceIndex: z.number().int().min(0),
  page: z.number().int().min(1).nullable().optional(),
  content: z.string().min(1),
  legendImages: z.array(z.string().min(1)).optional(),
  title: z.string().optional().nullable(),
  studentAnswer: z.string().optional().nullable(),
  canonicalAnswer: z.string().optional().nullable(),
  explanation: z.string().optional().nullable(),
  gradingJudgement: z.enum(["pending", "correct", "incorrect", "skipped", "uncertain", "error"]).optional().nullable(),
  gradingPredictedAnswer: z.string().optional().nullable(),
  gradingReasoning: z.string().optional().nullable(),
  gradingConfidence: z.number().min(0).max(1).optional().nullable(),
})

const gradingSchema = z.object({
  gradingJudgement: z.enum(["pending", "correct", "incorrect", "skipped", "uncertain", "error"]),
  gradingPredictedAnswer: z.string().optional().nullable(),
  gradingReasoning: z.string().optional().nullable(),
  gradingConfidence: z.number().min(0).max(1).optional().nullable(),
})

const splitSchema = z.object({
  workroomID: z.string().min(1),
  text: z.string().min(1),
  maxQuestions: z.number().int().min(1).max(200).default(20),
})

const gradeRunSchema = z.object({
  workroomID: z.string().min(1),
  studioDocumentID: z.string().min(1),
  sourceDocumentID: z.string().min(1).optional().nullable(),
  questions: z
    .array(
      z.object({
        sequenceIndex: z.number().int().min(0),
        content: z.string().min(1),
        userAnswer: z.string().optional().nullable(),
        canonicalAnswer: z.string().optional().nullable(),
      }),
    )
    .min(1),
})

export const questionsRoutes = new Hono()

questionsRoutes.get("/", async (c) => {
  const { user } = await requireAuth(c)
  const studioDocumentID = c.req.query("studio_document_id")
  if (!studioDocumentID) throw new Error("Missing studio_document_id")
  return c.json({
    items: await QuestionsService.listByStudioDocument({
      userID: user.id,
      studioDocumentID,
    }),
  })
})

questionsRoutes.post("/", async (c) => {
  const { user } = await requireAuth(c)
  const body = createQuestionSchema.parse(await c.req.json())
  return c.json(
    await QuestionsService.create({
      userID: user.id,
      workroomID: body.workroomID,
      studioDocumentID: body.studioDocumentID,
      sourceDocumentID: body.sourceDocumentID,
      sequenceIndex: body.sequenceIndex,
      content: body.content,
      legendImages: body.legendImages,
      page: body.page,
      studentAnswer: body.studentAnswer,
      canonicalAnswer: body.canonicalAnswer,
      explanation: body.explanation,
      gradingJudgement: body.gradingJudgement,
      gradingPredictedAnswer: body.gradingPredictedAnswer,
      gradingReasoning: body.gradingReasoning,
      gradingConfidence: body.gradingConfidence,
    }),
    201,
  )
})

questionsRoutes.post("/sync", async (c) => {
  const { user } = await requireAuth(c)
  const body = syncQuestionSchema.parse(await c.req.json())
  const result = await QuestionsService.sync({
    userID: user.id,
    workroomID: body.workroomID,
    studioDocumentID: body.studioDocumentID,
    sourceDocumentID: body.sourceDocumentID,
    questionID: body.questionID,
    sequenceIndex: body.sequenceIndex,
    page: body.page,
    content: body.content,
    legendImages: body.legendImages,
    title: body.title,
    studentAnswer: body.studentAnswer,
    canonicalAnswer: body.canonicalAnswer,
    explanation: body.explanation,
    gradingJudgement: body.gradingJudgement,
    gradingPredictedAnswer: body.gradingPredictedAnswer,
    gradingReasoning: body.gradingReasoning,
    gradingConfidence: body.gradingConfidence,
  })
  return c.json({
    studio_document_id: result.studioDocumentID,
    source_document_id: result.sourceDocumentID ?? null,
    question: {
      id: result.question.id,
      sequence_index: result.question.sequenceIndex,
    },
  })
})

questionsRoutes.post("/split", async (c) => {
  const { user } = await requireAuth(c)
  const body = splitSchema.parse(await c.req.json())
  return c.json({
    questions: await QuestionSplitService.split({
      userID: user.id,
      workroomID: body.workroomID,
      text: body.text,
      maxQuestions: body.maxQuestions,
    }),
  })
})

questionsRoutes.get("/snapshot/:studioDocumentID", async (c) => {
  const { user } = await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  const snapshot = await QuestionsService.snapshot({
    userID: user.id,
    workroomID,
    studioDocumentID: c.req.param("studioDocumentID"),
  })
  return c.json({
    studio_document_id: snapshot.studioDocumentID,
    source_document_id: snapshot.sourceDocumentID ?? null,
    title: snapshot.title,
    status: snapshot.status,
    questions: snapshot.questions.map((question) => ({
      id: question.id,
      sequenceIndex: question.sequenceIndex,
      groupId: null,
      page: question.page,
      content: question.content,
      legendImages: question.legendImages,
      studentAnswer: question.studentAnswer ?? null,
      canonicalAnswer: question.canonicalAnswer ?? null,
      gradingJudgement: question.gradingJudgement ?? null,
      gradingPredictedAnswer: question.gradingPredictedAnswer ?? null,
      gradingReasoning: question.gradingReasoning ?? null,
      gradingConfidence: question.gradingConfidence ?? null,
    })),
  })
})

questionsRoutes.post("/grade-run", async (c) => {
  const { user } = await requireAuth(c)
  const body = gradeRunSchema.parse(await c.req.json())
  const results = await QuestionGradingService.gradeRun({
    userID: user.id,
    workroomID: body.workroomID,
    studioDocumentID: body.studioDocumentID,
    sourceDocumentID: body.sourceDocumentID,
    questions: body.questions,
  })
  return c.json({
    results: results.map((item) => ({
      sequence_index: item.sequenceIndex,
      judgement: item.judgement,
      predicted_answer: item.predictedAnswer ?? null,
      reasoning: item.reasoning ?? null,
      confidence: item.confidence ?? null,
      error: item.error ?? null,
    })),
  })
})

questionsRoutes.get("/:questionID", async (c) => {
  const { user } = await requireAuth(c)
  const question = await QuestionsService.getByID({
    userID: user.id,
    questionID: c.req.param("questionID"),
  })
  if (!question) throw new Error(`Question not found: ${c.req.param("questionID")}`)
  return c.json(question)
})

questionsRoutes.patch("/:questionID", async (c) => {
  const { user } = await requireAuth(c)
  const body = updateQuestionSchema.parse(await c.req.json())
  return c.json(
    await QuestionsService.update({
      userID: user.id,
      questionID: c.req.param("questionID"),
      ...body,
    }),
  )
})

questionsRoutes.post("/:questionID/grading", async (c) => {
  const { user } = await requireAuth(c)
  const body = gradingSchema.parse(await c.req.json())
  return c.json(
    await QuestionsService.update({
      userID: user.id,
      questionID: c.req.param("questionID"),
      gradingJudgement: body.gradingJudgement,
      gradingPredictedAnswer: body.gradingPredictedAnswer,
      gradingReasoning: body.gradingReasoning,
      gradingConfidence: body.gradingConfidence,
    }),
  )
})

questionsRoutes.delete("/:questionID", async (c) => {
  const { user } = await requireAuth(c)
  await QuestionsService.remove({
    userID: user.id,
    questionID: c.req.param("questionID"),
  })
  return c.json({
    questionID: c.req.param("questionID"),
    status: "deleted",
  })
})
