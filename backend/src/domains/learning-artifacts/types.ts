export type ArtifactType = "question_card" | "mindmap" | "flashcard"

export type ArtifactLinkage = {
  wikiPaths: string[]
  documentIDs: string[]
  documentBlocks: Array<{
    documentID: string
    pageNumber: number
    layoutUnitKey?: string
  }>
  agentSessionIDs: string[]
}

export type QuestionCardPayload = {
  title: string
  prompt: string
  answer: string
  explanation?: string
}

export type MindmapPayload = {
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
    sourceType: "document" | "wiki_file" | "studio_document"
    documentIDs: string[]
    wikiPaths: string[]
    studioDocumentID?: string | null
  }
}

export type FlashcardPayload = {
  title: string
  front: string
  back: string
  hint?: string
  masteryState: "new" | "reviewing" | "mastered" | "struggling"
  bucket: number | null
  lastScore: 0 | 1 | 2 | null
  nextReviewAt: string | null
  lastReviewedAt: string | null
  reviewCount: number
  conceptTag?: string
  confidence?: number | null
  sourceRef?: {
    sourceType: "question" | "document_markdown"
    questionID?: string
    sequenceIndex?: number
    page?: number | null
    documentID: string
  }
}

export type LearningArtifactRecord = {
  id: string
  userID: string
  workroomID: string
  type: ArtifactType
  linkage: ArtifactLinkage
  payload: QuestionCardPayload | MindmapPayload | FlashcardPayload
  createdAt: string
  updatedAt: string
}

export type LearningArtifactsState = {
  items: LearningArtifactRecord[]
}

export type ArtifactGenerationSource =
  | {
      type: "document"
      documentID: string
      documentIDs?: string[]
    }
  | {
      type: "wiki_file"
      wikiPath: string
      wikiPaths?: string[]
    }
  | {
      type: "studio_document"
      studioDocumentID: string
    }
