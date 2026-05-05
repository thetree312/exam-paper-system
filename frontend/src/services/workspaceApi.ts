import { apiFetch, apiJson, withJsonBody } from '../lib/api'
import type { WorkroomArtifact, WorkroomCurrentResponse, WorkroomInfo } from '../types'

export function mapWorkroom(input: any): WorkroomInfo {
  const workspaceId = input.workspaceID ?? input.workspace_id ?? input.id ?? null
  return {
    id: String(input.id),
    workspace_id: workspaceId != null ? String(workspaceId) : null,
    tenant_id: Number(input.tenantID ?? input.tenant_id ?? 0),
    user_id: String(input.userID ?? input.user_id ?? ''),
    name: String(input.name || ''),
    status: String(input.status ?? 'ready'),
  }
}

export async function fetchWorkspaces(
  baseUrl: string,
  _tenantId: number,
  _userId: string,
): Promise<WorkroomInfo[]> {
  const data = await apiJson<{ items: unknown[] }>(`${baseUrl}/api/workrooms`, {
    method: 'GET',
  })
  return data.items.map(mapWorkroom)
}

export async function createWorkspace(
  baseUrl: string,
  payload: { tenantId: number; userId: string; name: string; topic?: string | null },
): Promise<{ workspace: WorkroomInfo }> {
  const workroom = await apiJson(`${baseUrl}/api/workrooms`, {
    method: 'POST',
    ...withJsonBody({
      name: payload.name,
    }),
  })

  return {
    workspace: mapWorkroom(workroom),
  }
}

async function fetchOptionalArtifact(
  baseUrl: string,
  workroomId: string,
  artifactType: string,
  artifactRefId: string,
): Promise<WorkroomArtifact | null> {
  try {
    return await apiJson<WorkroomArtifact>(
      `${baseUrl}/api/workrooms/${workroomId}/artifacts/${artifactType}/${artifactRefId}`,
      {
        method: 'GET',
      },
    )
  } catch {
    return null
  }
}

export async function launchWorkspace(
  baseUrl: string,
  payload: { tenantId: number; userId: string; workspaceId: string },
): Promise<WorkroomCurrentResponse> {
  const payloadData = await apiJson<any>(`${baseUrl}/api/workrooms/${payload.workspaceId}`, {
    method: 'GET',
  })

  const workroom = payloadData.workroom ? mapWorkroom(payloadData.workroom) : mapWorkroom(payloadData)
  const runtimeState = payloadData.runtimeState ?? payloadData.runtime_state ?? null
  const sources = Array.isArray(payloadData.sources) ? payloadData.sources : payloadData.sources?.items ?? []
  const existingArtifacts = Array.isArray(payloadData.artifacts) ? payloadData.artifacts : []
  const documents = Array.isArray(payloadData.documents) ? payloadData.documents : []
  const restoration = payloadData.restoration ?? {
    openDocumentIDs: runtimeState?.open_document_ids ?? [],
    activeDocumentID: runtimeState?.active_file_id ?? null,
    activeStudioDocumentID: runtimeState?.active_studio_document_id ?? null,
    activeAgentSessionID: runtimeState?.active_agent_session_id ?? null,
    activeExtractionSessionID: runtimeState?.active_extraction_session_id ?? null,
  }

  if (existingArtifacts.length > 0) {
    return {
      workroom,
      runtime_state: runtimeState,
      sources,
      artifacts: existingArtifacts,
      documents,
      restoration,
    }
  }

  const mindmapPanelArtifact = await fetchOptionalArtifact(baseUrl, payload.workspaceId, 'mindmap_panel', 'current')
  return {
    workroom,
    runtime_state: runtimeState,
    sources,
    artifacts: mindmapPanelArtifact ? [mindmapPanelArtifact] : [],
    documents,
    restoration,
  }
}

export async function deleteWorkspace(
  baseUrl: string,
  payload: { tenantId: number; userId: string; workspaceId: string },
): Promise<void> {
  await apiFetch(`${baseUrl}/api/workrooms/${payload.workspaceId}`, {
    method: 'DELETE',
  })
}
