import type { QuestionSyncPayload } from '../types'

type BuildQuestionSyncPayloadBase = {
  tenantId: number
  userId: string | number
  workroomId: string | number
  fallbackStudioDocumentId?: string | number | null
  fallbackSourceDocumentId?: string | number | null
}

type BuildQuestionSyncPayloadInput = Omit<
  QuestionSyncPayload,
  'tenantId' | 'userId' | 'workroomId' | 'studioDocumentId' | 'sourceDocumentId'
> & {
  studioDocumentId?: string | number | null
  sourceDocumentId?: string | number | null
}

export function buildQuestionSyncPayload(
  base: BuildQuestionSyncPayloadBase,
  input: BuildQuestionSyncPayloadInput,
): QuestionSyncPayload {
  const resolvedStudioDocumentId = input.studioDocumentId ?? base.fallbackStudioDocumentId ?? undefined
  if (resolvedStudioDocumentId == null || String(resolvedStudioDocumentId).trim() === '') {
    throw new Error('Missing studioDocumentId for question sync')
  }

  return {
    ...input,
    tenantId: base.tenantId,
    userId: base.userId,
    workroomId: base.workroomId,
    studioDocumentId: resolvedStudioDocumentId,
    sourceDocumentId: input.sourceDocumentId ?? base.fallbackSourceDocumentId ?? undefined,
  }
}
