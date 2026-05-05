import { Hono } from "hono"
import { z } from "zod"
import { FavoritesService } from "../domains/favorites/service"
import { requireAuth } from "./auth-context"

const addFavoriteSchema = z.object({
  questionID: z.string().min(1),
  questionTypeID: z.string().min(1).nullable().optional(),
  subjectID: z.string().min(1).nullable().optional(),
  tagIDs: z.array(z.string().min(1)).optional(),
})

export const favoritesRoutes = new Hono()

favoritesRoutes.get("/", async (c) => {
  const { user } = await requireAuth(c)
  const page = c.req.query("page") ? Number(c.req.query("page")) : 1
  const pageSize = c.req.query("page_size") ? Number(c.req.query("page_size")) : 20
  if (!Number.isInteger(page) || page < 1) throw new Error("Invalid page")
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error("Invalid page_size")

  const result = await FavoritesService.list({
    userID: user.id,
    page,
    pageSize,
  })

  return c.json({
    total: result.total,
    page,
    page_size: pageSize,
    items: result.items.map((item) => ({
      id: item.favorite.id,
      question_id: item.favorite.questionID,
      question: {
        id: item.question.id,
        document_id: item.question.sourceDocumentID ?? item.question.studioDocumentID,
        studio_document_id: item.question.studioDocumentID,
        source_document_id: item.question.sourceDocumentID ?? null,
        sequence_index: item.question.sequenceIndex,
        knowledge_title: item.knowledgeTitle,
        content: item.question.content,
        legend_images: item.question.legendImages,
        page: item.question.page,
        created_at: item.question.createdAt,
        updated_at: item.question.updatedAt,
      },
      studio_question_card_id: item.studioQuestionCardID,
      question_type: item.questionType
        ? {
            id: item.questionType.id,
            name: item.questionType.name,
            created_at: item.questionType.createdAt,
          }
        : null,
      subject: item.subject
        ? {
            id: item.subject.id,
            name: item.subject.name,
            created_at: item.subject.createdAt,
          }
        : null,
      tags: item.tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        created_at: tag.createdAt,
      })),
      created_at: item.favorite.createdAt,
    })),
  })
})

favoritesRoutes.get("/quota", async (c) => {
  const { user } = await requireAuth(c)
  const quota = await FavoritesService.quota({ userID: user.id })
  return c.json({
    used: quota.used,
    limit: quota.limit,
    remaining: quota.remaining,
  })
})

favoritesRoutes.post("/", async (c) => {
  const { user } = await requireAuth(c)
  const body = addFavoriteSchema.parse(await c.req.json())
  const favorite = await FavoritesService.add({
    userID: user.id,
    questionID: body.questionID,
    questionTypeID: body.questionTypeID,
    subjectID: body.subjectID,
    tagIDs: body.tagIDs,
  })
  return c.json(
    {
      id: favorite.id,
      question_id: favorite.questionID,
      question_type_id: favorite.questionTypeID ?? null,
      subject_id: favorite.subjectID ?? null,
      tag_ids: favorite.tagIDs,
      created_at: favorite.createdAt,
    },
    201,
  )
})

favoritesRoutes.get("/:questionID/check", async (c) => {
  const { user } = await requireAuth(c)
  return c.json({
    is_favorited: await FavoritesService.isFavorited({
      userID: user.id,
      questionID: c.req.param("questionID"),
    }),
  })
})

favoritesRoutes.delete("/:questionID", async (c) => {
  const { user } = await requireAuth(c)
  await FavoritesService.remove({
    userID: user.id,
    questionID: c.req.param("questionID"),
  })
  return c.json({ success: true })
})
