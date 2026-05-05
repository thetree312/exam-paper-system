import { Hono } from "hono"
import { z } from "zod"
import { StudioService } from "../domains/studio/service"
import { requireAuth } from "./auth-context"

const listDocumentsQuerySchema = z.object({
  workroomID: z.string().min(1),
  sourceDocumentID: z.string().min(1).optional(),
})

const createDocumentSchema = z.object({
  workroomID: z.string().min(1),
  title: z.string().trim().optional().nullable(),
  sourceDocumentID: z.string().min(1).optional().nullable(),
})

const listQuestionCardsQuerySchema = z.object({
  workroomID: z.string().min(1),
  studioDocumentID: z.string().min(1),
})

const normalizedRegionSchema = z.object({
  page: z.number().int().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
})

const selectionRegionSchema = normalizedRegionSchema.extend({
  exclusions: z.array(normalizedRegionSchema.omit({ page: true })).optional(),
})

const legendRegionSchema = normalizedRegionSchema

const recognizeSelectionSchema = z.object({
  workroomID: z.string().min(1),
  sourceDocumentID: z.string().min(1),
  studioDocumentID: z.string().min(1).optional().nullable(),
  title: z.string().trim().optional().nullable(),
  regions: z.array(selectionRegionSchema).min(1),
  legends: z.array(legendRegionSchema).optional(),
})

const importFromLayoutSchema = z.object({
  workroomID: z.string().min(1),
  sourceDocumentID: z.string().min(1),
  studioDocumentID: z.string().min(1).optional().nullable(),
  title: z.string().trim().optional().nullable(),
  replaceExisting: z.boolean().optional(),
})

const updateQuestionCardSchema = z
  .object({
    text: z.string().optional(),
    answerContent: z.record(z.string(), z.unknown()).optional(),
    answerText: z.string().optional(),
    legendImages: z.array(z.string().min(1)).optional(),
  })
  .refine((value) => value.text !== undefined || value.answerContent !== undefined || value.answerText !== undefined || value.legendImages !== undefined, {
    message: "At least one field must be provided",
  })

const submitAttemptSchema = z.object({
  workroomID: z.string().min(1),
  answerText: z.string().min(1),
})

export const studioRoutes = new Hono()

studioRoutes.get("/documents", async (c) => {
  const { user } = await requireAuth(c)
  const query = listDocumentsQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    sourceDocumentID: c.req.query("source_document_id") ?? undefined,
  })

  return c.json({
    items: await StudioService.listDocuments({
      userID: user.id,
      workroomID: query.workroomID,
      sourceDocumentID: query.sourceDocumentID,
    }),
  })
})

studioRoutes.post("/documents", async (c) => {
  const { user } = await requireAuth(c)
  const body = createDocumentSchema.parse(await c.req.json())

  return c.json(
    await StudioService.createDocument({
      userID: user.id,
      workroomID: body.workroomID,
      title: body.title,
      sourceDocumentID: body.sourceDocumentID,
    }),
    201,
  )
})

studioRoutes.get("/question-cards", async (c) => {
  const { user } = await requireAuth(c)
  const query = listQuestionCardsQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    studioDocumentID: c.req.query("studio_document_id"),
  })

  return c.json({
    items: await StudioService.listQuestionCards({
      userID: user.id,
      workroomID: query.workroomID,
      studioDocumentID: query.studioDocumentID,
    }),
  })
})

studioRoutes.get("/question-cards/:cardID/detail", async (c) => {
  const { user } = await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")
  return c.json(
    await StudioService.getQuestionCardDetail({
      userID: user.id,
      workroomID,
      cardID: c.req.param("cardID"),
    }),
  )
})

studioRoutes.post("/question-cards/recognize-selection", async (c) => {
  const { user } = await requireAuth(c)
  const body = recognizeSelectionSchema.parse(await c.req.json())

  return c.json(
    await StudioService.recognizeSelection({
      userID: user.id,
      workroomID: body.workroomID,
      sourceDocumentID: body.sourceDocumentID,
      studioDocumentID: body.studioDocumentID,
      title: body.title,
      regions: body.regions,
      legends: body.legends ?? [],
    }),
    201,
  )
})

studioRoutes.post("/question-cards/import-from-layout", async (c) => {
  const { user } = await requireAuth(c)
  const body = importFromLayoutSchema.parse(await c.req.json())

  return c.json(
    await StudioService.importFromLayout({
      userID: user.id,
      workroomID: body.workroomID,
      sourceDocumentID: body.sourceDocumentID,
      studioDocumentID: body.studioDocumentID,
      title: body.title,
      replaceExisting: body.replaceExisting ?? false,
    }),
    201,
  )
})

studioRoutes.patch("/question-cards/:cardID", async (c) => {
  const { user } = await requireAuth(c)
  const body = updateQuestionCardSchema.parse(await c.req.json())
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")

  return c.json(
    await StudioService.updateQuestionCard({
      userID: user.id,
      workroomID,
      cardID: c.req.param("cardID"),
      text: body.text,
      answerContent: body.answerContent as any,
      answerText: body.answerText,
      legendImages: body.legendImages,
    }),
  )
})

studioRoutes.delete("/question-cards/:cardID", async (c) => {
  const { user } = await requireAuth(c)
  const workroomID = String(c.req.query("workroom_id") ?? "").trim()
  if (!workroomID) throw new Error("Missing workroom_id")

  return c.json(
    await StudioService.deleteQuestionCard({
      userID: user.id,
      workroomID,
      cardID: c.req.param("cardID"),
    }),
  )
})

studioRoutes.post("/question-cards/:cardID/attempts", async (c) => {
  const { user } = await requireAuth(c)
  const body = submitAttemptSchema.parse(await c.req.json())
  return c.json(
    await StudioService.submitAttempt({
      userID: user.id,
      workroomID: body.workroomID,
      cardID: c.req.param("cardID"),
      answerText: body.answerText,
    }),
    201,
  )
})
