import { apiFetch } from '../lib/api'
import type { DocumentPreviewAssetRef } from '../types'

export function createDocumentPreviewAssetRef(input: {
  documentId: string | number
  workroomId: string | number
  page: number
}): DocumentPreviewAssetRef {
  return {
    kind: 'document-preview',
    documentId: input.documentId,
    workroomId: input.workroomId,
    page: input.page,
  }
}

export function createDocumentPreviewAssetRefs(input: {
  documentId: string | number
  workroomId: string | number
  pageCount: number
}): DocumentPreviewAssetRef[] {
  return Array.from({ length: Math.max(1, input.pageCount) }, (_, index) =>
    createDocumentPreviewAssetRef({
      documentId: input.documentId,
      workroomId: input.workroomId,
      page: index + 1,
    }),
  )
}

export function documentPreviewAssetKey(input: DocumentPreviewAssetRef) {
  return `${input.kind}:${input.workroomId}:${input.documentId}:${input.page}`
}

export function buildDocumentPreviewAssetUrl(baseUrl: string, input: DocumentPreviewAssetRef) {
  const search = new URLSearchParams()
  search.set('workroom_id', String(input.workroomId))
  search.set('page', String(input.page))
  return `${baseUrl}/api/documents/${input.documentId}/preview?${search.toString()}`
}

export async function fetchDocumentPreviewObjectUrl(
  baseUrl: string,
  input: DocumentPreviewAssetRef,
): Promise<string> {
  const response = await apiFetch(buildDocumentPreviewAssetUrl(baseUrl, input), {
    method: 'GET',
  })
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}
