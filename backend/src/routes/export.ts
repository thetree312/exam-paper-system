import { Hono } from "hono"
import { z } from "zod"
import { requireAuth } from "./auth-context"
import { ExportDomainService } from "../domains/export/service"

const exportQuestionSchema = z.object({
  index: z.number().int().min(1),
  markdown: z.string().min(1),
})

const exportWordSchema = z.object({
  title: z.string().optional(),
  templateKey: z.string().min(1).nullable().optional(),
  questions: z.array(exportQuestionSchema).min(1),
})

export const exportRoutes = new Hono()

exportRoutes.get("/templates", async (c) => {
  await requireAuth(c)
  return c.json({
    templates: await ExportDomainService.listTemplates(),
  })
})

exportRoutes.post("/word", async (c) => {
  await requireAuth(c)
  const body = exportWordSchema.parse(await c.req.json())
  const result = await ExportDomainService.exportWord(body)
  return new Response(result.file, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": result.contentDisposition,
    },
  })
})
