import { createID } from "../../lib/ids"
import { getLocalSqlite, parseJsonText } from "../../lib/local-sqlite"
import { StudioRepository } from "../studio/repository"
import { TaxonomyRepository } from "../taxonomies/repository"
import { QuestionsService } from "../questions/service"
import { FavoritesRepository } from "./repository"

const LOCAL_FAVORITES_HARD_LIMIT = 10_000

function normalizeTagIDs(input?: string[] | null) {
  return Array.from(new Set((input ?? []).map((item) => item.trim()).filter(Boolean)))
}

export const FavoritesService = {
  async quota(input: { userID: string }) {
    const used = (await FavoritesRepository.listByUser({ userID: input.userID })).length
    return {
      used,
      limit: LOCAL_FAVORITES_HARD_LIMIT,
      remaining: Math.max(0, LOCAL_FAVORITES_HARD_LIMIT - used),
    }
  },

  async isFavorited(input: { userID: string; questionID: string }) {
    return Boolean(await FavoritesRepository.findByUserAndQuestion(input))
  },

  async add(input: {
    userID: string
    questionID: string
    questionTypeID?: string | null
    subjectID?: string | null
    tagIDs?: string[] | null
  }) {
    const question = await QuestionsService.getByID({
      userID: input.userID,
      questionID: input.questionID,
    })
    if (!question) throw new Error(`Question not found: ${input.questionID}`)

    const existing = await FavoritesRepository.findByUserAndQuestion({
      userID: input.userID,
      questionID: input.questionID,
    })
    if (existing) throw new Error(`Question already favorited: ${input.questionID}`)

    const currentCount = (await FavoritesRepository.listByUser({ userID: input.userID })).length
    if (currentCount >= LOCAL_FAVORITES_HARD_LIMIT) {
      throw new Error("Favorite local storage limit exceeded")
    }

    if (input.questionTypeID) {
      const questionType = await TaxonomyRepository.findByID({
        userID: input.userID,
        taxonomyID: input.questionTypeID,
        kind: "question-type",
      })
      if (!questionType) throw new Error(`Question type not found: ${input.questionTypeID}`)
    }

    if (input.subjectID) {
      const subject = await TaxonomyRepository.findByID({
        userID: input.userID,
        taxonomyID: input.subjectID,
        kind: "subject",
      })
      if (!subject) throw new Error(`Subject not found: ${input.subjectID}`)
    }

    const tagIDs = normalizeTagIDs(input.tagIDs)
    for (const tagID of tagIDs) {
      const tag = await TaxonomyRepository.findByID({
        userID: input.userID,
        taxonomyID: tagID,
        kind: "tag",
      })
      if (!tag) throw new Error(`Tag not found: ${tagID}`)
    }

    const now = new Date().toISOString()
    return FavoritesRepository.insert({
      id: createID("favorite"),
      userID: input.userID,
      questionID: input.questionID,
      questionTypeID: input.questionTypeID ?? null,
      subjectID: input.subjectID ?? null,
      tagIDs,
      createdAt: now,
      updatedAt: now,
    })
  },

  async remove(input: { userID: string; questionID: string }) {
    await FavoritesRepository.remove(input)
  },

  async list(input: { userID: string; page: number; pageSize: number }) {
    const db = getLocalSqlite()
    const favorites = await FavoritesRepository.listByUser({ userID: input.userID })
    const studioCards = (await StudioRepository.readQuestionCards()).items.filter((item) => item.userID === input.userID)
    const offset = (input.page - 1) * input.pageSize
    const pageItems = favorites.slice(offset, offset + input.pageSize)

    const items = await Promise.all(
      pageItems.map(async (favorite) => {
        const question = await QuestionsService.getByID({
          userID: input.userID,
          questionID: favorite.questionID,
        })
        if (!question) throw new Error(`Question not found for favorite: ${favorite.id}`)

        const questionType = favorite.questionTypeID
          ? await TaxonomyRepository.findByID({
              userID: input.userID,
              taxonomyID: favorite.questionTypeID,
              kind: "question-type",
            })
          : null

        const subject = favorite.subjectID
          ? await TaxonomyRepository.findByID({
              userID: input.userID,
              taxonomyID: favorite.subjectID,
              kind: "subject",
            })
          : null

        const tags = (
          await Promise.all(
            favorite.tagIDs.map((tagID) =>
              TaxonomyRepository.findByID({
                userID: input.userID,
                taxonomyID: tagID,
                kind: "tag",
              }),
            ),
          )
        ).filter((item): item is NonNullable<typeof item> => Boolean(item))

        const studioQuestionCardID =
          studioCards.find(
            (card) =>
              card.workroomID === question.workroomID &&
              card.studioDocumentID === question.studioDocumentID &&
              card.sequenceIndex === question.sequenceIndex,
          )?.id ?? null
        let knowledgeTitle: string | null = null
        if (studioQuestionCardID) {
          const profile = db
            .prepare(
              `SELECT knowledge_points_json
               FROM question_card_knowledge_profiles
               WHERE user_id=@user_id AND card_id=@card_id
               ORDER BY first_generated_at ASC
               LIMIT 1`,
            )
            .get({
              user_id: input.userID,
              card_id: studioQuestionCardID,
            }) as { knowledge_points_json?: string | null } | null
          const points = parseJsonText<string[]>(String(profile?.knowledge_points_json ?? "[]"), [])
          knowledgeTitle = points.find((item) => item.trim().length > 0) ?? null
        }

        return {
          favorite,
          question,
          studioQuestionCardID,
          knowledgeTitle,
          questionType,
          subject,
          tags,
        }
      }),
    )

    return {
      total: favorites.length,
      items,
    }
  },
}
