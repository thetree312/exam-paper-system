import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { WorkroomService, type WorkroomRecord } from "../workrooms/service"

export type WikiTreeItem = {
  path: string
  type: "file" | "directory"
  sizeBytes: number
  updatedAt: string
}

export type WikiFileRecord = {
  path: string
  sizeBytes: number
  sha256: string
  updatedAt: string
  content?: string
}

function normalizeWikiPath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "")
  if (!normalized) throw new Error("Wiki path is required")
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid wiki path: ${input}`)
  }
  return normalized
}

function resolveInsideWiki(workroom: WorkroomRecord, wikiPath: string) {
  const normalized = normalizeWikiPath(wikiPath)
  const resolved = path.resolve(workroom.wikiDirectory, normalized)
  const relative = path.relative(workroom.wikiDirectory, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Wiki path escapes workroom/wiki boundary")
  }
  return {
    normalized,
    absolutePath: resolved,
  }
}

async function hashFile(filepath: string) {
  const content = await readFile(filepath)
  return createHash("sha256").update(content).digest("hex")
}

async function collectTree(rootDirectory: string, currentDirectory = rootDirectory): Promise<WikiTreeItem[]> {
  const entries = await readdir(currentDirectory, { withFileTypes: true })
  const items: WikiTreeItem[] = []

  for (const entry of entries) {
    const absolutePath = path.join(currentDirectory, entry.name)
    const info = await stat(absolutePath)
    const relativePath = path.relative(rootDirectory, absolutePath).replace(/\\/g, "/")
    items.push({
      path: relativePath,
      type: entry.isDirectory() ? "directory" : "file",
      sizeBytes: info.size,
      updatedAt: info.mtime.toISOString(),
    })
    if (entry.isDirectory()) {
      items.push(...(await collectTree(rootDirectory, absolutePath)))
    }
  }

  return items.sort((a, b) => a.path.localeCompare(b.path))
}

async function collectFiles(workroom: WorkroomRecord) {
  const tree = await collectTree(workroom.wikiDirectory)
  const files = tree.filter((item) => item.type === "file")
  const detailed: WikiFileRecord[] = []
  for (const item of files) {
    const absolutePath = path.join(workroom.wikiDirectory, item.path)
    detailed.push({
      path: item.path,
      sizeBytes: item.sizeBytes,
      sha256: await hashFile(absolutePath),
      updatedAt: item.updatedAt,
    })
  }
  return detailed
}

export const WikiService = {
  async requireWorkroom(input: { userID: string; workroomID: string }) {
    const workroom = await WorkroomService.getByUser(input.userID, input.workroomID)
    if (!workroom) throw new Error(`Workroom not found: ${input.workroomID}`)
    return workroom
  },

  async tree(input: { userID: string; workroomID: string }) {
    const workroom = await this.requireWorkroom(input)
    return collectTree(workroom.wikiDirectory)
  },

  async summary(input: { userID: string; workroomID: string }) {
    const workroom = await this.requireWorkroom(input)
    const tree = await collectTree(workroom.wikiDirectory)
    const files = tree.filter((item) => item.type === "file")
    const directories = tree.filter((item) => item.type === "directory")
    return {
      workroomID: workroom.id,
      wikiDirectory: workroom.wikiDirectory,
      fileCount: files.length,
      directoryCount: directories.length,
      totalSizeBytes: files.reduce((sum, item) => sum + item.sizeBytes, 0),
      latestUpdateAt: files.map((item) => item.updatedAt).sort().at(-1) ?? null,
    }
  },

  async versionSummary(input: { userID: string; workroomID: string }) {
    const workroom = await this.requireWorkroom(input)
    const files = await collectFiles(workroom)
    const digest = createHash("sha256")
    for (const file of files) {
      digest.update(file.path)
      digest.update(file.sha256)
      digest.update(file.updatedAt)
    }
    return {
      workroomID: workroom.id,
      versionID: digest.digest("hex"),
      fileCount: files.length,
      files,
    }
  },

  async readFile(input: { userID: string; workroomID: string; wikiPath: string }) {
    const workroom = await this.requireWorkroom(input)
    const target = resolveInsideWiki(workroom, input.wikiPath)
    const fileInfo = await stat(target.absolutePath)
    if (!fileInfo.isFile()) throw new Error(`Wiki file is not a regular file: ${target.normalized}`)
    const content = await readFile(target.absolutePath, "utf8")
    return {
      path: target.normalized,
      content,
      sizeBytes: fileInfo.size,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      updatedAt: fileInfo.mtime.toISOString(),
    }
  },

  async writeFile(input: { userID: string; workroomID: string; wikiPath: string; content: string }) {
    const workroom = await this.requireWorkroom(input)
    const target = resolveInsideWiki(workroom, input.wikiPath)
    await mkdir(path.dirname(target.absolutePath), { recursive: true })
    await writeFile(target.absolutePath, input.content, "utf8")
    return this.readFile({
      userID: input.userID,
      workroomID: input.workroomID,
      wikiPath: target.normalized,
    })
  },

  async deleteFile(input: { userID: string; workroomID: string; wikiPath: string }) {
    const workroom = await this.requireWorkroom(input)
    const target = resolveInsideWiki(workroom, input.wikiPath)
    await rm(target.absolutePath, { force: false })
    return {
      path: target.normalized,
      status: "deleted",
    }
  },

  async search(input: { userID: string; workroomID: string; query: string }) {
    const workroom = await this.requireWorkroom(input)
    const files = await collectFiles(workroom)
    const normalizedQuery = input.query.trim().toLowerCase()
    if (!normalizedQuery) throw new Error("Wiki search query is required")

    const matches: Array<{
      path: string
      matchedIn: Array<"path" | "content">
      snippet: string | null
    }> = []

    for (const file of files) {
      const absolutePath = path.join(workroom.wikiDirectory, file.path)
      const content = await readFile(absolutePath, "utf8")
      const matchedIn: Array<"path" | "content"> = []
      if (file.path.toLowerCase().includes(normalizedQuery)) matchedIn.push("path")
      const lowerContent = content.toLowerCase()
      if (lowerContent.includes(normalizedQuery)) matchedIn.push("content")
      if (matchedIn.length === 0) continue

      const matchIndex = lowerContent.indexOf(normalizedQuery)
      const snippet =
        matchIndex >= 0
          ? content.slice(Math.max(0, matchIndex - 80), Math.min(content.length, matchIndex + normalizedQuery.length + 80))
          : null

      matches.push({
        path: file.path,
        matchedIn,
        snippet,
      })
    }

    return matches
  },
}