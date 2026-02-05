import type { MindMapNodePayload } from '../../types'

export const NODE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'topic', label: '主题 topic' },
  { value: 'subtopic', label: '子主题 subtopic' },
  { value: 'concept', label: '知识点 concept' },
  { value: 'detail', label: '细化 detail' },
  { value: 'sub_detail', label: '次级细化 sub_detail' },
  { value: 'stage', label: '阶段 stage' },
  { value: 'timeline', label: '时间线 timeline' },
  { value: 'question_ref', label: '题目引用 question_ref' },
  { value: 'example', label: '例子 example' },
]

const DESCRIPTION_LIMIT_BY_TYPE: Record<string, number> = {
  topic: 15,
  subtopic: 18,
  concept: 22,
  detail: 25,
  sub_detail: 25,
  stage: 22,
  timeline: 22,
  question_ref: 22,
  example: 22,
  default: 20,
}

export function getDescriptionLimit(node: MindMapNodePayload): number {
  if (!node.parentId) return 15
  return DESCRIPTION_LIMIT_BY_TYPE[node.type ?? 'default'] ?? DESCRIPTION_LIMIT_BY_TYPE.default
}
