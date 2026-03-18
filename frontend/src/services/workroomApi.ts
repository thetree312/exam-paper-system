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
