import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { watch, type FSWatcher } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { createID } from "../../lib/ids"
import {
  WorkroomRepository,
  defaultRuntimeState,
  deriveWorkroomDirectories,
} from "./repository"
import type {
  WorkroomCurrentPayload,
  WorkroomPanelArtifactRecord,
  WorkroomRecord,
  WorkroomRuntimeState,
  WorkroomSourceBindingRecord,
  WorkroomTreeItem,
  WorkroomTreeVersion,
} from "./types"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const backendRoot = path.join(repoRoot, "backend")
const workroomsBaseDirectory = path.join(backendRoot, "local-data", "workrooms")
const tempWorkroomsBaseDirectory = path.join(repoRoot, "temp")

function normalizePathForCompare(input: string) {
  return path.resolve(input).replace(/[\\/]+$/, "")
}

function isWithinDirectory(targetPath: string, baseDirectory: string) {
  const normalizedTarget = normalizePathForCompare(targetPath)
  const normalizedBase = normalizePathForCompare(baseDirectory)
  const relative = path.relative(normalizedBase, normalizedTarget)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizeWorkroomFilePath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized) throw new Error("Workroom file path is required")
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid workroom file path: ${input}`)
  }
  return normalized
}

function resolveInsideWorkroom(rootDirectory: string, workroomFilePath: string) {
  const normalized = normalizeWorkroomFilePath(workroomFilePath)
  const resolved = path.resolve(rootDirectory, normalized)
  const relative = path.relative(rootDirectory, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Workroom file path escapes boundary")
  }
  return {
    normalized,
    absolutePath: resolved,
  }
}

async function removeWorkroomDirectory(rootDirectory: string) {
  const normalizedRoot = normalizePathForCompare(rootDirectory)
  const allowedBases = [workroomsBaseDirectory, tempWorkroomsBaseDirectory]
  const isInAllowedBase = allowedBases.some((base) => isWithinDirectory(normalizedRoot, base))
  if (!isInAllowedBase) {
    throw new Error(`Refusing to delete directory outside workrooms boundary: ${normalizedRoot}`)
  }
  await rm(normalizedRoot, { recursive: true, force: true })
}

export type {
  WorkroomCurrentPayload,
  WorkroomPanelArtifactRecord,
  WorkroomRecord,
  WorkroomRuntimeState,
  WorkroomSourceBindingRecord,
  WorkroomTreeItem,
} from "./types"

async function collectWorkroomTree(rootDirectory: string, currentDirectory = rootDirectory): Promise<WorkroomTreeItem[]> {
  const entries = await readdir(currentDirectory, { withFileTypes: true })
  const items: WorkroomTreeItem[] = []
  const childDirectories: string[] = []

  const mapped = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(currentDirectory, entry.name)
      const info = await stat(absolutePath)
      const relativePath = path.relative(rootDirectory, absolutePath).replace(/\\/g, "/")
      const item: WorkroomTreeItem = {
        path: relativePath,
        type: entry.isDirectory() ? "directory" : "file",
        sizeBytes: info.size,
        updatedAt: info.mtime.toISOString(),
      }
      if (entry.isDirectory()) {
        childDirectories.push(absolutePath)
      }
      return item
    }),
  )

  items.push(...mapped)

  const nested = await Promise.all(childDirectories.map((directory) => collectWorkroomTree(rootDirectory, directory)))
  for (const chunk of nested) {
    items.push(...chunk)
  }

  return items.sort((a, b) => a.path.localeCompare(b.path))
}

type TreeCacheEntry = {
  workroomID: string
  rootDirectory: string
  items: WorkroomTreeItem[] | null
  dirty: boolean
  inFlight: Promise<WorkroomTreeItem[]> | null
  watcher: FSWatcher | null
}

const treeCacheByWorkroomID = new Map<string, TreeCacheEntry>()
const treeEventSubscribers = new Map<string, Set<(event: { type: "tree.changed"; workroomID: string; at: string }) => void>>()

function emitWorkroomTreeChanged(workroomID: string) {
  const subscribers = treeEventSubscribers.get(workroomID)
  if (!subscribers || subscribers.size === 0) return
  const event = {
    type: "tree.changed" as const,
    workroomID,
    at: new Date().toISOString(),
  }
  for (const callback of subscribers) {
    try {
      callback(event)
    } catch {
      // ignore subscriber errors
    }
  }
}

function closeTreeWatcher(entry: TreeCacheEntry) {
  if (!entry.watcher) return
  try {
    entry.watcher.close()
  } catch {
    // no-op
  }
  entry.watcher = null
}

function ensureTreeWatcher(entry: TreeCacheEntry) {
  if (entry.watcher) return
  try {
    entry.watcher = watch(entry.rootDirectory, { recursive: true }, () => {
      entry.dirty = true
      emitWorkroomTreeChanged(entry.workroomID)
    })
    entry.watcher.on("error", () => {
      entry.dirty = true
      emitWorkroomTreeChanged(entry.workroomID)
      closeTreeWatcher(entry)
    })
  } catch {
    // If watcher creation fails on current platform/runtime, keep fallback behavior.
    entry.watcher = null
  }
}

function getOrCreateTreeCacheEntry(workroomID: string, rootDirectory: string) {
  const existing = treeCacheByWorkroomID.get(workroomID)
  if (existing) {
    if (normalizePathForCompare(existing.rootDirectory) !== normalizePathForCompare(rootDirectory)) {
      closeTreeWatcher(existing)
      existing.rootDirectory = rootDirectory
      existing.items = null
      existing.dirty = true
      existing.inFlight = null
    }
    ensureTreeWatcher(existing)
    return existing
  }

  const created: TreeCacheEntry = {
    workroomID,
    rootDirectory,
    items: null,
    dirty: true,
    inFlight: null,
    watcher: null,
  }
  treeCacheByWorkroomID.set(workroomID, created)
  ensureTreeWatcher(created)
  return created
}

function invalidateWorkroomTreeCache(workroomID: string) {
  const entry = treeCacheByWorkroomID.get(workroomID)
  if (!entry) return
  entry.dirty = true
  emitWorkroomTreeChanged(workroomID)
}

function releaseWorkroomTreeCache(workroomID: string) {
  const entry = treeCacheByWorkroomID.get(workroomID)
  if (!entry) return
  closeTreeWatcher(entry)
  treeCacheByWorkroomID.delete(workroomID)
}

async function readWorkroomTreeWithCache(workroomID: string, rootDirectory: string) {
  const entry = getOrCreateTreeCacheEntry(workroomID, rootDirectory)
  if (!entry.dirty && entry.items) {
    return entry.items
  }
  if (entry.inFlight) {
    return entry.inFlight
  }

  entry.inFlight = collectWorkroomTree(rootDirectory)
    .then((items) => {
      entry.items = items
      entry.dirty = false
      return items
    })
    .finally(() => {
      entry.inFlight = null
    })

  return entry.inFlight
}

function buildWorkroomTreeVersion(workroomID: string, items: WorkroomTreeItem[]): WorkroomTreeVersion {
  const digest = createHash("sha256")
  for (const item of items) {
    digest.update(item.path)
    digest.update(item.type)
    digest.update(String(item.sizeBytes))
    digest.update(item.updatedAt)
  }
  return {
    workroomID,
    versionID: digest.digest("hex"),
    itemCount: items.length,
  }
}

export const WorkroomService = {
  subscribeTreeEvents(
    input: { userID: string; workroomID: string },
    callback: (event: { type: "tree.changed"; workroomID: string; at: string }) => void,
  ) {
    let active = true
    void this.getByUser(input.userID, input.workroomID).then((workroom) => {
      if (!active || !workroom) return
      // Ensure watcher exists for this workroom while subscribed.
      getOrCreateTreeCacheEntry(workroom.id, workroom.rootDirectory)
      const set = treeEventSubscribers.get(workroom.id) ?? new Set()
      set.add(callback)
      treeEventSubscribers.set(workroom.id, set)
    })

    return () => {
      active = false
      const set = treeEventSubscribers.get(input.workroomID)
      if (!set) return
      set.delete(callback)
      if (set.size === 0) {
        treeEventSubscribers.delete(input.workroomID)
      }
    }
  },

  async listByUser(userID: string) {
    const state = await WorkroomRepository.readIndex()
    return state.items.filter((item) => item.userID === userID)
  },

  async getByUser(userID: string, workroomID: string) {
    const state = await WorkroomRepository.readIndex()
    return state.items.find((item) => item.userID === userID && item.id === workroomID)
  },

  async getCurrentByUser(userID: string) {
    const items = await this.listByUser(userID)
    return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  },

  async tree(input: { userID: string; workroomID: string }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    return readWorkroomTreeWithCache(workroom.id, workroom.rootDirectory)
  },

  async treeVersion(input: { userID: string; workroomID: string }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const items = await readWorkroomTreeWithCache(workroom.id, workroom.rootDirectory)
    return buildWorkroomTreeVersion(workroom.id, items)
  },

  async readFile(input: { userID: string; workroomID: string; workroomFilePath: string }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const target = resolveInsideWorkroom(workroom.rootDirectory, input.workroomFilePath)
    const fileInfo = await stat(target.absolutePath)
    if (!fileInfo.isFile()) throw new Error(`Workroom path is not a regular file: ${target.normalized}`)
    const content = await readFile(target.absolutePath, "utf8")
    return {
      path: target.normalized,
      content,
      sizeBytes: fileInfo.size,
      updatedAt: fileInfo.mtime.toISOString(),
    }
  },

  async writeFile(input: {
    userID: string
    workroomID: string
    workroomFilePath: string
    content: string
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const target = resolveInsideWorkroom(workroom.rootDirectory, input.workroomFilePath)
    const fileInfo = await stat(target.absolutePath)
    if (!fileInfo.isFile()) throw new Error(`Workroom path is not a regular file: ${target.normalized}`)
    await writeFile(target.absolutePath, input.content, "utf8")
    invalidateWorkroomTreeCache(input.workroomID)
    return this.readFile({
      userID: input.userID,
      workroomID: input.workroomID,
      workroomFilePath: target.normalized,
    })
  },

  async createFile(input: {
    userID: string
    workroomID: string
    workroomFilePath: string
    content?: string
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const target = resolveInsideWorkroom(workroom.rootDirectory, input.workroomFilePath)
    await mkdir(path.dirname(target.absolutePath), { recursive: true })
    await writeFile(target.absolutePath, input.content ?? "", "utf8")
    invalidateWorkroomTreeCache(input.workroomID)
    return this.readFile({
      userID: input.userID,
      workroomID: input.workroomID,
      workroomFilePath: target.normalized,
    })
  },

  async createDirectory(input: {
    userID: string
    workroomID: string
    workroomDirectoryPath: string
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const target = resolveInsideWorkroom(workroom.rootDirectory, input.workroomDirectoryPath)
    await mkdir(target.absolutePath, { recursive: true })
    invalidateWorkroomTreeCache(input.workroomID)
    return {
      path: target.normalized,
      status: "created",
    }
  },

  async movePath(input: {
    userID: string
    workroomID: string
    fromPath: string
    toPath: string
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const fromTarget = resolveInsideWorkroom(workroom.rootDirectory, input.fromPath)
    const toTarget = resolveInsideWorkroom(workroom.rootDirectory, input.toPath)
    await mkdir(path.dirname(toTarget.absolutePath), { recursive: true })
    await rename(fromTarget.absolutePath, toTarget.absolutePath)
    invalidateWorkroomTreeCache(input.workroomID)
    return {
      fromPath: fromTarget.normalized,
      toPath: toTarget.normalized,
      status: "moved",
    }
  },

  async copyPath(input: {
    userID: string
    workroomID: string
    fromPath: string
    toPath: string
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const fromTarget = resolveInsideWorkroom(workroom.rootDirectory, input.fromPath)
    const toTarget = resolveInsideWorkroom(workroom.rootDirectory, input.toPath)
    await mkdir(path.dirname(toTarget.absolutePath), { recursive: true })
    await cp(fromTarget.absolutePath, toTarget.absolutePath, { recursive: true, force: false, errorOnExist: true })
    invalidateWorkroomTreeCache(input.workroomID)
    return {
      fromPath: fromTarget.normalized,
      toPath: toTarget.normalized,
      status: "copied",
    }
  },

  async revealInOs(input: { userID: string; workroomID: string; workroomPath: string }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const target = resolveInsideWorkroom(workroom.rootDirectory, input.workroomPath)
    return {
      path: target.normalized,
      supported: false,
      reason: "web_runtime_unsupported",
    }
  },

  async deletePath(input: {
    userID: string
    workroomID: string
    workroomPath: string
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    const target = resolveInsideWorkroom(workroom.rootDirectory, input.workroomPath)
    await rm(target.absolutePath, { recursive: true, force: false })
    invalidateWorkroomTreeCache(input.workroomID)
    return {
      path: target.normalized,
      status: "deleted",
    }
  },

  async create(input: { userID: string; name: string; rootDirectory?: string }) {
    const now = new Date().toISOString()
    const id = createID("workroom")
    const { rootDirectory, wikiDirectory } = deriveWorkroomDirectories({
      rootDirectory: input.rootDirectory,
      id,
    })

    await mkdir(rootDirectory, { recursive: true })
    await mkdir(wikiDirectory, { recursive: true })

    const record: WorkroomRecord = {
      id,
      userID: input.userID,
      name: input.name,
      rootDirectory,
      wikiDirectory,
      runtimeState: defaultRuntimeState(),
      createdAt: now,
      updatedAt: now,
    }

    await WorkroomRepository.updateIndex((state) => {
      state.items.push(record)
    })

    invalidateWorkroomTreeCache(record.id)

    return record
  },

  async getOrCreateCurrentByUser(userID: string) {
    const current = await this.getCurrentByUser(userID)
    if (current) return current
    return this.create({
      userID,
      name: "未命名工作间",
    })
  },

  async update(input: { userID: string; workroomID: string; name?: string }) {
    let updated: WorkroomRecord | undefined

    await WorkroomRepository.updateIndex((state) => {
      const item = state.items.find((entry) => entry.userID === input.userID && entry.id === input.workroomID)
      if (!item) throw new Error(`Workroom not found: ${input.workroomID}`)
      if (input.name !== undefined) item.name = input.name
      item.updatedAt = new Date().toISOString()
      updated = item
    })

    if (!updated) throw new Error(`Workroom not found: ${input.workroomID}`)
    invalidateWorkroomTreeCache(input.workroomID)
    return updated
  },

  async remove(input: { userID: string; workroomID: string }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)

    await removeWorkroomDirectory(workroom.rootDirectory)

    let removed = false

    await WorkroomRepository.updateIndex((state) => {
      state.items = state.items.filter((item) => {
        const keep = !(item.userID === input.userID && item.id === input.workroomID)
        if (!keep) removed = true
        return keep
      })
    })

    if (!removed) throw new Error(`Workroom not found: ${input.workroomID}`)

    await WorkroomRepository.updateSourceBindings((state) => {
      state.items = state.items.filter(
        (item) => !(item.userID === input.userID && item.workroomID === input.workroomID),
      )
    })

    await WorkroomRepository.updatePanelArtifacts((state) => {
      state.items = state.items.filter(
        (item) => !(item.userID === input.userID && item.workroomID === input.workroomID),
      )
    })

    releaseWorkroomTreeCache(input.workroomID)
  },

  async getRuntimeState(input: { userID: string; workroomID: string }) {
    const record = await this.getByUser(input.userID, input.workroomID)
    if (!record) throw new Error(`Workroom not found: ${input.workroomID}`)
    return record.runtimeState ?? defaultRuntimeState()
  },

  async putRuntimeState(input: {
    userID: string
    workroomID: string
    patch: Partial<WorkroomRuntimeState>
  }) {
    let nextState: WorkroomRuntimeState | undefined
    await WorkroomRepository.updateIndex((state) => {
      const item = state.items.find((entry) => entry.userID === input.userID && entry.id === input.workroomID)
      if (!item) throw new Error(`Workroom not found: ${input.workroomID}`)
      item.runtimeState = WorkroomRepository.mergeRuntimeState(item.runtimeState, input.patch)
      item.updatedAt = new Date().toISOString()
      nextState = item.runtimeState
    })
    if (!nextState) throw new Error(`Workroom not found: ${input.workroomID}`)
    return nextState
  },

  async rememberOpenDocument(input: { userID: string; workroomID: string; documentID: string }) {
    const current = await this.getRuntimeState({
      userID: input.userID,
      workroomID: input.workroomID,
    })
    const nextOpenDocumentIDs = [
      input.documentID,
      ...(current.open_document_ids ?? []).filter((item) => item !== input.documentID),
    ]

    return this.putRuntimeState({
      userID: input.userID,
      workroomID: input.workroomID,
      patch: {
        active_file_id: input.documentID,
        active_session_id: input.documentID,
        active_extraction_session_id: input.documentID,
        open_document_ids: nextOpenDocumentIDs,
      },
    })
  },

  async listSources(input: { userID: string; workroomID: string }) {
    const state = await WorkroomRepository.readSourceBindings()
    return state.items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID && item.isActive)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  },

  async bindSourceDocument(input: {
    userID: string
    workroomID: string
    documentID: string
    sourcePackagePath: string
    rawMarkdownPath: string
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)

    let binding: WorkroomSourceBindingRecord | undefined
    await WorkroomRepository.updateSourceBindings((state) => {
      const existing = state.items.find(
        (item) =>
          item.userID === input.userID &&
          item.workroomID === input.workroomID &&
          item.documentID === input.documentID,
      )
      if (existing) {
        existing.isActive = true
        existing.sourcePackagePath = input.sourcePackagePath
        existing.rawMarkdownPath = input.rawMarkdownPath
        existing.updatedAt = new Date().toISOString()
        binding = existing
        return
      }
      const created = WorkroomRepository.createSourceBinding(input)
      state.items.push(created)
      binding = created
    })

    await this.putRuntimeState({
      userID: input.userID,
      workroomID: input.workroomID,
      patch: {
        active_studio_document_id: null,
      },
    })

    invalidateWorkroomTreeCache(input.workroomID)

    if (!binding) throw new Error(`Failed to bind source document: ${input.documentID}`)
    return binding
  },

  async listArtifacts(input: { userID: string; workroomID: string }) {
    const state = await WorkroomRepository.readPanelArtifacts()
    return state.items
      .filter((item) => item.userID === input.userID && item.workroomID === input.workroomID)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  },

  async getArtifact(input: {
    userID: string
    workroomID: string
    artifactType: string
    artifactRefID: string
  }) {
    const state = await WorkroomRepository.readPanelArtifacts()
    return (
      state.items
        .filter(
          (item) =>
            item.userID === input.userID &&
            item.workroomID === input.workroomID &&
            item.artifactType === input.artifactType &&
            item.artifactRefID === input.artifactRefID,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    )
  },

  async upsertArtifact(input: {
    userID: string
    workroomID: string
    artifactType: string
    artifactRefID: string
    documentID?: string | null
    payloadJson: Record<string, unknown>
  }) {
    const workroom = await this.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)

    let artifact: WorkroomPanelArtifactRecord | undefined
    await WorkroomRepository.updatePanelArtifacts((state) => {
      const existing = state.items.find(
        (item) =>
          item.userID === input.userID &&
          item.workroomID === input.workroomID &&
          item.artifactType === input.artifactType &&
          item.artifactRefID === input.artifactRefID,
      )
      if (existing) {
        existing.documentID = input.documentID ?? null
        existing.payloadJson = input.payloadJson
        existing.updatedAt = new Date().toISOString()
        artifact = existing
        return
      }
      const created = WorkroomRepository.createPanelArtifact(input)
      state.items.push(created)
      artifact = created
    })

    if (!artifact) throw new Error(`Failed to upsert workroom artifact: ${input.artifactRefID}`)
    return artifact
  },

  async getCurrentPayload(userID: string): Promise<WorkroomCurrentPayload> {
    const workroom = await this.getOrCreateCurrentByUser(userID)
    return {
      workroom,
      runtimeState: workroom.runtimeState ?? defaultRuntimeState(),
      sources: await this.listSources({
        userID,
        workroomID: workroom.id,
      }),
      artifacts: await this.listArtifacts({
        userID,
        workroomID: workroom.id,
      }),
    }
  },
}
