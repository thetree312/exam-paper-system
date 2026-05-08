import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import {
  asStructuredError,
  executeStudioQuestionCardsCommand,
  type StudioQuestionCardsCommand,
  studioQuestionCardsCommands,
} from "../domains/studio/command-bridge"
import { loadBackendEnv } from "../lib/load-env"

loadBackendEnv()

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

async function readPayload(argv: string[], stdin: NodeJS.ReadStream) {
  const payloadB64FlagIndex = argv.findIndex((arg) => arg === "--payload-b64")
  if (payloadB64FlagIndex >= 0) {
    const encoded = argv[payloadB64FlagIndex + 1]
    return decodePayloadB64(encoded ?? "")
  }
  const payloadFileFlagIndex = argv.findIndex((arg) => arg === "--payload-file")
  if (payloadFileFlagIndex >= 0) {
    const filepath = argv[payloadFileFlagIndex + 1]
    if (!filepath) throw new Error("Missing value for --payload-file")
    return (await readFile(filepath, "utf8")).trim()
  }
  return readStdin(stdin)
}

function printUsage(stderr: NodeJS.WriteStream) {
  stderr.write(
    [
      "Usage: bun backend/src/cli/studio-question-cards.ts <command>",
      `Commands: ${studioQuestionCardsCommands.join(" | ")}`,
      "Input: JSON via stdin, --payload-b64 <base64_utf8_json>, or --payload-file <utf8-json-file>",
      "Semantics: create-container creates a new studio document container; insert-card/insert inserts questions into existing container sequence around anchorCardID.",
    ].join("\n") + "\n",
  )
}

async function executeViaBridgeApi(command: StudioQuestionCardsCommand, payload: unknown) {
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
    const message = typeof parsed.error === "string" ? parsed.error : `Bridge request failed with status ${response.status}`
    const code = typeof parsed.code === "string" ? parsed.code : "BRIDGE_REQUEST_FAILED"
    const detail = parsed.detail ?? null
    const error = new Error(`${code}: ${message}`)
    ;(error as Error & { detail?: unknown }).detail = detail
    throw error
  }

  return parsed.result
}

export async function runStudioQuestionCardsCli(
  argv: string[],
  io: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {},
) {
  const stdin = io.stdin ?? process.stdin
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const command = (argv[0] ?? "").trim() as StudioQuestionCardsCommand
  if (!command || !studioQuestionCardsCommands.includes(command)) {
    printUsage(stderr)
    return 1
  }

  try {
    const raw = await readPayload(argv.slice(1), stdin)
    const payload = raw ? (JSON.parse(raw) as unknown) : {}
    const result = (await executeViaBridgeApi(command, payload)) ?? (await executeStudioQuestionCardsCommand(command, payload))
    stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`)
    return 0
  } catch (error) {
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
}

if (import.meta.main) {
  const code = await runStudioQuestionCardsCli(process.argv.slice(2))
  process.exit(code)
}
