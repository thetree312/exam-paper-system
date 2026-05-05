import { apiJson, withJsonBody } from '../lib/api'
import { createDocumentPreviewAssetRefs } from './documentPreviewAsset'
import type { WorkroomRuntimeState } from '../types'

export interface WorkroomFileTabDto {
  file_id: string
  session_id: string
  name: string
  source_type?: string | null
  status: string
  preview_url?: ReturnType<typeof createDocumentPreviewAssetRefs>[number] | null
  preview_pages: ReturnType<typeof createDocumentPreviewAssetRefs>
}

export interface WorkroomArtifactDto {
  artifact_type: string
  artifact_ref_id: string
  source_file_id?: string | null
  studio_document_id?: string | null
  payload_json: Record<string, unknown>
}

export async function updateWorkroomState(
  baseUrl: string,
  workroomId: string,
  _tenantId: number,
  _userId: string | number,
  patch: Partial<WorkroomRuntimeState>,
): Promise<WorkroomRuntimeState> {
  return apiJson(`${baseUrl}/api/workrooms/${workroomId}/state`, {
    method: 'PUT',
    ...withJsonBody(patch),
  })
}

export async function fetchWorkroomTabs(
  baseUrl: string,
  workroomId: string,
  _tenantId: number,
  _userId: string | number,
): Promise<WorkroomFileTabDto[]> {
  const data = (await apiJson<{ items: any[] }>(`${baseUrl}/api/documents?workroom_id=${workroomId}`, {
    method: 'GET',
  })) as { items: any[] }

  return data.items.map((item) => {
    const previewPages = createDocumentPreviewAssetRefs({
      documentId: item.id,
      workroomId,
      pageCount: Number(item.pageCount || 1),
    })

    return {
      file_id: String(item.id),
      session_id: String(item.id),
      name: String(item.name || item.fileName || item.id),
      source_type: String(item.mimeType || '').includes('pdf')
        ? 'pdf'
        : String(item.mimeType || '').includes('word') || String(item.mimeType || '').includes('officedocument')
          ? 'word'
          : String(item.mimeType || '').startsWith('image/')
            ? 'image'
            : null,
      status: 'ready',
      preview_url: previewPages[0] ?? null,
      preview_pages: previewPages,
    }
  })
}

export async function upsertWorkroomArtifact(
  baseUrl: string,
  workroomId: string,
  _tenantId: number,
  _userId: string | number,
  artifactType: string,
  artifactRefId: string,
  payload: {
    source_file_id?: string
    studio_document_id?: string
    payload_json: Record<string, unknown>
  },
): Promise<void> {
  await apiJson(`${baseUrl}/api/workrooms/${workroomId}/artifacts/${artifactType}/${artifactRefId}`, {
    method: 'PUT',
    ...withJsonBody({
      documentID: payload.source_file_id ?? null,
      payloadJson: payload.payload_json,
    }),
  })
}

export async function fetchWorkroomArtifact(
  baseUrl: string,
  workroomId: string,
  _tenantId: number,
  _userId: string | number,
  artifactType: string,
  artifactRefId: string,
): Promise<WorkroomArtifactDto | null> {
  try {
    return await apiJson<WorkroomArtifactDto>(
      `${baseUrl}/api/workrooms/${workroomId}/artifacts/${artifactType}/${artifactRefId}`,
      {
        method: 'GET',
      },
    )
  } catch {
    return null
  }
}
