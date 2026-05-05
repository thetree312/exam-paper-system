import { Hono } from "hono"
import { z } from "zod"
import { TaxonomyService } from "../domains/taxonomies/service"
import { requireAuth } from "./auth-context"

const createBody = z.object({
  name: z.string().min(1).max(100),
})

export const taxonomiesRoutes = new Hono()

function registerTaxonomyRoutes(path: string, kind: "subject" | "tag" | "question-type") {
  taxonomiesRoutes.get(`/${path}`, async (c) => {
    const { user } = await requireAuth(c)
    return c.json({
      items: await TaxonomyService.list({
        userID: user.id,
        kind,
      }),
    })
  })

  taxonomiesRoutes.post(`/${path}`, async (c) => {
    const { user } = await requireAuth(c)
    const body = createBody.parse(await c.req.json())
    return c.json(
      await TaxonomyService.getOrCreate({
        userID: user.id,
        kind,
        name: body.name,
      }),
      201,
    )
  })
}

registerTaxonomyRoutes("subjects", "subject")
registerTaxonomyRoutes("tags", "tag")
registerTaxonomyRoutes("question-types", "question-type")
