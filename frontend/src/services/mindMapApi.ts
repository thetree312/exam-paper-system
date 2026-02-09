import type {
  MindMapEdgePayload,
  MindMapGraphResponse,
  MindMapNodePayload,
  MindMapSourceRef,
} from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

export interface MindMapFetchOptions {
  signal?: AbortSignal
  tenantId: number
  userId?: number | null
  preferredLanguage?: 'zh' | 'en'
}

export async function fetchMindMapGraph(
  baseUrl: string,
  source: MindMapSourceRef,
  { tenantId, userId, signal, preferredLanguage }: MindMapFetchOptions,
): Promise<MindMapGraphResponse> {
  const payload: Record<string, unknown> = {
    tenant_id: tenantId,
    user_id: userId ?? null,
    source_type: source.sourceType,
    source_id: source.sourceId,
    kind: source.kind ?? 'knowledge',
    force: false,
    preferred_language: preferredLanguage,
  }

  const resp = await fetch(`${baseUrl}/api/mindmaps/generate`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
    signal,
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Mind map request failed (${resp.status})`)
  }

  const raw = (await resp.json()) as any

  const nodes: MindMapNodePayload[] = Array.isArray(raw.nodes)
    ? raw.nodes.map((n: any) => ({
        id: String(n.id),
        label: String(n.label ?? ''),
        type: n.type ?? 'topic',
        parentId: n.parent_id ?? n.parentId ?? null,
        side: n.side ?? null,
        data: n.data ?? {},
      }))
    : []

  const edges: MindMapEdgePayload[] = Array.isArray(raw.edges)
    ? raw.edges.map((e: any) => ({
        id: String(e.id),
        source: String(e.source),
        target: String(e.target),
        label: e.label ?? null,
        type: e.type ?? 'default',
      }))
    : []

  const result: MindMapGraphResponse = {
    nodes,
    edges,
    rootId: (raw.root_id ?? raw.rootId ?? null) as string | null,
    cached: Boolean(raw.cached),
    hasQuestionRefs: Boolean(raw.has_question_refs ?? raw.hasQuestionRefs),
  }

  return result
}

export interface MindMapSavePayload {
  source: MindMapSourceRef
  tenantId: number
  userId?: number | null
  rootId?: string | null
  nodes: MindMapNodePayload[]
  edges: MindMapEdgePayload[]
}

export async function saveMindMapGraph(baseUrl: string, payload: MindMapSavePayload): Promise<MindMapGraphResponse> {
  const body: Record<string, unknown> = {
    tenant_id: payload.tenantId,
    user_id: payload.userId ?? null,
    source_type: payload.source.sourceType,
    source_id: payload.source.sourceId,
    kind: payload.source.kind ?? 'knowledge',
    root_id: payload.rootId ?? null,
    nodes: payload.nodes,
    edges: payload.edges,
  }

  const resp = await fetch(`${baseUrl}/api/mindmaps/save`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Mind map save failed (${resp.status})`)
  }

  return (await resp.json()) as MindMapGraphResponse
}
