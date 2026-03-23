import type { MindMapSourceRef } from '../../../types'
import type { MindMapDocumentPayload, MindMapMode } from '../domain/types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

export async function generateMindMap(
  baseUrl: string,
  source: MindMapSourceRef,
  tenantId: number,
  workroomId: number,
  userId?: number | null,
  mode: MindMapMode = 'knowledge_structure',
  force = false,
): Promise<MindMapDocumentPayload> {
  if (!Number.isFinite(workroomId) || workroomId <= 0) {
    throw new Error('Workroom context required before generating a mindmap')
  }
  const resp = await fetch(`${baseUrl}/api/mindmaps/generate`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      tenant_id: tenantId,
      workroom_id: workroomId,
      user_id: userId ?? null,
      source_type: source.sourceType,
      source_id: source.sourceId,
      source_ids: Array.isArray(source.sourceIds) ? source.sourceIds : [],
      kind: source.kind ?? 'knowledge',
      mode,
      force,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Mindmap generate failed (${resp.status})`)
  }

  return (await resp.json()) as MindMapDocumentPayload
}

export async function getCurrentMindMap(
  baseUrl: string,
  source: MindMapSourceRef,
  tenantId: number,
  workroomId: number,
  userId?: number | null,
  mode: MindMapMode = 'knowledge_structure',
): Promise<MindMapDocumentPayload | null> {
  if (!Number.isFinite(workroomId) || workroomId <= 0) {
    throw new Error('Workroom context required before loading current mindmap')
  }
  if (userId == null || !Number.isFinite(userId) || userId <= 0) {
    throw new Error('User context required before loading current mindmap')
  }

  const params = new URLSearchParams({
    tenant_id: String(tenantId),
    workroom_id: String(workroomId),
    user_id: String(userId),
    source_type: source.sourceType,
    source_id: String(source.sourceId),
    mode,
    kind: source.kind ?? 'knowledge',
  })
  for (const id of source.sourceIds ?? []) {
    params.append('source_ids', String(id))
  }
  const resp = await fetch(`${baseUrl}/api/mindmaps/current?${params.toString()}`, {
    method: 'GET',
    headers: JSON_HEADERS,
  })

  if (resp.status === 404) {
    return null
  }
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Mindmap current load failed (${resp.status})`)
  }
  return (await resp.json()) as MindMapDocumentPayload
}

export async function saveMindMap(
  baseUrl: string,
  tenantId: number,
  workroomId: number,
  userId: number | null | undefined,
  document: MindMapDocumentPayload,
): Promise<MindMapDocumentPayload> {
  if (!Number.isFinite(workroomId) || workroomId <= 0) {
    throw new Error('Workroom context required before saving a mindmap')
  }
  const resp = await fetch(`${baseUrl}/api/mindmaps/${document.id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      tenant_id: tenantId,
      workroom_id: workroomId,
      user_id: userId ?? null,
      document,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Mindmap save failed (${resp.status})`)
  }

  return (await resp.json()) as MindMapDocumentPayload
}
