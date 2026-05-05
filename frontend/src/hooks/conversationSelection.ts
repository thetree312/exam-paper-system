import type { AgentConversationMeta } from '../types'

function normalizeNullableId(input: string | number | null | undefined) {
  return input == null ? null : String(input)
}

export function pickConversationKey(input: {
  conversations: AgentConversationMeta[]
  preferredSessionId?: string | null
  documentId?: string | number | null
  viewId?: string | null
}): string | null {
  const preferredSessionId = normalizeNullableId(input.preferredSessionId)
  const documentId = normalizeNullableId(input.documentId)
  const viewId = normalizeNullableId(input.viewId)

  if (preferredSessionId) {
    const matched = input.conversations.find((item) => item.sessionId === preferredSessionId)
    if (matched) return matched.key
  }

  const matchedByContext = input.conversations.find((item) => {
    const sameDocument =
      documentId == null || (item.documentId != null && String(item.documentId) === documentId)
    const sameView =
      viewId == null || (item.viewId != null && String(item.viewId) === viewId)
    return sameDocument && sameView
  })

  return matchedByContext?.key ?? input.conversations[0]?.key ?? null
}
