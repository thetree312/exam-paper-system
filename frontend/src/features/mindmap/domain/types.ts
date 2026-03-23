import type { MindMapSourceType } from '../../../types'

export type MindMapMode = 'knowledge_structure' | 'exam_review'

export interface MindMapQuestionRef {
  questionId?: number | null
  sequenceIndex?: number | null
  page?: number | null
}

export interface MindMapNodeTree {
  id: string
  topic: string
  summary?: string | null
  expanded?: boolean
  side?: 'left' | 'right' | null
  questionRefs: MindMapQuestionRef[]
  children: MindMapNodeTree[]
}

export interface MindMapRelation {
  id: string
  from: string
  to: string
  label?: string | null
}

export interface MindMapSummaryStyle {
  stroke?: string | null
  labelColor?: string | null
}

export interface MindMapSummary {
  id: string
  label: string
  parent: string
  start: number
  end: number
  style?: MindMapSummaryStyle | null
}

export interface MindMapViewState {
  scale: number
  translateX: number
  translateY: number
}

export interface MindMapDocumentPayload {
  id: number
  version: number
  source: {
    type: MindMapSourceType
    id: number
    ids?: number[]
    signature?: string | null
  }
  kind: string
  title?: string | null
  root: MindMapNodeTree
  relations: MindMapRelation[]
  summaries: MindMapSummary[]
  meta: {
    hasQuestionRefs: boolean
    generatedBy: 'llm' | 'manual' | 'system'
    mode?: MindMapMode
    updatedAt: string
  }
}
