import { loadBackendEnv } from "../lib/load-env"
import { readFile, unlink } from "node:fs/promises"

loadBackendEnv()

type CliIO = {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
}

type CliCommand =
  | "launch"
  | "append-block"
  | "complete"
  | "answer"
  | "render-html"
  | "render-html-patch"

function printUsage(stderr: NodeJS.WriteStream) {
  stderr.write(
    [
      "Usage: bun backend/src/cli/lecture.ts <command>",
      "Commands: launch | append-block | complete | answer | render-html | render-html-patch",
      "launch --card-id <id> [--studio-document-id <id>] [--origin-agent-session-id <id>] [--origin-message-id <id>]",
      "append-block [--session-id <id>] --role answer|student_question|system (--text-file <path>) [--delete-after-read] [--highlight-spans-env <ENV>]",
      "answer [--session-id <id>] (--text-file <path>) [--delete-after-read] [--highlight-spans-env <ENV>]",
      "render-html [--session-id <id>] (--html-file <path>) [--delete-after-read]",
      "render-html-patch [--session-id <id>] (--patch-file <path>) [--delete-after-read]",
      "complete [--session-id <id>] (--teaching-summary-file <path>) [--delete-after-read] [--next-suggestion <text>]",
    ].join("\n") + "\n",
  )
}

function hasFlag(args: string[], name: string) {
  return args.includes(name)
}

function readFlagValue(args: string[], name: string) {
  const index = args.findIndex((arg) => arg === name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function readRequiredScope() {
  const workroomID = process.env.STUDIO_QUESTION_CARDS_SCOPE_WORKROOM_ID?.trim()
  if (!workroomID) throw new Error("INVALID_ARGUMENT: missing scoped workroom id")
  return { workroomID }
}

function readBridgeConfig() {
  const baseURL = process.env.STUDIO_QUESTION_CARDS_BRIDGE_BASE_URL?.trim()
  const token = process.env.STUDIO_QUESTION_CARDS_BRIDGE_TOKEN?.trim()
  if (!baseURL || !token) throw new Error("INVALID_ARGUMENT: missing lecture bridge configuration")
  return { baseURL: baseURL.replace(/\/+$/, ""), token }
}

function readCurrentOpencodeSessionID() {
  return process.env.OPENCODE_SESSION_ID?.trim() ?? null
}

function parseTargets(raw: string | null | undefined) {
  if (!raw) return []
  return raw
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function readUtf8FileText(filePath: string) {
  const trimmed = filePath.trim()
  if (!trimmed) throw new Error("MISSING_REQUIRED_ARGUMENT: file path")
  return (await readFile(trimmed, "utf8")).replace(/\r\n/g, "\n")
}

async function deleteFileIfRequested(filePath: string, shouldDelete: boolean) {
  if (!shouldDelete) return
  try {
    await unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
  }
}

async function resolvePayloadText(input: {
  args: string[]
  fileFlag: string
}) {
  const deleteAfterRead = hasFlag(input.args, "--delete-after-read")
  const filePath = readFlagValue(input.args, input.fileFlag)?.trim()
  if (filePath) {
    try {
      return await readUtf8FileText(filePath)
    } finally {
      await deleteFileIfRequested(filePath, deleteAfterRead)
    }
  }
  return null
}

function readHighlightSpans(args: string[]) {
  const envName = readFlagValue(args, "--highlight-spans-env")?.trim()
  if (envName) {
    const raw = process.env[envName]
    if (raw == null) throw new Error(`MISSING_REQUIRED_ENV: ${envName}`)
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error("INVALID_ARGUMENT: highlight spans must be a JSON array")
    return parsed
      .map((item) => ({
        sourceId: String(item?.sourceId ?? "").trim(),
        quote: String(item?.quote ?? "").trim(),
      }))
      .filter((item) => item.sourceId && item.quote)
  }
  return []
}

async function readVisualizationPatches(args: string[]) {
  const deleteAfterRead = hasFlag(args, "--delete-after-read")
  const filePath = readFlagValue(args, "--patch-file")?.trim()
  let raw: string | null = null
  if (filePath) {
    try {
      raw = await readUtf8FileText(filePath)
    } finally {
      await deleteFileIfRequested(filePath, deleteAfterRead)
    }
  }
  if (raw == null) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith("<")) {
    throw new Error("INVALID_ARGUMENT: patch must contain a JSON array of structured patches; use render-html for full HTML")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("INVALID_ARGUMENT: patch must contain valid JSON array of structured patches")
  }
  if (!Array.isArray(parsed)) throw new Error("INVALID_ARGUMENT: patch must be a JSON array")
  return parsed
    .filter(Boolean)
    .map((item) => {
      const targetId = String(item?.targetId ?? "").trim()
      if (!targetId) return null
      const op = String(item?.op ?? "").trim()
      if (op === "set_html" || op === "append_child") {
        const html = String(item?.html ?? "")
        if (!html.trim()) return null
        return { op, targetId, html }
      }
      if (op === "set_text") {
        return { op, targetId, text: String(item?.text ?? "") }
      }
      if (op === "set_attr") {
        const name = String(item?.name ?? "").trim()
        if (!name) return null
        return { op, targetId, name, value: item?.value == null ? null : String(item.value) }
      }
      if (op === "remove_node") {
        return { op, targetId }
      }
      if (op === "scene_state") {
        return {
          op,
          targetId,
          state: item?.state && typeof item.state === "object" ? item.state : {},
        }
      }
      return null
    })
    .filter(Boolean)
}

async function postJson(endpoint: string, payload: Record<string, unknown>) {
  const { baseURL, token } = readBridgeConfig()
  const response = await fetch(`${baseURL}${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-studio-bridge-token": token,
    },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    const message = typeof parsed.error === "string" ? parsed.error : `Lecture command failed with status ${response.status}`
    throw new Error(message)
  }
  return parsed
}

async function resolveLectureSessionID(input: { workroomID: string; sessionID?: string | null }) {
  if (input.sessionID?.trim()) return input.sessionID.trim()
  const opencodeSessionID = readCurrentOpencodeSessionID()
  if (!opencodeSessionID) throw new Error("MISSING_REQUIRED_ARGUMENT: session-id")
  const { baseURL, token } = readBridgeConfig()
  const response = await fetch(
    `${baseURL}/api/lectures/by-agent-session/${encodeURIComponent(opencodeSessionID)}?workroom_id=${encodeURIComponent(input.workroomID)}`,
    {
      headers: {
        "x-studio-bridge-token": token,
      },
    },
  )
  const text = await response.text()
  let parsed: { session?: { id?: string } | null; error?: string } = {}
  if (text) {
    try {
      parsed = JSON.parse(text) as { session?: { id?: string } | null; error?: string }
    } catch {
      parsed = {}
    }
  }
  if (!response.ok) {
    const message = typeof parsed.error === "string" ? parsed.error : "Unable to resolve lecture session"
    throw new Error(message)
  }
  const resolved = parsed.session?.id?.trim()
  if (!resolved) throw new Error("LECTURE_SESSION_NOT_FOUND")
  return resolved
}

async function executeCommand(command: CliCommand, args: string[], io: CliIO = {}) {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    return { help: true, command }
  }
  const scope = readRequiredScope()

  if (command === "launch") {
    const cardID = readFlagValue(args, "--card-id")?.trim()
    if (!cardID) throw new Error("MISSING_REQUIRED_ARGUMENT: card-id")
    return postJson("/api/lectures/launch", {
      ...scope,
      cardID,
      studioDocumentID: readFlagValue(args, "--studio-document-id")?.trim() ?? undefined,
      originAgentSessionID: readFlagValue(args, "--origin-agent-session-id")?.trim() ?? undefined,
      originMessageID: readFlagValue(args, "--origin-message-id")?.trim() ?? undefined,
    })
  }

  const sessionID = await resolveLectureSessionID({
    workroomID: scope.workroomID,
    sessionID: readFlagValue(args, "--session-id")?.trim(),
  })

  if (command === "complete") {
    const teachingSummary = (await resolvePayloadText({
      args,
      fileFlag: "--teaching-summary-file",
    }))?.trim()
    if (!teachingSummary) throw new Error("MISSING_REQUIRED_ARGUMENT: teaching-summary")
    return postJson(`/api/lectures/${encodeURIComponent(sessionID)}/complete`, {
      ...scope,
      teachingSummary,
      nextSuggestion: readFlagValue(args, "--next-suggestion")?.trim() ?? undefined,
    })
  }

  if (command === "answer") {
    const text = (await resolvePayloadText({
      args,
      fileFlag: "--text-file",
    }))?.trim()
    if (!text) throw new Error("MISSING_REQUIRED_ARGUMENT: text")
    return postJson(`/api/lectures/${encodeURIComponent(sessionID)}/answer`, {
      ...scope,
      role: "answer",
      text,
      highlightSpans: readHighlightSpans(args),
    })
  }

  if (command === "render-html") {
    const html = await resolvePayloadText({
      args,
      fileFlag: "--html-file",
    })
    if (html == null) throw new Error("MISSING_REQUIRED_ARGUMENT: html")
    return postJson(`/api/lectures/${encodeURIComponent(sessionID)}/visualization`, {
      ...scope,
      html,
    })
  }

  if (command === "render-html-patch") {
    const patches = await readVisualizationPatches(args)
    if (!patches.length) throw new Error("MISSING_REQUIRED_ARGUMENT: patch")
    return postJson(`/api/lectures/${encodeURIComponent(sessionID)}/visualization`, {
      ...scope,
      patches,
    })
  }

  const role = readFlagValue(args, "--role")?.trim()
  const text = (await resolvePayloadText({
      args,
      fileFlag: "--text-file",
    }))?.trim()
  if (!role) throw new Error("MISSING_REQUIRED_ARGUMENT: role")
  if (role === "lecture") throw new Error("LECTURE_TEXT_RUNTIME_STREAM_ONLY")
  if (!text) throw new Error("MISSING_REQUIRED_ARGUMENT: text")
  return postJson(`/api/lectures/${encodeURIComponent(sessionID)}/block`, {
    ...scope,
    role,
    text,
    highlightSpans: readHighlightSpans(args),
  })
}

export async function runLectureCli(argv: string[], io: CliIO = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const [commandRaw, ...args] = argv
  const command = (commandRaw ?? "").trim() as CliCommand

  if (
    !command ||
    !["launch", "append-block", "complete", "answer", "render-html", "render-html-patch"].includes(command)
  ) {
    printUsage(stderr)
    return 1
  }

  try {
    const result = await executeCommand(command, args, io)
    if ("help" in result) {
      printUsage(stdout)
      return 0
    }
    stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stdout.write(`${JSON.stringify({ ok: false, command, error: message }, null, 2)}\n`)
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await runLectureCli(process.argv.slice(2))
  if (typeof exitCode === "number" && exitCode !== 0) process.exit(exitCode)
}
