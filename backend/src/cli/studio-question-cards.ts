import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import {
  asStructuredError,
  executeStudioQuestionCardsCommand,
  studioQuestionCardsCommands,
  type StudioQuestionCardsCommand,
} from "../domains/studio/command-bridge"
import { createQuestionByIntent, insertQuestionByIntent } from "../domains/studio/question-write-service"
import { loadBackendEnv } from "../lib/load-env"

loadBackendEnv()

const questionCommand = "question" as const

type QuestionAction = "create" | "insert"

type CliIO = {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
}

function printUsage(stderr: NodeJS.WriteStream) {
  stderr.write(
    [
      "Usage: bun backend/src/cli/studio-question-cards.ts <command>",
      `Commands: ${studioQuestionCardsCommands.join(" | ")}`,
      `Agent command: ${questionCommand} <create|insert>`,
      "Raw commands read JSON from stdin, --payload-b64 <base64_utf8_json>, or --payload-file <utf8-json-file>.",
      "Question command flags: question create --stem <text> [--answer <text>] [--explanation <text>] [--option-a..--option-d] [--page <n>]",
      "Question command flags: question insert --question-number <1-based> --placement before|after --stem <text> [--answer <text>] [--explanation <text>] [--option-a..--option-d] [--page <n>]",
      "Question commands call the backend question API directly. Do not create temp files unless a human explicitly asks for file input.",
    ].join("\n") + "\n",
  )
}

function isQuestionAction(value: string): value is QuestionAction {
  return value === "create" || value === "insert"
}

function readFlagValue(args: string[], name: string) {
  const index = args.findIndex((arg) => arg === name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function readFlagOrEnv(args: string[], name: string, envName: string) {
  return readFlagValue(args, name) ?? process.env[envName]?.trim() ?? null
}

async function readStdin(stdin: NodeJS.ReadStream) {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString("utf8").trim()
}

function decodePayloadB64(text: string) {
  const normalized = text.trim()
  if (!normalized) throw new Error("Missing value for --payload-b64")
  return Buffer.from(normalized, "base64").toString("utf8")
}

async function readPayload(args: string[], stdin: NodeJS.ReadStream) {
  const payloadB64Index = args.findIndex((arg) => arg === "--payload-b64")
  if (payloadB64Index >= 0) return decodePayloadB64(args[payloadB64Index + 1] ?? "")

  const payloadFileIndex = args.findIndex((arg) => arg === "--payload-file")
  if (payloadFileIndex >= 0) {
    const filepath = args[payloadFileIndex + 1]
    if (!filepath) throw new Error("Missing value for --payload-file")
    return (await readFile(filepath, "utf8")).trim()
  }

  return readStdin(stdin)
}

function resolveInlineTextArg(args: string[], inlineFlag: string) {
  return readFlagValue(args, inlineFlag)?.trim() ?? null
}

function resolveInlineOptionsArg(args: string[]) {
  const explicit = ["--option-a", "--option-b", "--option-c", "--option-d"]
    .map((flag) => readFlagValue(args, flag))
    .filter((item): item is string => Boolean(item?.trim()))
  return explicit.map((item) => item.trim())
}

function readRequiredScope(args: string[]) {
  const userID = readFlagOrEnv(args, "--user-id", "STUDIO_QUESTION_CARDS_SCOPE_USER_ID") ?? undefined
  const workroomID = readFlagOrEnv(args, "--workroom-id", "STUDIO_QUESTION_CARDS_SCOPE_WORKROOM_ID") ?? undefined
  if (!userID) throw new Error("INVALID_ARGUMENT: missing --user-id")
  if (!workroomID) throw new Error("INVALID_ARGUMENT: missing --workroom-id")
  return { userID, workroomID }
}

async function executeQuestionViaApi(action: QuestionAction, payload: Record<string, unknown>) {
  const baseURL = process.env.STUDIO_QUESTION_CARDS_BRIDGE_BASE_URL?.trim()
  const token = process.env.STUDIO_QUESTION_CARDS_BRIDGE_TOKEN?.trim()
  if (!baseURL || !token) return null

  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/api/studio/question-cards/question/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-studio-bridge-token": token,
    },
    body: JSON.stringify(payload),
  })

  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok || parsed.ok === false) {
    const code = typeof parsed.code === "string" ? parsed.code : "QUESTION_COMMAND_FAILED"
    const message = typeof parsed.error === "string" ? parsed.error : `Question command failed with status ${response.status}`
    const error = new Error(`${code}: ${message}`)
    ;(error as Error & { detail?: unknown }).detail = parsed.detail ?? null
    throw error
  }

  return parsed.result
}

async function executeQuestionCommand(action: QuestionAction, args: string[]) {
  const scope = readRequiredScope(args)
  const stem = resolveInlineTextArg(args, "--stem")
  if (!stem) throw new Error("INVALID_ARGUMENT: missing stem")
  const answer = resolveInlineTextArg(args, "--answer")
  const explanation = resolveInlineTextArg(args, "--explanation")
  const options = resolveInlineOptionsArg(args)
  const pageValue = readFlagValue(args, "--page")
  const page = pageValue ? Number.parseInt(pageValue, 10) : undefined
  if (page !== undefined && Number.isNaN(page)) throw new Error("INVALID_ARGUMENT: invalid --page value")

  const payload = {
    ...scope,
    stem,
    answer,
    explanation,
    options,
    page,
  }

  if (action === "create") {
    return (await executeQuestionViaApi("create", payload)) ?? (await createQuestionByIntent(payload))
  }

  const questionNumberValue = readFlagValue(args, "--question-number")
  if (!questionNumberValue) throw new Error("INVALID_ARGUMENT: missing --question-number")
  const questionNumber = Number.parseInt(questionNumberValue, 10)
  if (!Number.isInteger(questionNumber) || questionNumber < 1) {
    throw new Error("INVALID_ARGUMENT: question-number must be a positive integer")
  }
  const placement = (readFlagValue(args, "--placement") ?? "").trim().toLowerCase()
  if (placement !== "before" && placement !== "after") {
    throw new Error("INVALID_ARGUMENT: placement must be before or after")
  }

  return (
    (await executeQuestionViaApi("insert", {
      ...payload,
      questionNumber,
      placement,
    })) ??
    (await insertQuestionByIntent({
      ...payload,
      questionNumber,
      placement,
    }))
  )
}

async function executeBridgeApi(command: StudioQuestionCardsCommand, payload: unknown) {
  const baseURL = process.env.STUDIO_QUESTION_CARDS_BRIDGE_BASE_URL?.trim()
  const token = process.env.STUDIO_QUESTION_CARDS_BRIDGE_TOKEN?.trim()
  if (!baseURL || !token) return null

  const response = await fetch(`${baseURL.replace(/\/+$/, "")}/api/studio/question-cards/bridge/${command}`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-studio-bridge-token": token,
    },
    body: JSON.stringify({ payload }),
  })

  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok || parsed.ok === false) {
    const code = typeof parsed.code === "string" ? parsed.code : "BRIDGE_REQUEST_FAILED"
    const message = typeof parsed.error === "string" ? parsed.error : `Bridge request failed with status ${response.status}`
    const error = new Error(`${code}: ${message}`)
    ;(error as Error & { detail?: unknown }).detail = parsed.detail ?? null
    throw error
  }

  return parsed.result
}

export async function runStudioQuestionCardsCli(argv: string[], io: CliIO = {}) {
  const stdin = io.stdin ?? process.stdin
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const command = (argv[0] ?? "").trim()
  const questionAction = (argv[1] ?? "").trim()

  const isQuestion = command === questionCommand && isQuestionAction(questionAction)
  const isBridgeCommand = studioQuestionCardsCommands.includes(command as StudioQuestionCardsCommand)

  if (!command || (!isQuestion && !isBridgeCommand)) {
    printUsage(stderr)
    return 1
  }

  try {
    const result = isQuestion
      ? await executeQuestionCommand(questionAction as QuestionAction, argv.slice(2))
      : await (async () => {
          const raw = await readPayload(argv.slice(1), stdin)
          const payload = raw ? (JSON.parse(raw) as unknown) : {}
          return (await executeBridgeApi(command as StudioQuestionCardsCommand, payload)) ??
            (await executeStudioQuestionCardsCommand(command as StudioQuestionCardsCommand, payload))
        })()

    stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`)
    return 0
  } catch (error) {
    const parsed = asStructuredError(error)
    const detail =
      parsed.detail ??
      (error && typeof error === "object" && "detail" in error ? (error as { detail?: unknown }).detail ?? null : null)
    stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          command,
          error: parsed.message,
          code: parsed.code,
          detail,
        },
        null,
        2,
      )}\n`,
    )
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await runStudioQuestionCardsCli(process.argv.slice(2))
  process.exit(exitCode)
}
