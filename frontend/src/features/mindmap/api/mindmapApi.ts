import { apiJson, withJsonBody } from '../../../lib/api'
import type { MindMapSourceRef } from '../../../types'
import type { MindMapDocumentPayload, MindMapMode, MindMapNodeTree } from '../domain/types'

type MindmapArtifactRecord = {
  id: string
  linkage: {
    documentIDs: string[]
    wikiPaths: string[]
  }
  payload: {
    title: string
    nodes: Array<{
      id: string
      label: string
      parentID?: string
    }>
    edges: Array<{
      id: string
      from: string
      to: string
    }>
    generatedFrom?: {
      sourceType: 'document' | 'wiki_file' | 'studio_document'
      documentIDs: string[]
      wikiPaths: string[]
      studioDocumentID?: string | null
    }
  }
  updatedAt: string
}

function buildTree(nodes: MindmapArtifactRecord['payload']['nodes']): MindMapNodeTree {
  const nodeMap = new Map<string, MindMapNodeTree>()
  for (const node of nodes) {
    nodeMap.set(node.id, {
      id: node.id,
      topic: node.label,
      summary: null,
      expanded: true,
      questionRefs: [],
      children: [],
    })
  }

  let root: MindMapNodeTree | null = null
  for (const node of nodes) {
    const current = nodeMap.get(node.id)!
    if (node.parentID && nodeMap.has(node.parentID)) {
      nodeMap.get(node.parentID)!.children.push(current)
    } else if (!root) {
      root = current
    }
  }

  if (root) return root
  return {
    id: 'mindmap-root',
    topic: 'Mindmap',
    summary: null,
    expanded: true,
    questionRefs: [],
    children: Array.from(nodeMap.values()),
  }
}

function toArtifactSource(source: MindMapSourceRef) {
  if (source.sourceType === 'studio_document') {
    return {
      type: 'studio_document' as const,
      studioDocumentID: source.sourceId,
    }
  }

  if (source.sourceType === 'wiki_file') {
    return {
      type: 'wiki_file' as const,
      wikiPath: source.sourceId,
      wikiPaths: source.sourceIds,
    }
  }

  return {
    type: 'document' as const,
    documentID: source.sourceId,
    documentIDs: source.sourceIds,
  }
}

function fromArtifact(record: MindmapArtifactRecord, mode: MindMapMode): MindMapDocumentPayload {
  const generatedFrom = record.payload.generatedFrom
  const sourceType = generatedFrom?.sourceType ?? 'document'
  const sourceID =
    sourceType === 'studio_document'
      ? generatedFrom?.studioDocumentID ?? record.linkage.documentIDs[0] ?? record.id
      : sourceType === 'wiki_file'
        ? generatedFrom?.wikiPaths[0] ?? record.id
        : generatedFrom?.documentIDs[0] ?? record.linkage.documentIDs[0] ?? record.id

  return {
    id: record.id,
    version: 1,
    source: {
      type: sourceType,
      id: sourceID,
      ids: sourceType === 'wiki_file' ? generatedFrom?.wikiPaths : generatedFrom?.documentIDs,
      signature:
        sourceType === 'wiki_file'
          ? generatedFrom?.wikiPaths?.join(',')
          : generatedFrom?.documentIDs?.join(',') ?? generatedFrom?.studioDocumentID ?? null,
    },
    kind: 'knowledge',
    title: record.payload.title,
    root: buildTree(record.payload.nodes),
    relations: record.payload.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: null,
    })),
    summaries: [],
    meta: {
      hasQuestionRefs: false,
      generatedBy: 'llm',
      mode,
      updatedAt: record.updatedAt,
    },
  }
}

export async function generateMindMap(
  baseUrl: string,
  source: MindMapSourceRef,
  _tenantId: number,
  workroomId: string,
  _userId?: string | number | null,
  mode: MindMapMode = 'knowledge_structure',
  force = false,
): Promise<MindMapDocumentPayload> {
  const result = await apiJson<{ item: MindmapArtifactRecord }>(
    `${baseUrl}/api/learning-artifacts/mindmaps/generate`,
    {
      method: 'POST',
      ...withJsonBody({
        workroomID: workroomId,
        source: toArtifactSource(source),
        mode,
        force,
      }),
    },
  )
  return fromArtifact(result.item, mode)
}

export async function getCurrentMindMap(
  baseUrl: string,
  source: MindMapSourceRef,
  _tenantId: number,
  workroomId: string,
  _userId?: string | number | null,
  mode: MindMapMode = 'knowledge_structure',
): Promise<MindMapDocumentPayload | null> {
  const params = new URLSearchParams({
    workroom_id: workroomId,
  })

  if (source.sourceType === 'studio_document') {
    params.set('studio_document_id', String(source.sourceId))
  } else if (source.sourceType === 'wiki_file') {
    params.set('wiki_path', String(source.sourceId))
    for (const item of source.sourceIds ?? []) {
      params.append('wiki_path', String(item))
    }
  } else {
    params.set('document_id', String(source.sourceId))
    for (const item of source.sourceIds ?? []) {
      params.append('document_id', String(item))
    }
  }

  try {
    const item = await apiJson<MindmapArtifactRecord | null>(
      `${baseUrl}/api/learning-artifacts/mindmaps/current?${params.toString()}`,
      {
        method: 'GET',
      },
    )
    return item ? fromArtifact(item, mode) : null
  } catch {
    return null
  }
}

export async function saveMindMap(
  baseUrl: string,
  _tenantId: number,
  workroomId: string,
  _userId: string | number | null | undefined,
  document: MindMapDocumentPayload,
): Promise<MindMapDocumentPayload> {
  const flattenNodes = (
    node: MindMapNodeTree,
    parentID?: string,
  ): Array<{ id: string; label: string; parentID: string | undefined }> => {
    const current = [{ id: node.id, label: node.topic, parentID }]
    return current.concat(...node.children.map((child) => flattenNodes(child, node.id)))
  }

  const payload = {
    title: document.title ?? 'Mindmap',
    nodes: flattenNodes(document.root),
    edges: document.relations.map((relation) => ({
      id: relation.id,
      from: relation.from,
      to: relation.to,
    })),
  }

  const saved = await apiJson<MindmapArtifactRecord>(
    `${baseUrl}/api/learning-artifacts/mindmaps/${document.id}`,
    {
      method: 'PUT',
      ...withJsonBody({
        workroomID: workroomId,
        payload,
        linkage: {
          documentIDs: document.source.type === 'document' ? [document.source.id, ...(document.source.ids ?? [])] : [],
          wikiPaths: document.source.type === 'wiki_file' ? [document.source.id, ...(document.source.ids ?? [])] : [],
          documentBlocks: [],
          agentSessionIDs: [],
        },
      }),
    },
  )

  return fromArtifact(saved, document.meta.mode ?? 'knowledge_structure')
}
