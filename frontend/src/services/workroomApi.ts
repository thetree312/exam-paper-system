import type { WorkroomRuntimeState } from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

export interface WorkroomFileTabDto {
  file_id: number
  session_id: number
  name: string
  source_type?: string | null
  status: string
  preview_url?: string | null
  preview_pages: string[]
}

export interface WorkroomArtifactDto {
  artifact_type: string
  artifact_ref_id: string
  source_file_id?: number | null
  studio_document_id?: number | null
  payload_json: Record<string, unknown>
}

export async function updateWorkroomState(
  baseUrl: string,
  workroomId: number,
  tenantId: number,
  userId: number,
  patch: Partial<WorkroomRuntimeState>,
): Promise<WorkroomRuntimeState> {
  const resp = await fetch(`${baseUrl}/api/workrooms/${workroomId}/state`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      tenant_id: tenantId,
      user_id: userId,
      ...patch,
    }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }
  return (await resp.json()) as WorkroomRuntimeState
}

export async function fetchWorkroomTabs(
  baseUrl: string,
  workroomId: number,
  tenantId: number,
  userId: number,
): Promise<WorkroomFileTabDto[]> {
  const search = new URLSearchParams({
    tenant_id: String(tenantId),
    user_id: String(userId),
  })
  const resp = await fetch(`${baseUrl}/api/files/workroom/${workroomId}/tabs?${search.toString()}`, {
    method: 'GET',
    headers: JSON_HEADERS,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }
  return (await resp.json()) as WorkroomFileTabDto[]
}

export async function upsertWorkroomArtifact(
  baseUrl: string,
  workroomId: number,
  tenantId: number,
  userId: number,
  artifactType: string,
  artifactRefId: string,
  payload: {
    source_file_id?: number
    studio_document_id?: number
    payload_json: Record<string, unknown>
  },
): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/workrooms/${workroomId}/artifacts/${artifactType}/${artifactRefId}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      tenant_id: tenantId,
      user_id: userId,
      source_file_id: payload.source_file_id ?? null,
      studio_document_id: payload.studio_document_id ?? null,
      payload_json: payload.payload_json,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Artifact upsert failed (${resp.status})`)
  }
}

export async function fetchWorkroomArtifact(
  baseUrl: string,
  workroomId: number,
  tenantId: number,
  userId: number,
  artifactType: string,
  artifactRefId: string,
): Promise<WorkroomArtifactDto | null> {
  const search = new URLSearchParams({
    tenant_id: String(tenantId),
    user_id: String(userId),
  })
  const resp = await fetch(
    `${baseUrl}/api/workrooms/${workroomId}/artifacts/${artifactType}/${artifactRefId}?${search.toString()}`,
    {
      method: 'GET',
      headers: JSON_HEADERS,
    },
  )
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Artifact fetch failed (${resp.status})`)
  }
  const payload = (await resp.json()) as WorkroomArtifactDto | null
  return payload
}
