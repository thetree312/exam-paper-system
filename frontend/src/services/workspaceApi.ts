import type { WorkspaceInfo, WorkspaceLaunchResponse, WorkroomCurrentResponse } from '../types'

const JSON_HEADERS = {
  'Content-Type': 'application/json',
}

export async function fetchWorkspaces(
  baseUrl: string,
  tenantId: number,
  userId: number,
): Promise<WorkspaceInfo[]> {
  const search = new URLSearchParams({
    tenant_id: String(tenantId),
    user_id: String(userId),
  })
  const resp = await fetch(`${baseUrl}/api/workspaces?${search.toString()}`, {
    method: 'GET',
    headers: JSON_HEADERS,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }
  return (await resp.json()) as WorkspaceInfo[]
}

export async function createWorkspace(
  baseUrl: string,
  payload: { tenantId: number; userId: number; name: string; topic?: string | null },
): Promise<WorkspaceLaunchResponse> {
  const resp = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      tenant_id: payload.tenantId,
      user_id: payload.userId,
      name: payload.name,
      topic: payload.topic ?? null,
    }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }
  return (await resp.json()) as WorkspaceLaunchResponse
}

export async function launchWorkspace(
  baseUrl: string,
  payload: { tenantId: number; userId: number; workspaceId: number },
): Promise<WorkroomCurrentResponse> {
  const search = new URLSearchParams({
    tenant_id: String(payload.tenantId),
    user_id: String(payload.userId),
  })
  const resp = await fetch(`${baseUrl}/api/workspaces/${payload.workspaceId}/launch?${search.toString()}`, {
    method: 'GET',
    headers: JSON_HEADERS,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }
  return (await resp.json()) as WorkroomCurrentResponse
}

export async function deleteWorkspace(
  baseUrl: string,
  payload: { tenantId: number; userId: number; workspaceId: number },
): Promise<void> {
  const search = new URLSearchParams({
    tenant_id: String(payload.tenantId),
    user_id: String(payload.userId),
  })
  const resp = await fetch(`${baseUrl}/api/workspaces/${payload.workspaceId}?${search.toString()}`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(text || `Request failed (${resp.status})`)
  }
}
