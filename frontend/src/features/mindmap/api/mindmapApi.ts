import type { MindMapSourceRef } from '../../../types'
import type { MindMapDocumentPayload } from '../domain/types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

export async function generateMindMap(
  baseUrl: string,
  source: MindMapSourceRef,
  tenantId: number,
  workroomId: number,
  userId?: number | null,
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
      kind: source.kind ?? 'knowledge',
      force,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Mindmap generate failed (${resp.status})`)
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
