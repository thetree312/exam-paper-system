export type AgentStreamEnvelope = {
  type: string
  properties: Record<string, unknown>
}

const runtimeStreamSubscribers = new Map<string, Set<(event: AgentStreamEnvelope) => void>>()

export function subscribeRuntimeStream(sessionID: string, listener: (event: AgentStreamEnvelope) => void) {
  const bucket = runtimeStreamSubscribers.get(sessionID) ?? new Set<(event: AgentStreamEnvelope) => void>()
  bucket.add(listener)
  runtimeStreamSubscribers.set(sessionID, bucket)
  return () => {
    const current = runtimeStreamSubscribers.get(sessionID)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      runtimeStreamSubscribers.delete(sessionID)
    }
  }
}

export function publishRuntimeStream(sessionID: string, event: AgentStreamEnvelope) {
  const listeners = runtimeStreamSubscribers.get(sessionID)
  if (!listeners || listeners.size === 0) return
  for (const listener of listeners) {
    listener(event)
  }
}
