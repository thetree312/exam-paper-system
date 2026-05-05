import { Hono } from "hono"
import { z } from "zod"
import { LearningArtifactsService } from "../domains/learning-artifacts/service"
import { requireAuth } from "./auth-context"

const linkageSchema = z.object({
  wikiPaths: z.array(z.string().min(1)).default([]),
  documentIDs: z.array(z.string().min(1)).default([]),
  documentBlocks: z
    .array(
      z.object({
        documentID: z.string().min(1),
        pageNumber: z.number().int().min(1),
        layoutUnitKey: z.string().min(1).optional(),
      }),
    )
    .default([]),
  agentSessionIDs: z.array(z.string().min(1)).default([]),
})

const questionCardSchema = z.object({
  workroomID: z.string().min(1),
  linkage: linkageSchema.optional(),
  payload: z.object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    answer: z.string().min(1),
    explanation: z.string().optional(),
  }),
})

const mindmapSchema = z.object({
  workroomID: z.string().min(1),
  linkage: linkageSchema.optional(),
  payload: z.object({
    title: z.string().min(1),
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        parentID: z.string().min(1).optional(),
      }),
    ),
    edges: z.array(
      z.object({
        id: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
      }),
    ),
  }),
})

const mindmapSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("document"),
    documentID: z.string().min(1),
    documentIDs: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal("wiki_file"),
    wikiPath: z.string().min(1),
    wikiPaths: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal("studio_document"),
    studioDocumentID: z.string().min(1),
  }),
])

const generateMindmapSchema = z.object({
  workroomID: z.string().min(1),
  source: mindmapSourceSchema,
  mode: z.enum(["knowledge_structure", "exam_review"]).default("knowledge_structure"),
  force: z.boolean().default(false),
})

const flashcardSchema = z.object({
  workroomID: z.string().min(1),
  linkage: linkageSchema.optional(),
  payload: z.object({
    title: z.string().min(1),
    front: z.string().min(1),
    back: z.string().min(1),
    hint: z.string().optional(),
    masteryState: z.enum(["new", "reviewing", "mastered", "struggling"]).optional(),
    bucket: z.number().int().min(0).nullable().optional(),
    lastScore: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable().optional(),
    nextReviewAt: z.string().nullable().optional(),
    lastReviewedAt: z.string().nullable().optional(),
    reviewCount: z.number().int().min(0).optional(),
  }),
})

const generateFlashcardsSchema = z.object({
  workroomID: z.string().min(1),
  documentID: z.string().min(1),
  maxCards: z.number().int().min(1).max(200).default(40),
  force: z.boolean().default(false),
})

const listQuerySchema = z.object({
  workroomID: z.string().min(1),
  type: z.enum(["question_card", "mindmap", "flashcard"]).optional(),
})

const artifactQuerySchema = z.object({
  workroomID: z.string().min(1),
})

const updateArtifactSchema = z.object({
  workroomID: z.string().min(1),
  linkage: linkageSchema.partial().optional(),
  payload: z.record(z.string(), z.any()).optional(),
})

const reviewFlashcardSchema = z.object({
  workroomID: z.string().min(1),
  score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
})

const dueFlashcardsQuerySchema = z.object({
  workroomID: z.string().min(1),
  documentID: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const flashcardStatsQuerySchema = z.object({
  workroomID: z.string().min(1),
  documentID: z.string().min(1).optional(),
})

const escalateFlashcardSchema = z.object({
  workroomID: z.string().min(1),
  userNote: z.string().optional(),
})

const currentMindmapQuerySchema = z.object({
  workroomID: z.string().min(1),
  documentID: z.string().min(1).optional(),
  documentIDs: z.array(z.string().min(1)).optional(),
  wikiPath: z.string().min(1).optional(),
  wikiPaths: z.array(z.string().min(1)).optional(),
  studioDocumentID: z.string().min(1).optional(),
})

export const learningArtifactsRoutes = new Hono()

learningArtifactsRoutes.get("/", async (c) => {
  const { user } = await requireAuth(c)
  const query = listQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    type: c.req.query("type") ?? undefined,
  })
  return c.json({
    items: await LearningArtifactsService.listByWorkroom({
      userID: user.id,
      workroomID: query.workroomID,
      type: query.type,
    }),
  })
})

learningArtifactsRoutes.post("/question-cards", async (c) => {
  const { user } = await requireAuth(c)
  const body = questionCardSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.createQuestionCard({
      userID: user.id,
      workroomID: body.workroomID,
      payload: body.payload,
      linkage: body.linkage,
    }),
    201,
  )
})

learningArtifactsRoutes.post("/mindmaps", async (c) => {
  const { user } = await requireAuth(c)
  const body = mindmapSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.createMindmap({
      userID: user.id,
      workroomID: body.workroomID,
      payload: body.payload,
      linkage: body.linkage,
    }),
    201,
  )
})

learningArtifactsRoutes.post("/mindmaps/generate", async (c) => {
  const { user } = await requireAuth(c)
  const body = generateMindmapSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.generateMindmap({
      userID: user.id,
      workroomID: body.workroomID,
      source: body.source,
      mode: body.mode,
      force: body.force,
    }),
  )
})

learningArtifactsRoutes.post("/flashcards", async (c) => {
  const { user } = await requireAuth(c)
  const body = flashcardSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.createFlashcard({
      userID: user.id,
      workroomID: body.workroomID,
      payload: body.payload,
      linkage: body.linkage,
    }),
    201,
  )
})

learningArtifactsRoutes.post("/flashcards/generate", async (c) => {
  const { user } = await requireAuth(c)
  const body = generateFlashcardsSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.generateFlashcards({
      userID: user.id,
      workroomID: body.workroomID,
      documentID: body.documentID,
      maxCards: body.maxCards,
      force: body.force,
    }),
  )
})

learningArtifactsRoutes.get("/flashcards/due", async (c) => {
  const { user } = await requireAuth(c)
  const query = dueFlashcardsQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    documentID: c.req.query("document_id") ?? undefined,
    limit: c.req.query("limit") ?? 50,
  })
  return c.json({
    items: await LearningArtifactsService.listDueFlashcards({
      userID: user.id,
      workroomID: query.workroomID,
      documentID: query.documentID,
      limit: query.limit,
    }),
  })
})

learningArtifactsRoutes.get("/flashcards/stats", async (c) => {
  const { user } = await requireAuth(c)
  const query = flashcardStatsQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    documentID: c.req.query("document_id") ?? undefined,
  })
  return c.json(
    await LearningArtifactsService.getFlashcardStats({
      userID: user.id,
      workroomID: query.workroomID,
      documentID: query.documentID,
    }),
  )
})

learningArtifactsRoutes.post("/flashcards/:artifactID/agent-escalate", async (c) => {
  const { user } = await requireAuth(c)
  const body = escalateFlashcardSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.escalateFlashcard({
      userID: user.id,
      workroomID: body.workroomID,
      artifactID: c.req.param("artifactID"),
      userNote: body.userNote,
    }),
  )
})

learningArtifactsRoutes.get("/mindmaps/current", async (c) => {
  const { user } = await requireAuth(c)
  const query = currentMindmapQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    documentID: c.req.query("document_id") ?? undefined,
    documentIDs: c.req.queries("document_id"),
    wikiPath: c.req.query("wiki_path") ?? undefined,
    wikiPaths: c.req.queries("wiki_path"),
    studioDocumentID: c.req.query("studio_document_id") ?? undefined,
  })
  const item = await LearningArtifactsService.getCurrentMindmap({
    userID: user.id,
    workroomID: query.workroomID,
    documentID: query.documentID,
    documentIDs: query.documentIDs,
    wikiPath: query.wikiPath,
    wikiPaths: query.wikiPaths,
    studioDocumentID: query.studioDocumentID,
  })
  return c.json(item)
})

learningArtifactsRoutes.put("/mindmaps/:artifactID", async (c) => {
  const { user } = await requireAuth(c)
  const body = mindmapSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.update({
      userID: user.id,
      workroomID: body.workroomID,
      artifactID: c.req.param("artifactID"),
      linkage: body.linkage,
      payload: body.payload,
    }),
  )
})

learningArtifactsRoutes.get("/:artifactID", async (c) => {
  const { user } = await requireAuth(c)
  const query = artifactQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
  })
  const item = await LearningArtifactsService.getByWorkroom({
    userID: user.id,
    workroomID: query.workroomID,
    artifactID: c.req.param("artifactID"),
  })
  if (!item) throw new Error(`Learning artifact not found: ${c.req.param("artifactID")}`)
  return c.json(item)
})

learningArtifactsRoutes.patch("/:artifactID", async (c) => {
  const { user } = await requireAuth(c)
  const body = updateArtifactSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.update({
      userID: user.id,
      workroomID: body.workroomID,
      artifactID: c.req.param("artifactID"),
      linkage: body.linkage,
      payload: body.payload,
    }),
  )
})

learningArtifactsRoutes.post("/:artifactID/review", async (c) => {
  const { user } = await requireAuth(c)
  const body = reviewFlashcardSchema.parse(await c.req.json())
  return c.json(
    await LearningArtifactsService.reviewFlashcard({
      userID: user.id,
      workroomID: body.workroomID,
      artifactID: c.req.param("artifactID"),
      score: body.score,
    }),
  )
})
