import {
  asStructuredError,
  executeStudioQuestionCardsCommand,
} from "../domains/studio/command-bridge"
import {
  createQuestionByIntent,
  getQuestionCardDetailByNumber,
  insertQuestionByIntent,
  similarQuestionByIntent,
} from "../domains/studio/question-write-service"
import { loadBackendEnv } from "../lib/load-env"

loadBackendEnv()

type QuestionAction = "search" | "get" | "create" | "insert" | "similar"

type CliCommand = "q-search" | "q-get" | "q-create" | "q-insert" | "q-similar"

type CliIO = {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
}

type CreateIntentInput = Parameters<typeof createQuestionByIntent>[0]
type InsertIntentInput = Parameters<typeof insertQuestionByIntent>[0]
type SimilarIntentInput = Parameters<typeof similarQuestionByIntent>[0]

function printUsage(stderr: NodeJS.WriteStream) {
  stderr.write(
    [
      "Usage: bun backend/src/cli/studio-question-cards.ts <command>",
      "Commands: q-search | q-get | q-create | q-insert | q-similar",
      "q-search --query <text> [--limit <n>]",
      "q-get --card-id <id> | --question-number <n> [--json]",
      "q-create --text <full-question-text> [--answer <text>] [--explanation <text>] [--question-type <text>] [--difficulty <text>] [--knowledge-points <comma-separated>] [--options <json-array>|--option-a..--option-d] [--page <n>]",
      "q-insert --anchor-question-number <1-based> --placement before|after --text <full-question-text> [--answer <text>] [--explanation <text>] [--question-type <text>] [--difficulty <text>] [--knowledge-points <comma-separated>] [--options <json-array>|--option-a..--option-d] [--page <n>]",
      "q-similar --anchor-question-number <1-based> --placement before|after --text <full-question-text> [--answer <text>] [--explanation <text>] [--question-type <text>] [--difficulty <text>] [--knowledge-points <comma-separated>] [--options <json-array>|--option-a..--option-d] [--page <n>]",
      "Aliases: --question-number is still supported for backward compatibility.",
      "Compatibility: old `question ...` commands are deprecated and rejected.",
    ].join("\n") + "\n",
  )
}

function readFlagValue(args: string[], name: string) {
  const index = args.findIndex((arg) => arg === name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function resolveInlineTextArg(args: string[], inlineFlag: string) {
  return readFlagValue(args, inlineFlag)?.trim() ?? null
}

function hasFlag(args: string[], name: string) {
  return args.includes(name)
}

function omitNilFields<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const entries = Object.entries(input).filter(([, value]) => value !== null && value !== undefined)
  return Object.fromEntries(entries)
}

function toSingleLineText(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

function toDiagnosisSummary(value: unknown) {
  const text = toSingleLineText(value)
  if (!text) return ""
  const matched = text.match(/^(.+?[。！？.!?])(?:\s|$)/)
  const firstSentence = matched?.[1]?.trim() ?? text
  if (firstSentence.length <= 120) return firstSentence
  return `${firstSentence.slice(0, 120).trim()}...`
}

function formatQuestionGetText(result: Record<string, any>) {
  const anchor = (result.anchor ?? {}) as Record<string, any>
  const content = (result.content ?? {}) as Record<string, any>
  const learning = (result.learningProfile ?? {}) as Record<string, any>
  const state = (learning.currentState ?? {}) as Record<string, any>
  const recommendation = (state.generation_recommendation ?? {}) as Record<string, any>
  const latest = (learning.latestGradingRecord ?? {}) as Record<string, any>
  const knowledgePoints = Array.isArray(content.knowledgePoints) ? content.knowledgePoints.map((item) => String(item)) : []
  const questionTypes = Array.isArray(recommendation.recommended_question_types)
    ? recommendation.recommended_question_types.map((item: unknown) => String(item))
    : []
  const suggestedPoints = Array.isArray(recommendation.recommended_knowledge_points)
    ? recommendation.recommended_knowledge_points.map((item: unknown) => String(item))
    : []
  const recommendationReason = typeof recommendation.reason_summary === "string" ? recommendation.reason_summary.trim() : ""
  const suggestionParts = [
    latest.next_action_suggestion ? `建议=${toSingleLineText(latest.next_action_suggestion)}` : null,
    recommendationReason ? `依据=${recommendationReason}` : null,
    questionTypes.length > 0 ? `题型=${questionTypes.join("/")}` : null,
    suggestedPoints.length > 0 ? `知识点=${suggestedPoints.join("、")}` : null,
  ].filter((item): item is string => Boolean(item))
  const mistakeSummary = [
    latest.mistake_type ? `类型=${toSingleLineText(latest.mistake_type)}` : null,
    latest.diagnosis ? `原因=${toDiagnosisSummary(latest.diagnosis)}` : null,
  ].filter((item): item is string => Boolean(item))

  return [
    `cardID: ${anchor.cardID ?? "-"}`,
    `定位信息: 题号=${anchor.questionNumber ?? "-"}，页码=${anchor.page ?? content.page ?? "-"}，位置锚点=${anchor.questionNumber ?? "-"}`,
    `原题: ${String(content.stem ?? "").trim() || "-"}`,
    `答案: ${String(content.answer ?? content.canonicalAnswer ?? "").trim() || "-"}`,
    `解析: ${String(content.explanation ?? "").trim() || "-"}`,
    `建议出题: ${suggestionParts.length > 0 ? suggestionParts.join("；") : "-"}`,
    `建议难度: ${recommendation.recommended_difficulty ?? content.difficulty ?? "-"}`,
    `上次做错原因: ${mistakeSummary.length > 0 ? mistakeSummary.join("；") : "-"}`,
  ].join("\n")
}

function resolveInlineOptionsArg(args: string[]) {
  const jsonRaw = readFlagValue(args, "--options")?.trim()
  if (jsonRaw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonRaw)
    } catch {
      throw new Error("INVALID_ARGUMENT: --options must be a JSON array of strings")
    }
    if (!Array.isArray(parsed)) {
      throw new Error("INVALID_ARGUMENT: --options must be a JSON array of strings")
    }
    return parsed.map((item) => String(item).trim()).filter(Boolean)
  }

  const explicit = ["--option-a", "--option-b", "--option-c", "--option-d"]
    .map((flag) => readFlagValue(args, flag))
    .filter((item): item is string => Boolean(item?.trim()))
  return explicit.map((item) => item.trim())
}

function resolveInlineKnowledgePointsArg(args: string[]) {
  const raw = readFlagValue(args, "--knowledge-points")?.trim()
  if (!raw) return []
  return raw.split(/[，,]/).map((item) => item.trim()).filter(Boolean)
}

function readRequiredScope(args: string[]) {
  const userID = resolveInlineTextArg(args, "--user-id") ?? process.env.STUDIO_QUESTION_CARDS_SCOPE_USER_ID?.trim() ?? undefined
  const workroomID =
    resolveInlineTextArg(args, "--workroom-id") ?? process.env.STUDIO_QUESTION_CARDS_SCOPE_WORKROOM_ID?.trim() ?? undefined
  if (!userID) throw new Error("INVALID_ARGUMENT: missing --user-id")
  if (!workroomID) throw new Error("INVALID_ARGUMENT: missing --workroom-id")
  return { userID, workroomID }
}

function toDeprecatedQuestionError(action: string) {
  const normalized = action.trim().toLowerCase()
  const mapping: Record<string, string> = {
    search: "q-search",
    get: "q-get",
    create: "q-create",
    insert: "q-insert",
    similar: "q-similar",
  }
  const replace = mapping[normalized]
  const message = replace
    ? `DEPRECATED_COMMAND: use ${replace} instead of question ${normalized}`
    : "DEPRECATED_COMMAND: `question ...` is removed. Use q-search/q-get/q-create/q-insert/q-similar."
  const error = new Error(message)
  ;(error as Error & { detail?: unknown }).detail = replace ? { replacement: replace } : null
  return error
}

async function executeQuestionViaApi(action: QuestionAction, payload: Record<string, unknown>) {
  const baseURL = process.env.STUDIO_QUESTION_CARDS_BRIDGE_BASE_URL?.trim()
  const token = process.env.STUDIO_QUESTION_CARDS_BRIDGE_TOKEN?.trim()
  if (!baseURL || !token) return null

  const endpoint =
    action === "search"
      ? "/api/studio/question-cards/question/search"
      : action === "get"
        ? "/api/studio/question-cards/question/get"
        : action === "similar"
          ? "/api/studio/question-cards/question/similar"
          : `/api/studio/question-cards/question/${action}`
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}${endpoint}`, {
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

async function executeCommand(command: CliCommand, args: string[]) {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    return { help: true, command }
  }
  const scope = readRequiredScope(args)

  if (command === "q-search") {
    const query = resolveInlineTextArg(args, "--query")
    if (!query) throw new Error("INVALID_ARGUMENT: missing query")
    const limitValue = readFlagValue(args, "--limit")
    const limit = limitValue ? Number.parseInt(limitValue, 10) : undefined
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error("INVALID_ARGUMENT: limit must be a positive integer")
    }
    return (
      (await executeQuestionViaApi("search", { ...scope, query, ...(limit ? { limit } : {}) })) ??
      (await executeStudioQuestionCardsCommand("search-cards", { ...scope, query, ...(limit ? { limit } : {}) }))
    )
  }

  if (command === "q-get") {
    if (hasFlag(args, "--full")) {
      throw new Error("UNSUPPORTED_ARGUMENT: q-get --full is disabled in the agent bridge; use backend logs or request dumps for debugging")
    }
    const cardID = resolveInlineTextArg(args, "--card-id")
    const questionNumberRaw = readFlagValue(args, "--question-number")
    const questionNumber = questionNumberRaw ? Number.parseInt(questionNumberRaw, 10) : undefined
    if (questionNumberRaw && (!Number.isInteger(questionNumber) || (questionNumber ?? 0) < 1)) {
      throw new Error("INVALID_ARGUMENT: question-number must be a positive integer")
    }
    if (!cardID && !questionNumber) throw new Error("MISSING_REQUIRED_ARGUMENT: card-id or question-number")
    const fromApi = await executeQuestionViaApi("get", {
      ...scope,
      ...(cardID ? { cardID } : {}),
      ...(questionNumber ? { questionNumber } : {}),
    })
    if (fromApi) return fromApi
    if (cardID) {
      return executeStudioQuestionCardsCommand("get-card", { ...scope, cardID })
    }
    return getQuestionCardDetailByNumber({ ...scope, questionNumber: questionNumber as number })
  }

  const text = resolveInlineTextArg(args, "--text")
  const stem = resolveInlineTextArg(args, "--stem")
  if (!text && !stem) throw new Error("INVALID_ARGUMENT: missing text")
  const answer = resolveInlineTextArg(args, "--answer")
  const explanation = resolveInlineTextArg(args, "--explanation")
  const questionType = resolveInlineTextArg(args, "--question-type")
  const difficulty = resolveInlineTextArg(args, "--difficulty")
  const knowledgePoints = resolveInlineKnowledgePointsArg(args)
  const options = resolveInlineOptionsArg(args)
  const pageValue = readFlagValue(args, "--page")
  const page = pageValue ? Number.parseInt(pageValue, 10) : undefined
  if (page !== undefined && Number.isNaN(page)) throw new Error("INVALID_ARGUMENT: invalid --page value")

  const intentPayload: CreateIntentInput = {
    ...scope,
    text,
    stem,
    answer,
    explanation,
    questionType,
    difficulty,
    knowledgePoints,
    options,
    page,
  }

  const payload = omitNilFields(intentPayload)

  if (command === "q-create") {
    return (await executeQuestionViaApi("create", payload)) ?? (await createQuestionByIntent(intentPayload))
  }

  const questionNumberValue = readFlagValue(args, "--anchor-question-number") ?? readFlagValue(args, "--question-number")
  if (!questionNumberValue) throw new Error("MISSING_REQUIRED_ARGUMENT: question-number")
  const questionNumber = Number.parseInt(questionNumberValue, 10)
  if (!Number.isInteger(questionNumber) || questionNumber < 1) {
    throw new Error("INVALID_ARGUMENT: question-number must be a positive integer")
  }
  const placement = (readFlagValue(args, "--placement") ?? "").trim().toLowerCase()
  if (placement !== "before" && placement !== "after") {
    throw new Error("MISSING_REQUIRED_ARGUMENT: placement")
  }

  if (command === "q-similar") {
    const similarInput: SimilarIntentInput = {
      ...intentPayload,
      questionNumber,
      placement,
    }
    return (
      (await executeQuestionViaApi("similar", {
        ...payload,
        questionNumber,
        placement,
      })) ??
      (await similarQuestionByIntent(similarInput))
    )
  }

  const insertInput: InsertIntentInput = {
    ...intentPayload,
    questionNumber,
    placement,
  }
  return (
    (await executeQuestionViaApi("insert", {
      ...payload,
      questionNumber,
      placement,
    })) ??
    (await insertQuestionByIntent(insertInput))
  )
}

function toCliCommand(value: string): CliCommand | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === "q-search") return "q-search"
  if (normalized === "q-get") return "q-get"
  if (normalized === "q-create") return "q-create"
  if (normalized === "q-insert") return "q-insert"
  if (normalized === "q-similar") return "q-similar"
  return null
}

export async function runStudioQuestionCardsCli(argv: string[], io: CliIO = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const command = (argv[0] ?? "").trim()
  const args = argv.slice(1)

  if (command === "question") {
    const action = (argv[1] ?? "").trim()
    const error = toDeprecatedQuestionError(action)
    const parsed = asStructuredError(error)
    stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          command,
          error: parsed.message,
          code: parsed.code,
          detail: parsed.detail ?? null,
        },
        null,
        2,
      )}\n`,
    )
    return 1
  }

  const cliCommand = toCliCommand(command)
  if (!cliCommand) {
    printUsage(stderr)
    return 1
  }

  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printUsage(stdout)
    return 0
  }

  try {
    const result = await executeCommand(cliCommand, args)
    const shouldOutputJson = hasFlag(args, "--json")
    if (cliCommand === "q-get" && !shouldOutputJson) {
      stdout.write(`${formatQuestionGetText(result as Record<string, any>)}\n`)
      return 0
    }
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
