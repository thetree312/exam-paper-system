import { Hono } from "hono"
import { z } from "zod"
import { WikiService } from "../domains/wiki/service"
import { requireAuth } from "./auth-context"

const workroomQuerySchema = z.object({
  workroomID: z.string().min(1),
})

const readFileQuerySchema = z.object({
  workroomID: z.string().min(1),
  path: z.string().min(1),
})

const writeFileSchema = z.object({
  workroomID: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
})

const searchQuerySchema = z.object({
  workroomID: z.string().min(1),
  query: z.string().min(1),
})

export const wikiRoutes = new Hono()

wikiRoutes.get("/tree", async (c) => {
  const { user } = await requireAuth(c)
  const query = workroomQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
  })
  return c.json({
    items: await WikiService.tree({
      userID: user.id,
      workroomID: query.workroomID,
    }),
  })
})

wikiRoutes.get("/summary", async (c) => {
  const { user } = await requireAuth(c)
  const query = workroomQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
  })
  return c.json(
    await WikiService.summary({
      userID: user.id,
      workroomID: query.workroomID,
    }),
  )
})

wikiRoutes.get("/version-summary", async (c) => {
  const { user } = await requireAuth(c)
  const query = workroomQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
  })
  return c.json(
    await WikiService.versionSummary({
      userID: user.id,
      workroomID: query.workroomID,
    }),
  )
})

wikiRoutes.get("/file", async (c) => {
  const { user } = await requireAuth(c)
  const query = readFileQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    path: c.req.query("path"),
  })
  return c.json(
    await WikiService.readFile({
      userID: user.id,
      workroomID: query.workroomID,
      wikiPath: query.path,
    }),
  )
})

wikiRoutes.put("/file", async (c) => {
  const { user } = await requireAuth(c)
  const body = writeFileSchema.parse(await c.req.json())
  return c.json(
    await WikiService.writeFile({
      userID: user.id,
      workroomID: body.workroomID,
      wikiPath: body.path,
      content: body.content,
    }),
  )
})

wikiRoutes.delete("/file", async (c) => {
  const { user } = await requireAuth(c)
  const query = readFileQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    path: c.req.query("path"),
  })
  return c.json(
    await WikiService.deleteFile({
      userID: user.id,
      workroomID: query.workroomID,
      wikiPath: query.path,
    }),
  )
})

wikiRoutes.get("/search", async (c) => {
  const { user } = await requireAuth(c)
  const query = searchQuerySchema.parse({
    workroomID: c.req.query("workroom_id"),
    query: c.req.query("query"),
  })
  return c.json({
    items: await WikiService.search({
      userID: user.id,
      workroomID: query.workroomID,
      query: query.query,
    }),
  })
})