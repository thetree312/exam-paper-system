import { createID } from "../../lib/ids"
import { LearningArtifactsLlmService } from "./llm-service"
import { buildMindmapExpandSystemPrompt, buildMindmapOutlineSystemPrompt } from "./prompts"
import { SourceMaterialService } from "./source-material-service"
import type { ArtifactGenerationSource, MindmapPayload } from "./types"

type OutlineTopic = {
  id: string
  label: string
  summary: string
  children: Array<{
    id: string
    label: string
    summary: string
  }>
}

function normalizeString(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function parseOutline(payload: Record<string, unknown>) {
  const title = normalizeString(payload.title)
  const topicsRaw = Array.isArray(payload.topics) ? payload.topics : []
  const topics: OutlineTopic[] = []

  for (const rawTopic of topicsRaw) {
    if (!rawTopic || typeof rawTopic !== "object") continue
    const topic = rawTopic as Record<string, unknown>
    const label = normalizeString(topic.label)
    const summary = normalizeString(topic.summary)
    const rawChildren = Array.isArray(topic.children) ? topic.children : []
    if (!label || !summary) continue
    topics.push({
      id: normalizeString(topic.id) ?? createID("mindmap_topic"),
      label,
      summary,
      children: rawChildren
        .map((rawChild) => {
          if (!rawChild || typeof rawChild !== "object") return null
          const child = rawChild as Record<string, unknown>
          const childLabel = normalizeString(child.label)
          const childSummary = normalizeString(child.summary)
          if (!childLabel || !childSummary) return null
          return {
            id: normalizeString(child.id) ?? createID("mindmap_topic"),
            label: childLabel,
            summary: childSummary,
          }
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    })
  }

  if (!title || topics.length === 0) {
    throw new Error("Mindmap outline returned no valid title/topics")
  }
  return {
    title,
    topics,
  }
}

function parseExpandedMindmap(payload: Record<string, unknown>, sourceMeta: MindmapPayload["generatedFrom"]): MindmapPayload {
  const title = normalizeString(payload.title)
  const nodesRaw = Array.isArray(payload.nodes) ? payload.nodes : []
  const edgesRaw = Array.isArray(payload.edges) ? payload.edges : []

  const nodes = nodesRaw
    .map((rawNode) => {
      if (!rawNode || typeof rawNode !== "object") return null
      const node = rawNode as Record<string, unknown>
      const id = normalizeString(node.id)
      const label = normalizeString(node.label)
      const parentID = normalizeString(node.parentID)
      if (!id || !label) return null
      return {
        id,
        label,
        parentID: parentID ?? undefined,
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  const edges = edgesRaw
    .map((rawEdge) => {
      if (!rawEdge || typeof rawEdge !== "object") return null
      const edge = rawEdge as Record<string, unknown>
      const id = normalizeString(edge.id)
      const from = normalizeString(edge.from)
      const to = normalizeString(edge.to)
      if (!id || !from || !to) return null
      return { id, from, to }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  if (!title || nodes.length === 0 || edges.length === 0) {
    throw new Error("Mindmap generation returned invalid graph")
  }

  return {
    title,
    nodes,
    edges,
    generatedFrom: sourceMeta,
  }
}

export const MindmapGenerationService = {
  async generate(input: {
    userID: string
    workroomID: string
    source: ArtifactGenerationSource
    mode: "knowledge_structure" | "exam_review"
  }): Promise<MindmapPayload> {
    const material = await SourceMaterialService.buildMindmapMaterial({
      userID: input.userID,
      workroomID: input.workroomID,
      source: input.source,
    })

    const outlinePayload = await LearningArtifactsLlmService.chatJson({
      userID: input.userID,
      capability: "mindmap_outline_generation",
      system: buildMindmapOutlineSystemPrompt({
        title: material.title,
        mode: input.mode,
        sourceType: material.sourceType,
        sourceId: material.sourceKey,
      }),
      user: [
        `标题建议: ${material.title}`,
        `来源类型: ${material.sourceType}`,
        `来源标识: ${material.sourceKey}`,
        `模式: ${input.mode}`,
        "原始材料如下：",
        material.body,
      ].join("\n\n"),
      temperature: 0.2,
      topP: 0.8,
      maxTokens: 3000,
    })

    const outline = parseOutline(outlinePayload)

    const graphPayload = await LearningArtifactsLlmService.chatJson({
      userID: input.userID,
      capability: "mindmap_generation",
      system: buildMindmapExpandSystemPrompt({
        title: outline.title,
        mode: input.mode,
        sourceType: material.sourceType,
        sourceId: material.sourceKey,
      }),
      user: [
        `脑图标题: ${outline.title}`,
        `模式: ${input.mode}`,
        "大纲如下：",
        JSON.stringify(outline, null, 2),
      ].join("\n\n"),
      temperature: 0.1,
      topP: 0.7,
      maxTokens: 3000,
    })

    return parseExpandedMindmap(graphPayload, {
      sourceType: material.sourceType,
      documentIDs: material.sourceMeta.documentIDs,
      wikiPaths: material.sourceMeta.wikiPaths,
      studioDocumentID: material.sourceMeta.studioDocumentID ?? null,
    })
  },
}
