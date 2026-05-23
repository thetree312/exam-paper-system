import type { LectureBlockRecord } from "./types"

type RuntimeEventRecord = {
  type?: unknown
  properties?: unknown
}

export type ProjectedRuntimeDraft = {
  messageID: string | null
  partID: string | null
  text: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function textFromPart(part: Record<string, unknown> | null) {
  if (!part || part.type !== "text") return null
  if (typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

function textFromReasoningPart(part: Record<string, unknown> | null) {
  if (!part || part.type !== "reasoning") return null
  if (typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  return ""
}

function runtimeTimeToISOString(value: unknown, fallback: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function runtimeMessageID(message: Record<string, unknown>, fallback: string) {
  const info = asRecord(message.info)
  if (typeof info?.id === "string" && info.id.trim()) return info.id.trim()
  if (typeof message.id === "string" && message.id.trim()) return message.id.trim()
  return fallback
}

function runtimePartID(part: Record<string, unknown>, fallback: string) {
  if (typeof part.id === "string" && part.id.trim()) return part.id.trim()
  return fallback
}

function runtimeMessageCreatedAt(message: Record<string, unknown>, fallback: string) {
  const info = asRecord(message.info)
  const time = asRecord(info?.time)
  return runtimeTimeToISOString(time?.created, fallback)
}

function runtimePartCreatedAt(part: Record<string, unknown>, fallback: string) {
  const time = asRecord(part.time)
  return runtimeTimeToISOString(time?.start, fallback)
}

export function runtimeEventMessageID(event: RuntimeEventRecord) {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  if (typeof properties?.messageID === "string" && properties.messageID.trim()) return properties.messageID.trim()
  if (typeof info?.id === "string" && info.id.trim()) return info.id.trim()
  return null
}

export function runtimeEventPartID(event: RuntimeEventRecord) {
  const properties = asRecord(event.properties)
  if (typeof properties?.partID === "string" && properties.partID.trim()) return properties.partID.trim()
  const part = asRecord(properties?.part)
  if (typeof part?.id === "string" && part.id.trim()) return part.id.trim()
  return null
}

export function runtimeEventPartKind(event: RuntimeEventRecord) {
  const properties = asRecord(event.properties)
  if (properties?.partType === "text" || properties?.partType === "reasoning") return properties.partType
  const part = asRecord(properties?.part)
  return part?.type === "text" || part?.type === "reasoning" ? part.type : null
}

export function isAssistantRuntimeMessage(event: RuntimeEventRecord) {
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  return info?.role === "assistant"
}

export function extractRuntimeTextPart(event: RuntimeEventRecord): ProjectedRuntimeDraft | null {
  if (event.type !== "message.part.added" && event.type !== "message.part.updated") return null
  const properties = asRecord(event.properties)
  const part = asRecord(properties?.part)
  const text = textFromPart(part)
  if (text == null) return null
  if (!text) return null
  return {
    messageID: runtimeEventMessageID(event),
    partID: runtimeEventPartID(event),
    text,
  }
}

export function extractRuntimeReasoningPart(event: RuntimeEventRecord): ProjectedRuntimeDraft | null {
  if (event.type !== "message.part.added" && event.type !== "message.part.updated") return null
  const properties = asRecord(event.properties)
  const part = asRecord(properties?.part)
  const text = textFromReasoningPart(part)
  if (text == null) return null
  if (!text) return null
  return {
    messageID: runtimeEventMessageID(event),
    partID: runtimeEventPartID(event),
    text,
  }
}

export function extractRuntimeTextDelta(event: RuntimeEventRecord): ProjectedRuntimeDraft | null {
  if (event.type !== "message.part.delta") return null
  const properties = asRecord(event.properties)
  if (properties?.field !== "text") return null
  if (typeof properties.delta !== "string" || !properties.delta) return null
  return {
    messageID: runtimeEventMessageID(event),
    partID: runtimeEventPartID(event),
    text: properties.delta,
  }
}

export function extractProjectedLectureText(event: RuntimeEventRecord) {
  if (event.type !== "message.completed") return null
  const properties = asRecord(event.properties)
  const info = asRecord(properties?.info)
  if (info?.role !== "assistant") return null
  const parts = Array.isArray(properties?.parts) ? properties.parts : []
  const text = parts
    .map((part) => {
      const item = asRecord(part)
      if (item?.type !== "text") return null
      return typeof item.text === "string" ? item.text.trim() : null
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
    .trim()
  return text || null
}

export function extractRuntimeLectureBlocksFromMessages(input: {
  lectureSessionID: string
  messages: unknown[]
  fallbackCreatedAt?: string | null
}): LectureBlockRecord[] {
  const fallbackCreatedAt = input.fallbackCreatedAt?.trim() || new Date(0).toISOString()
  const blocks: LectureBlockRecord[] = []

  for (const [messageIndex, rawMessage] of input.messages.entries()) {
    const message = asRecord(rawMessage)
    if (!message) continue
    const info = asRecord(message.info)
    if (info?.role !== "assistant") continue
    if (info?.summary === true) continue

    const parts = Array.isArray(message.parts) ? message.parts : []
    const messageID = runtimeMessageID(message, `message-${messageIndex}`)
    const messageCreatedAt = runtimeMessageCreatedAt(message, fallbackCreatedAt)

    for (const [partIndex, rawPart] of parts.entries()) {
      const part = asRecord(rawPart)
      if (!part || part.type !== "text") continue
      if (part.ignored === true || part.synthetic === true) continue
      const text = typeof part.text === "string" ? part.text.trim() : ""
      if (!text) continue
      const partID = runtimePartID(part, `part-${partIndex}`)
      blocks.push({
        id: `runtime.${messageID}.${partID}`,
        sessionID: input.lectureSessionID,
        role: "lecture",
        text,
        highlightSpans: [],
        pauseAfter: false,
        createdAt: runtimePartCreatedAt(part, messageCreatedAt),
      })
    }
  }

  return blocks
}
