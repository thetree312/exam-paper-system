import { Hono } from "hono"
import { z } from "zod"
import { requireAuth } from "./auth-context"
import { TRANSLATION_SCOPES } from "../domains/translation/types"
import { TranslationDomainService, TranslationQuotaError } from "../domains/translation/service"

const lookupSchema = z.object({
  text: z.string().min(1),
  scope: z.enum(TRANSLATION_SCOPES),
})

const mathSchema = z.object({
  text: z.string().min(1),
})

export const translationRoutes = new Hono()

translationRoutes.post("/lookup", async (c) => {
  const { user } = await requireAuth(c)
  const body = lookupSchema.parse(await c.req.json())

  try {
    return c.json(
      await TranslationDomainService.lookup({
        userID: user.id,
        text: body.text,
        scope: body.scope,
      }),
    )
  } catch (error) {
    if (error instanceof TranslationQuotaError) {
      return c.json(
        {
          error: error.message,
          quota: error.quota,
        },
        429,
      )
    }
    throw error
  }
})

translationRoutes.post("/math", async (c) => {
  const { user } = await requireAuth(c)
  const body = mathSchema.parse(await c.req.json())
  return c.json(
    await TranslationDomainService.translateMath({
      userID: user.id,
      text: body.text,
    }),
  )
})
