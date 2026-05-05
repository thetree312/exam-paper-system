import fs from "node:fs/promises"
import path from "node:path"
import type { ModelMessage, Tool } from "ai"
import { Global } from "@/global"

type SerializableValue =
  | string
  | number
  | boolean
  | null
  | SerializableValue[]
  | { [key: string]: SerializableValue }

type DumpInitInput = {
  agent: string
  modelID: string
  providerID: string
  sessionID: string
  userMessageID: string
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
  options: Record<string, unknown>
  params: {
    temperature?: number
    topP?: number
    topK?: number
    maxOutputTokens?: number
    toolChoice?: "auto" | "required" | "none"
    activeTools: string[]
    headers: Record<string, string>
    providerOptions: Record<string, unknown>
  }
}

type DumpAppendInput = {
  filePath: string
  type: string
  params: unknown
}

const REQUEST_DUMP_DIR = path.join(Global.Path.log, "request-dumps")

function normalizeUnknown(value: unknown): SerializableValue {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? "",
    }
  }
  if (value instanceof URL) return value.toString()
  if (value instanceof Uint8Array) return `[Uint8Array ${value.byteLength}]`
  if (Array.isArray(value)) return value.map(normalizeUnknown)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeUnknown(item)]),
    )
  }
  return String(value)
}

function serializeToolDefinitions(tools: Record<string, Tool>) {
  return Object.entries(tools).map(([name, tool]) => {
    const value = tool as unknown as Record<string, unknown>
    return {
      name,
      description: typeof value.description === "string" ? value.description : "",
      inputSchema: normalizeUnknown(value.inputSchema ?? value.parameters ?? null),
    }
  })
}

function stringifySection(value: unknown) {
  return JSON.stringify(normalizeUnknown(value), null, 2)
}

function charLength(value: string) {
  return value.length
}

export async function writeInitialRequestDump(input: DumpInitInput) {
  const tools = serializeToolDefinitions(input.tools)
  const systemText = input.system.join("\n")
  const messagesJson = stringifySection(input.messages)
  const toolsJson = stringifySection(tools)
  const optionsJson = stringifySection(input.options)
  const requestParamsJson = stringifySection(input.params)
  const payloadJson = stringifySection({
    system: input.system,
    messages: input.messages,
    tools,
    options: input.options,
    params: input.params,
  })
  const descriptionChars = tools.reduce((sum, tool) => sum + tool.description.length, 0)
  const summary = [
    `timestamp: ${new Date().toISOString()}`,
    `session_id: ${input.sessionID}`,
    `user_message_id: ${input.userMessageID}`,
    `agent: ${input.agent}`,
    `provider_id: ${input.providerID}`,
    `model_id: ${input.modelID}`,
    `system_parts: ${input.system.length}`,
    `tool_count: ${tools.length}`,
    `system_chars: ${charLength(systemText)}`,
    `messages_json_chars: ${charLength(messagesJson)}`,
    `tool_description_chars: ${descriptionChars}`,
    `tools_json_chars: ${charLength(toolsJson)}`,
    `options_json_chars: ${charLength(optionsJson)}`,
    `request_params_json_chars: ${charLength(requestParamsJson)}`,
    `payload_json_chars: ${charLength(payloadJson)}`,
  ].join("\n")

  const body = [
    "=== META ===",
    summary,
    "",
    "=== SYSTEM ===",
    systemText || "(empty)",
    "",
    "=== MESSAGES JSON ===",
    messagesJson,
    "",
    "=== TOOLS JSON ===",
    toolsJson,
    "",
    "=== MODEL OPTIONS JSON ===",
    optionsJson,
    "",
    "=== REQUEST PARAMS JSON ===",
    requestParamsJson,
    "",
    "=== PAYLOAD JSON ===",
    payloadJson,
    "",
  ].join("\n")

  await fs.mkdir(REQUEST_DUMP_DIR, { recursive: true })
  const safeSessionID = input.sessionID.replace(/[^\w.-]+/g, "_")
  const safeMessageID = input.userMessageID.replace(/[^\w.-]+/g, "_")
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeSessionID}-${safeMessageID}.txt`
  const filePath = path.join(REQUEST_DUMP_DIR, filename)
  await fs.writeFile(filePath, body, "utf8")
  return filePath
}

export async function appendProviderParamsDump(input: DumpAppendInput) {
  const paramsJson = stringifySection(input.params)
  const section = [
    "=== PROVIDER PARAMS ===",
    `timestamp: ${new Date().toISOString()}`,
    `stream_type: ${input.type}`,
    `provider_params_json_chars: ${charLength(paramsJson)}`,
    "",
    paramsJson,
    "",
  ].join("\n")
  await fs.appendFile(input.filePath, section, "utf8")
}

