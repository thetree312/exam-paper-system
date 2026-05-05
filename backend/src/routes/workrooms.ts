import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { AuthService } from "../domains/auth/service"
import { DocumentsService } from "../domains/documents/service"
import { WorkroomService } from "../domains/workrooms/service"
import { requireAuth } from "./auth-context"

const createBody = z.object({
  name: z.string().min(1),
  rootDirectory: z.string().optional(),
})

const updateBody = z.object({
  name: z.string().min(1).optional(),
})

const readFileQuery = z.object({
  path: z.string().min(1),
})
const writeFileBody = z.object({
  path: z.string().min(1),
  content: z.string(),
})
const createFileBody = z.object({
  path: z.string().min(1),
  content: z.string().optional(),
})
const createDirectoryBody = z.object({
  path: z.string().min(1),
})
const movePathBody = z.object({
  fromPath: z.string().min(1),
  toPath: z.string().min(1),
})
const copyPathBody = z.object({
  fromPath: z.string().min(1),
  toPath: z.string().min(1),
})
const revealInOsBody = z.object({
  path: z.string().min(1),
})

const runtimeStateBody = z.object({
  active_file_id: z.string().min(1).nullable().optional(),
  active_session_id: z.string().min(1).nullable().optional(),
  active_tab_index: z.number().int().optional(),
  active_studio_document_id: z.string().min(1).nullable().optional(),
  active_agent_session_id: z.string().min(1).nullable().optional(),
  active_extraction_session_id: z.string().min(1).nullable().optional(),
  open_document_ids: z.array(z.string().min(1)).optional(),
  left_panel_state_json: z.record(z.string(), z.unknown()).optional(),
  center_panel_state_json: z.record(z.string(), z.unknown()).optional(),
  right_panel_state_json: z.record(z.string(), z.unknown()).optional(),
})

const bindSourceBody = z.object({
  documentID: z.string().min(1),
  sourcePackagePath: z.string().min(1),
  rawMarkdownPath: z.string().min(1),
})

const upsertArtifactBody = z.object({
  documentID: z.string().nullable().optional(),
  payloadJson: z.record(z.string(), z.unknown()),
})

export const workroomRoutes = new Hono()

async function buildWorkroomRecoveryPayload(userID: string, workroomID: string) {
  const [runtimeState, sources, artifacts, documents] = await Promise.all([
    WorkroomService.getRuntimeState({ userID, workroomID }),
    WorkroomService.listSources({ userID, workroomID }),
    WorkroomService.listArtifacts({ userID, workroomID }),
    DocumentsService.listByWorkroom({ userID, workroomID }),
  ])

  return {
    runtimeState,
    sources,
    artifacts,
    documents,
    restoration: {
      openDocumentIDs: runtimeState.open_document_ids ?? [],
      activeDocumentID: runtimeState.active_file_id ?? null,
      activeStudioDocumentID: runtimeState.active_studio_document_id ?? null,
      activeAgentSessionID: runtimeState.active_agent_session_id ?? null,
      activeExtractionSessionID: runtimeState.active_extraction_session_id ?? null,
    },
  }
}

workroomRoutes.get("/", async (c) => {
  const { user } = await requireAuth(c)
  return c.json({ items: await WorkroomService.listByUser(user.id) })
})

workroomRoutes.post("/", async (c) => {
  const { user } = await requireAuth(c)
  const body = createBody.parse(await c.req.json())
  const workroom = await WorkroomService.create({ userID: user.id, ...body })
  return c.json(workroom, 201)
})

workroomRoutes.get("/current", async (c) => {
  const { user } = await requireAuth(c)
  const payload = await WorkroomService.getCurrentPayload(user.id)
  return c.json({
    ...payload,
    ...(await buildWorkroomRecoveryPayload(user.id, payload.workroom.id)),
  })
})

workroomRoutes.get("/:workroomID/tree", async (c) => {
  const { user } = await requireAuth(c)
  return c.json({
    items: await WorkroomService.tree({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
    }),
  })
})

workroomRoutes.get("/:workroomID/tree-version", async (c) => {
  const { user } = await requireAuth(c)
  return c.json(
    await WorkroomService.treeVersion({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
    }),
  )
})

workroomRoutes.get("/:workroomID/tree-events", async (c) => {
  const tokenFromQuery = c.req.query("access_token")?.trim()
  const auth = tokenFromQuery
    ? await AuthService.resolveSession(tokenFromQuery)
    : await requireAuth(c)
  const workroomID = c.req.param("workroomID")

  // Pre-check authorization and existence.
  const workroom = await WorkroomService.getByUser(auth.user.id, workroomID)
  if (!workroom) throw new Error(`Workroom not found: ${workroomID}`)

  c.header("Cache-Control", "no-cache, no-transform")
  c.header("X-Accel-Buffering", "no")
  c.header("X-Content-Type-Options", "nosniff")

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "connected",
      data: JSON.stringify({
        type: "tree.connected",
        workroomID,
        at: new Date().toISOString(),
      }),
    })

    const unsubscribe = WorkroomService.subscribeTreeEvents(
      { userID: auth.user.id, workroomID },
      async (event) => {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      },
    )

    const heartbeat = setInterval(async () => {
      await stream.writeSSE({
        event: "heartbeat",
        data: JSON.stringify({ type: "tree.heartbeat", at: new Date().toISOString() }),
      })
    }, 15_000)

    // keep stream open until client disconnects
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribe()
        resolve()
      })
    })
  })
})

workroomRoutes.get("/:workroomID/file", async (c) => {
  const { user } = await requireAuth(c)
  const query = readFileQuery.parse({
    path: c.req.query("path"),
  })
  return c.json(
    await WorkroomService.readFile({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      workroomFilePath: query.path,
    }),
  )
})

workroomRoutes.put("/:workroomID/file", async (c) => {
  const { user } = await requireAuth(c)
  const body = writeFileBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.writeFile({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      workroomFilePath: body.path,
      content: body.content,
    }),
  )
})

workroomRoutes.post("/:workroomID/fs/file", async (c) => {
  const { user } = await requireAuth(c)
  const body = createFileBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.createFile({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      workroomFilePath: body.path,
      content: body.content ?? "",
    }),
    201,
  )
})

workroomRoutes.post("/:workroomID/fs/directory", async (c) => {
  const { user } = await requireAuth(c)
  const body = createDirectoryBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.createDirectory({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      workroomDirectoryPath: body.path,
    }),
    201,
  )
})

workroomRoutes.patch("/:workroomID/fs/path", async (c) => {
  const { user } = await requireAuth(c)
  const body = movePathBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.movePath({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      fromPath: body.fromPath,
      toPath: body.toPath,
    }),
  )
})

workroomRoutes.post("/:workroomID/fs/copy", async (c) => {
  const { user } = await requireAuth(c)
  const body = copyPathBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.copyPath({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      fromPath: body.fromPath,
      toPath: body.toPath,
    }),
  )
})

workroomRoutes.post("/:workroomID/fs/reveal-in-os", async (c) => {
  const { user } = await requireAuth(c)
  const body = revealInOsBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.revealInOs({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      workroomPath: body.path,
    }),
  )
})

workroomRoutes.delete("/:workroomID/fs/path", async (c) => {
  const { user } = await requireAuth(c)
  const query = readFileQuery.parse({ path: c.req.query("path") })
  return c.json(
    await WorkroomService.deletePath({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      workroomPath: query.path,
    }),
  )
})

workroomRoutes.get("/:workroomID", async (c) => {
  const { user } = await requireAuth(c)
  const workroom = await WorkroomService.getByUser(user.id, c.req.param("workroomID"))
  if (!workroom) throw new Error(`Workroom not found: ${c.req.param("workroomID")}`)
  return c.json({
    workroom,
    ...(await buildWorkroomRecoveryPayload(user.id, workroom.id)),
  })
})

workroomRoutes.patch("/:workroomID", async (c) => {
  const { user } = await requireAuth(c)
  const body = updateBody.parse(await c.req.json())
  const workroom = await WorkroomService.update({
    userID: user.id,
    workroomID: c.req.param("workroomID"),
    name: body.name,
  })
  return c.json(workroom)
})

workroomRoutes.put("/:workroomID/state", async (c) => {
  const { user } = await requireAuth(c)
  const body = runtimeStateBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.putRuntimeState({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      patch: body,
    }),
  )
})

workroomRoutes.get("/:workroomID/state", async (c) => {
  const { user } = await requireAuth(c)
  return c.json(
    await WorkroomService.getRuntimeState({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
    }),
  )
})

workroomRoutes.get("/:workroomID/sources", async (c) => {
  const { user } = await requireAuth(c)
  return c.json({
    items: await WorkroomService.listSources({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
    }),
  })
})

workroomRoutes.post("/:workroomID/sources", async (c) => {
  const { user } = await requireAuth(c)
  const body = bindSourceBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.bindSourceDocument({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      documentID: body.documentID,
      sourcePackagePath: body.sourcePackagePath,
      rawMarkdownPath: body.rawMarkdownPath,
    }),
    201,
  )
})

workroomRoutes.get("/:workroomID/artifacts/:artifactType/:artifactRefID", async (c) => {
  const { user } = await requireAuth(c)
  const item = await WorkroomService.getArtifact({
    userID: user.id,
    workroomID: c.req.param("workroomID"),
    artifactType: c.req.param("artifactType"),
    artifactRefID: c.req.param("artifactRefID"),
  })
  return c.json(item)
})

workroomRoutes.put("/:workroomID/artifacts/:artifactType/:artifactRefID", async (c) => {
  const { user } = await requireAuth(c)
  const body = upsertArtifactBody.parse(await c.req.json())
  return c.json(
    await WorkroomService.upsertArtifact({
      userID: user.id,
      workroomID: c.req.param("workroomID"),
      artifactType: c.req.param("artifactType"),
      artifactRefID: c.req.param("artifactRefID"),
      documentID: body.documentID,
      payloadJson: body.payloadJson,
    }),
  )
})

workroomRoutes.delete("/:workroomID", async (c) => {
  const { user } = await requireAuth(c)
  await WorkroomService.remove({
    userID: user.id,
    workroomID: c.req.param("workroomID"),
  })
  return c.json({
    workroomID: c.req.param("workroomID"),
    status: "deleted",
  })
})
