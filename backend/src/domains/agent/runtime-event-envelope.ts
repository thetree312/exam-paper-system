import type { AgentStreamEnvelope } from "./runtime-stream"

export function toRuntimeStreamEnvelope(event: any): AgentStreamEnvelope | null {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return null

  switch (event.type) {
    case "message.started":
    case "message.updated":
    case "message.completed":
    case "message.part.added":
    case "message.part.updated":
    case "message.part.completed":
    case "message.part.delta":
      return {
        type: event.type,
        properties:
          event.properties && typeof event.properties === "object"
            ? event.properties
            : {
                sessionID: event.sessionID,
                messageID: event.messageID,
                partID: event.partID,
                partType: event.partType,
                field: event.field,
                delta: event.delta,
                part: event.part,
                info: event.info,
              },
      }
    case "message_started":
    case "message_updated":
    case "message_completed":
      return {
        type: event.type.replace("_", "."),
        properties: {
          info: event.message?.info ?? {},
          parts: Array.isArray(event.message?.parts) ? event.message.parts : [],
        },
      }
    case "part_added":
      return {
        type: "message.part.added",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          part: event.part,
        },
      }
    case "part_updated":
      return {
        type: "message.part.updated",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          part: event.part,
        },
      }
    case "part_completed":
      return {
        type: "message.part.completed",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          part: event.part,
        },
      }
    case "part_delta":
      return {
        type: "message.part.delta",
        properties: {
          sessionID: event.part?.sessionID,
          messageID: event.messageID,
          partID: event.partID,
          partType: event.partType,
          field: event.field,
          delta: event.delta,
        },
      }
    default:
      return null
  }
}
