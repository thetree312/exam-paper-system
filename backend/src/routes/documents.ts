import { Hono } from "hono"
import { z } from "zod"
import { DocumentDomainError, DocumentsService } from "../domains/documents/service"
import { requireAuth } from "./auth-context"

const listQuerySchema = z.object({
  workroomID: z.string().min(1),
})

const previewQuerySchema = z.object({
  workroomID: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
})

const sourcePackageQuerySchema = z.object({
  workroomID: z.string().min(1),
})

const layoutQuerySchema = z.object({
  workroomID: z.string().min(1),
  page: z.coerce.number().int().min(1).optional(),
})

const selectionBodySchema = z
  .object({
    workroomID: z.string().min(1),
    pageNumber: z.coerce.number().int().min(1),
    bboxAbs: z
      .object({
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
      })
      .optional(),
    bboxNorm: z
      .object({
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
      })
      .optional(),
  })
  .refine((value) => Boolean(value.bboxAbs || value.bboxNorm), {
    message: "Either bboxAbs or bboxNorm is required",
    path: ["bboxAbs"],
  })

export const documentRoutes = new Hono()

function toDocumentErrorResponse(error: unknown) {
  if (error instanceof DocumentDomainError) {
    const status = [400, 404, 409, 500].includes(error.statusCode) ? error.statusCode : 500
    return {
      body: {
        error: error.message,
        code: error.code,
        retryable: error.retryable,
        ...(error.details ?? {}),
      },
      status: status as 400 | 404 | 409 | 500,
    }
  }
  const message = error instanceof Error ? error.message : "Document request failed"
  return {
    body: {
      error: message,
      code: "DOCUMENT_REQUEST_FAILED",
      retryable: false,
    },
    status: 500 as const,
  }
}

documentRoutes.get("/", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const query = listQuerySchema.parse({
      workroomID: c.req.query("workroom_id"),
    })

    return c.json({
      items: await DocumentsService.listByWorkroom({
        userID: user.id,
        workroomID: query.workroomID,
      }),
    })
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.post("/upload", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const form = await c.req.formData()
    const workroomID = String(form.get("workroomID") ?? form.get("workroom_id") ?? "").trim()
    if (!workroomID) throw new DocumentDomainError("Missing workroomID", "DOCUMENT_WORKROOM_REQUIRED", 400)

    const fileField = form.get("file")
    if (!(fileField instanceof File)) {
      throw new DocumentDomainError("Missing file", "DOCUMENT_FILE_REQUIRED", 400)
    }

    const content = Buffer.from(await fileField.arrayBuffer())
    const result = await DocumentsService.upload({
      userID: user.id,
      workroomID,
      fileName: fileField.name,
      mimeType: fileField.type || "application/octet-stream",
      content,
    })

    return c.json(result, 201)
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.get("/:documentID", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const query = sourcePackageQuerySchema.parse({
      workroomID: c.req.query("workroom_id"),
    })

    const item = await DocumentsService.getByWorkroom({
      userID: user.id,
      workroomID: query.workroomID,
      documentID: c.req.param("documentID"),
    })
    if (!item) {
      throw new DocumentDomainError(`Document not found: ${c.req.param("documentID")}`, "DOCUMENT_NOT_FOUND", 404)
    }
    return c.json(item)
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.get("/:documentID/source-package", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const query = sourcePackageQuerySchema.parse({
      workroomID: c.req.query("workroom_id"),
    })

    return c.json(
      await DocumentsService.readSourcePackage({
        userID: user.id,
        workroomID: query.workroomID,
        documentID: c.req.param("documentID"),
      }),
    )
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.get("/:documentID/source-markdown", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const query = sourcePackageQuerySchema.parse({
      workroomID: c.req.query("workroom_id"),
    })

    return c.json(
      await DocumentsService.readMarkdownSource({
        userID: user.id,
        workroomID: query.workroomID,
        documentID: c.req.param("documentID"),
      }),
    )
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.get("/:documentID/layout", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const query = layoutQuerySchema.parse({
      workroomID: c.req.query("workroom_id"),
      page: c.req.query("page") ?? undefined,
    })

    return c.json(
      await DocumentsService.readLayout({
        userID: user.id,
        workroomID: query.workroomID,
        documentID: c.req.param("documentID"),
        pageNumber: query.page,
      }),
    )
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.get("/:documentID/blocks", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const query = layoutQuerySchema.parse({
      workroomID: c.req.query("workroom_id"),
      page: c.req.query("page") ?? undefined,
    })

    return c.json(
      await DocumentsService.listBlocks({
        userID: user.id,
        workroomID: query.workroomID,
        documentID: c.req.param("documentID"),
        pageNumber: query.page,
      }),
    )
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.post("/:documentID/selection/resolve", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const body = selectionBodySchema.parse(await c.req.json())

    return c.json(
      await DocumentsService.resolveSelection({
        userID: user.id,
        workroomID: body.workroomID,
        documentID: c.req.param("documentID"),
        pageNumber: body.pageNumber,
        bboxAbs: body.bboxAbs,
        bboxNorm: body.bboxNorm,
      }),
    )
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})

documentRoutes.get("/:documentID/preview", async (c) => {
  try {
    const { user } = await requireAuth(c)
    const query = previewQuerySchema.parse({
      workroomID: c.req.query("workroom_id"),
      page: c.req.query("page") ?? 1,
    })

    const preview = await DocumentsService.readPreviewPage({
      userID: user.id,
      workroomID: query.workroomID,
      documentID: c.req.param("documentID"),
      page: query.page,
    })

    return new Response(preview.content, {
      status: 200,
      headers: {
        "content-type": preview.mimeType,
        "cache-control": "no-store",
      },
    })
  } catch (error) {
    const { body, status } = toDocumentErrorResponse(error)
    return c.json(body, { status })
  }
})
