import type { MathContentDocument } from './lib/mathContent'

export type AuthMode = 'login' | 'register'

export type StatusMessageKey =
  | 'upload_prompt'
  | 'login_required'
  | 'logged_in'
  | 'tab_placeholder'
  | 'uploading'
  | 'unsupported_file'
  | 'append_image'
  | 'preview_generating'
  | 'upload_failed'
  | 'selection_missing'
  | 'session_missing'
  | 'selection_cross_upload'
  | 'selection_invalid'
  | 'ocr_running'
  | 'ocr_done'
  | 'ocr_failed'
  | 'split_running'
  | 'split_failed_keep'
  | 'split_done'
  | 'split_failed'
  | 'grading_none'
  | 'grading_running'
  | 'grading_done'
  | 'grading_failed'
  | 'export_none'
  | 'export_running'
  | 'export_done'
  | 'export_failed'
  | 'glm_done'

export type StatusMessageSetter = (
  key: StatusMessageKey,
  values?: Record<string, string | number>,
) => void

export interface UserInfo {
  id: string | number
  tenant_id: number
  email: string
  display_name: string
  token?: string
  session_id?: string
}

export interface WorkspaceInfo {
  id: string | number
  tenant_id: number
  user_id: string | number
  name: string
  topic?: string | null
  status: string
}

export interface WorkroomInfo {
  id: string | number
  workspace_id?: string | number | null
  tenant_id: number
  user_id: string | number
  name: string
  status: string
}

export interface WorkroomRuntimeState {
  id?: string | number
  active_file_id?: string | number | null
  active_session_id?: string | number | null
  active_tab_index: number
  active_studio_document_id?: string | number | null
  active_agent_session_id?: string | number | null
  active_extraction_session_id?: string | number | null
  open_document_ids?: Array<string | number>
  left_panel_state_json: Record<string, unknown>
  center_panel_state_json: Record<string, unknown>
  right_panel_state_json: Record<string, unknown>
}

export type StudioTabKind = 'editor' | 'mindmap' | 'flashcard' | 'preview'

export interface StudioPreviewTabPayload {
  path: string
  savedContent: string
  draftContent: string
  isDirty: boolean
  viewMode?: 'edit' | 'markdown-read'
  lastSavedAt?: string | null
  saveError?: string | null
}

export interface StudioWorkspaceTab {
  id: string
  kind: StudioTabKind
  title: string
  closable: boolean
  payload?: StudioPreviewTabPayload
}

export interface WorkroomSourceBinding {
  file_id: string | number
  source_id?: string | number | null
  is_active: boolean
}

export interface WorkroomArtifact {
  artifact_type: string
  artifact_ref_id: string
  source_file_id?: string | number | null
  studio_document_id?: string | number | null
  payload_json: Record<string, unknown>
}

export interface WikiTreeItem {
  path: string
  type: 'file' | 'directory'
  sizeBytes: number
  updatedAt: string
}

export interface WorkroomTreeItem {
  path: string
  type: 'file' | 'directory'
  sizeBytes: number
  updatedAt: string
}

export interface WorkroomTreeVersion {
  workroomID: string
  versionID: string
  itemCount: number
}

export interface WorkroomRecoveryDocument {
  id: string | number
  name: string
  mimeType: string
  sourceType?: string | null
  status: 'uploaded' | 'preview_ready' | 'layout_ready' | 'markdown_ready' | 'ready' | 'failed'
  previewPages: Array<{
    pageNumber: number
  }>
  lastError?: {
    code: string
    message: string
    retryable: boolean
    stage: string
    details?: Record<string, unknown>
  } | null
}

export interface WorkroomRestorationPayload {
  openDocumentIDs: Array<string | number>
  activeDocumentID?: string | number | null
  activeStudioDocumentID?: string | number | null
  activeAgentSessionID?: string | number | null
  activeExtractionSessionID?: string | number | null
}

export interface WorkroomCurrentResponse {
  workroom: WorkroomInfo
  runtime_state: WorkroomRuntimeState | null
  sources: WorkroomSourceBinding[]
  artifacts: WorkroomArtifact[]
  documents: WorkroomRecoveryDocument[]
  restoration: WorkroomRestorationPayload
}

export interface WorkspaceLaunchResponse {
  workspace: WorkspaceInfo
  workroom: WorkroomInfo
}

export interface FlashcardItem {
  cardId: string
  documentId: string | number | null
  questionId: string | number | null
  sequenceIndex?: number | null
  page?: number | null
  conceptTag: string
  cue: string
  answer: string
  confidence?: number | null
  masteryState: 'new' | 'reviewing' | 'mastered' | 'struggling'
  bucket?: number | null
  nextReviewAt?: string | null
  lastScore?: number | null
  reviewCount: number
  sourceRef?: Record<string, unknown> | null
}

export interface FlashcardGenerateResult {
  mode: 'cached' | 'generated'
  cardCount: number
}

export interface FlashcardReviewResult {
  artifactID: string
  score: number
  bucket: number | null
  nextReviewAt: string | null
}

export interface FlashcardMasteryStats {
  total: number
  neverReviewed: number
  mastered: number
  reviewing: number
  struggling: number
  dueToday: number
}

export interface FlashcardAgentEscalateResult {
  escalated: boolean
  artifactID: string
  title: string
  message: string
}

export type FlashcardMode = 'exam' | 'article'

export interface PageSelectionSegment {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface SelectionExclusion extends PageSelectionSegment {
  id: string
}

export interface SelectionLegend extends PageSelectionSegment {
  id: string
}

export interface SelectionBox {
  x: number
  y: number
  width: number
  height: number
  segments: PageSelectionSegment[]
  exclusions: SelectionExclusion[]
  legends?: SelectionLegend[]
}

export interface RegionPayload {
  page: number
  x: number
  y: number
  width: number
  height: number
  exclusions?: Omit<PageSelectionSegment, 'page'>[]
}

export interface OcrResult {
  region_index: number
  text: string
}

export type GradingJudgement = 'pending' | 'correct' | 'incorrect' | 'skipped' | 'uncertain' | 'error'

export interface QuestionVersionRecord {
  content: string
  legendImages: string[]
  studentAnswer?: string | null
  canonicalAnswer?: string | null
  grading?: {
    judgement?: string | null
    predictedAnswer?: string | null
    reasoning?: string | null
    confidence?: number | null
  }
  capturedAt?: string
  page?: number | null
  origin?: {
    requestLabel?: string
    agentRunId?: string
  }
  solution?: QuestionSolutionPayload
}

export interface QuestionSolutionPayload {
  finalAnswer?: string
  analysis?: string
}

export interface AggregatedOcrItem extends OcrResult {
  id: string
  sessionId: string | number
  fileId: string | number
  fileName: string
  page: number
  createdAt: number
  legendImages?: string[]
  originalText?: string
  answerContent?: MathContentDocument
  answerText?: string
  canonicalAnswer?: string
  sourceType?: 'upload' | 'favorite'
  documentContext?: {
    studioDocumentID: string
    sourceDocumentID?: string | null
  } | null
  questionMeta?: {
    questionId?: number
    sequenceIndex?: number
    groupId?: number | null
  }
  versions?: QuestionVersionRecord[]
  activeVersionIndex?: number
  uiState?: {
    shinyUntil?: number
    variant?: 'replace' | 'insert'
  }
  noteSource?: NoteSourceMeta
  solution?: QuestionSolutionPayload | null
  grading?: {
    status: GradingJudgement
    predictedAnswer?: string
    reasoning?: string
    confidence?: number | null
    rawResponse?: string
    error?: string
  }
}

export interface LegendRegionPayload {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface LegendResponse {
  images: string[]
}

export type TabStatus = 'pending' | 'processing' | 'ready' | 'failed'

export interface SessionStatus {
  session_id: string | number
  file_id: string | number
  status: 'pending' | 'processing' | 'done' | 'failed'
  preview_url?: string | null
  preview_pages?: string[]
}

export interface UploadedFileTab {
  sessionId: string | number
  fileId: string | number
  name: string
  previewType: 'image' | 'pdf' | 'word' | null
  previewUrl: DocumentPreviewAssetRef | null
  previewPages: DocumentPreviewAssetRef[]
  pageSessionIds?: Array<string | number>
  pageFileIds?: Array<string | number>
  pageStatuses?: TabStatus[]
  status: TabStatus
  isPlaceholder?: boolean
}

export interface DocumentPreviewAssetRef {
  kind: 'document-preview'
  documentId: string | number
  workroomId: string | number
  page: number
}

export interface AgentQuestion {
  id: number
  sequenceIndex: number
  groupId?: number | null
  page?: number | null
  content: string
  legendImages: string[]
  studentAnswer?: string | null
  canonicalAnswer?: string | null
  gradingJudgement?: string | null
  gradingPredictedAnswer?: string | null
  gradingReasoning?: string | null
  gradingConfidence?: number | null
  versions?: QuestionVersionRecord[]
}

export interface QuestionSyncPayload {
  tenantId: number
  userId: string | number
  workroomId: string | number
  studioDocumentId: string | number
  sourceDocumentId?: string | number | null
  sessionId?: string | number | null
  fileId?: string | number | null
  questionId?: number | null
  sequenceIndex: number
  page?: number | null
  content: string
  legendImages?: string[]
  title?: string | null
  studentAnswer?: string | null
  canonicalAnswer?: string | null
  sourceType?: 'upload' | 'favorite'
}

export interface QuestionSyncResponse {
  studio_document_id: string | number
  source_document_id?: string | number | null
  question: {
    id: number
    sequence_index: number
  }
}

export interface AgentSnapshotResponse {
  studio_document_id: string | number
  source_document_id?: string | number | null
  title: string
  status: string
  questions: AgentQuestion[]
}

export interface AgentMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  token_usage?: number | null
  created_at: string
}

export interface CitationBBoxNorm {
  x: number
  y: number
  w: number
  h: number
}

export type AgentCitationStatus = 'none' | 'partial' | 'complete'

export interface AgentCitationAnchor {
  citation_id: string
  citation_index: number
  source_ref: string
  anchor_type?: string | null
  file_id: string | number
  page_no: number
  unit_key?: string | null
  chunk_id?: number | null
  chunk_type?: string | null
  title?: string | null
  excerpt?: string | null
  asset_kind?: string | null
  asset_ref?: string | null
  preview_url?: string | null
  bbox_norm?: CitationBBoxNorm | null
  bbox_abs?: Record<string, unknown> | null
}

export interface AgentFinalAnswerPayload {
  answer_text: string
  used_rag_evidence: boolean
  citation_status: AgentCitationStatus
  citations: AgentCitationAnchor[]
  cited_indices?: number[]
}

export interface AgentSessionFact {
  id: string
  slug?: string
  title?: string | null
  project_id?: string | null
  workspace_id?: string | null
  directory?: string | null
  parent_id?: string | null
  version?: string | null
  summary?: Record<string, unknown> | null
  share?: Record<string, unknown> | null
  revert?: Record<string, unknown> | null
  permission?: Array<Record<string, unknown>> | null
  time: {
    created?: number
    updated?: number
    compacting?: number
    archived?: number
  }
}

export interface AgentMessageInfoFact {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  time: Record<string, unknown>
  parent_id?: string | null
  provider_id?: string | null
  model_id?: string | null
  agent?: string | null
  path?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
  summary?: boolean | Record<string, unknown> | null
  cost?: number | null
  tokens?: Record<string, unknown> | null
  structured?: unknown
  variant?: string | null
  finish?: string | null
}

export interface AgentPartFactBase {
  id: string
  session_id: string
  message_id: string
  type: string
}

export interface AgentTextPartFact extends AgentPartFactBase {
  type: 'text'
  text: string
  phase?: 'commentary' | 'final_answer'
  synthetic?: boolean
  ignored?: boolean
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export interface AgentCommentaryPartFact extends AgentPartFactBase {
  type: 'commentary'
  text: string
  phase?: 'commentary'
  synthetic?: boolean
  ignored?: boolean
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export interface AgentFinalAnswerPartFact extends AgentPartFactBase {
  type: 'final_answer'
  text: string
  phase?: 'final_answer'
  synthetic?: boolean
  ignored?: boolean
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export interface AgentReasoningPartFact extends AgentPartFactBase {
  type: 'reasoning'
  text: string
  time?: Record<string, unknown>
  metadata?: Record<string, unknown> | null
}

export interface AgentFilePartFact extends AgentPartFactBase {
  type: 'file'
  mime: string
  filename?: string
  url: string
  source?: Record<string, unknown> | null
}

export type AgentToolStateFact =
  | {
      status: 'pending'
      input: Record<string, unknown>
      raw?: string
    }
  | {
      status: 'running'
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown> | null
      time?: Record<string, unknown>
    }
  | {
      status: 'completed'
      input: Record<string, unknown>
      output: string
      title?: string
      metadata?: Record<string, unknown> | null
      time?: Record<string, unknown>
      attachments?: AgentFilePartFact[]
    }
  | {
      status: 'error'
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown> | null
      time?: Record<string, unknown>
    }

export interface AgentToolPartFact extends AgentPartFactBase {
  type: 'tool'
  call_id: string
  tool: string
  state: AgentToolStateFact
  metadata?: Record<string, unknown> | null
}

export type AgentGenericPartFact = AgentPartFactBase & Record<string, unknown>

export type AgentMessagePartFact =
  | AgentTextPartFact
  | AgentCommentaryPartFact
  | AgentFinalAnswerPartFact
  | AgentReasoningPartFact
  | AgentFilePartFact
  | AgentToolPartFact
  | AgentGenericPartFact

export interface AgentMessageFact {
  info: AgentMessageInfoFact
  parts: AgentMessagePartFact[]
}

export interface AgentPermissionAskedFact {
  id: string
  session_id: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    message_id?: string | null
    call_id?: string | null
  } | null
}

export interface AgentQuestionAskedFact {
  id: string
  session_id: string
  questions: Array<{
    question: string
    header: string
    options: Array<{
      label: string
      description: string
    }>
    multiple?: boolean
    custom?: boolean
  }>
  tool?: {
    message_id?: string | null
    call_id?: string | null
  } | null
}

export interface AgentCitationFocus {
  token: number
  citationId: string
  fileId: string | number
  pageNo: number
  bboxNorm?: CitationBBoxNorm | null
}

export type AgentRunContext = 'blank' | 'exam_editor' | 'code_editor' | 'other' | 'batch_question'

export type AgentThinkingTraceKind = 'thought' | 'tool'

export interface AgentThinkingThoughtTrace {
  id: string
  type: 'thought'
  label?: string
  text?: string
}

export interface AgentThinkingToolTrace {
  id: string
  type: 'tool'
  toolCallId?: string
  name?: string
  args?: unknown
  result?: string
  detail?: string
  status?: 'calling' | 'success' | 'fail'
}

export type AgentThinkingTrace = AgentThinkingThoughtTrace | AgentThinkingToolTrace

export interface AgentThinkingState {
  isActive: boolean
  historyTraces: AgentThinkingTrace[]
  activeThought: AgentThinkingThoughtTrace | null
  activeTool: AgentThinkingToolTrace | null
  lastEventKind?: string
  lastUpdatedAt?: number
}

export type AgentToolDisplayKind =
  | 'command'
  | 'file_edit'
  | 'search_read'
  | 'web'
  | 'task_stage'
  | 'interaction'
  | 'generic'

export interface AgentAssistantTextBlock {
  id: string
  type: 'text'
  text: string
}

export interface AgentAssistantCommentaryBlock {
  id: string
  type: 'commentary'
  text: string
}

export interface AgentAssistantFinalAnswerBlock {
  id: string
  type: 'final_answer'
  text: string
}

export interface AgentAssistantThoughtBlock {
  id: string
  type: 'thought'
  text: string
  durationMs?: number | null
}

export interface AgentAssistantToolBlock {
  id: string
  type: 'tool'
  toolCallId?: string
  toolName: string
  displayKind: AgentToolDisplayKind
  status: 'pending' | 'running' | 'success' | 'fail'
  input?: Record<string, unknown> | null
  output?: unknown
  metadata?: Record<string, unknown> | null
  error?: string | null
}

export type AgentAssistantBlock =
  | AgentAssistantTextBlock
  | AgentAssistantCommentaryBlock
  | AgentAssistantFinalAnswerBlock
  | AgentAssistantThoughtBlock
  | AgentAssistantToolBlock

export interface AgentRunMessage {
  id?: string
  role: 'system' | 'user' | 'assistant'
  content: string | MathContentDocument
  created_at?: string
  messageInfo?: AgentMessageInfoFact
  parts?: AgentMessagePartFact[]
  attachments?: AgentFilePartFact[]
  isOptimistic?: boolean
  assistantBlocks?: AgentAssistantBlock[]
  /** 褰撳墠娑堟伅鏄惁澶勪簬娴佸紡鐢熸垚涓紝浠呯敤浜庡墠绔?UI 鎺у埗銆?*/
  isStreaming?: boolean
  /** 褰撳墠娲昏穬鐨勬帹瀵肩劍鐐广€?*/
  activeThought?: AgentThinkingThoughtTrace | null
  /** 褰撳墠娲昏穬鐨勫伐鍏疯皟鐢ㄣ€?*/
  activeTool?: AgentThinkingToolTrace | null
  /** 宸叉矇娣€鐨勬€濊€?宸ュ叿杞ㄨ抗锛岀敤浜庡彲瑙嗗寲 Agentic 杩囩▼銆?*/
  historyTraces?: AgentThinkingTrace[]
  citations?: AgentCitationAnchor[]
  citationStatus?: AgentCitationStatus | null
  usedRagEvidence?: boolean
}

export interface AgentNoteFocus {
  documentId?: string | number | null
  fileId?: string | number | null
  blockIndex?: number | null
  snippet?: string | null
  title?: string | null
}

export interface AgentRunRequest {
  tenantId: number
  userId: string | number
  workroomId: string | number
  uiContext?: AgentRunContext
  documentId?: string | number | null
  messages: AgentRunMessage[]
  inputFiles?: AgentInputFile[]
  noteFocus?: AgentNoteFocus | null
  /** 浼氳瘽瑙嗗浘 ID锛岀敤浜庡悓涓€鏂囨。涓嬪尯鍒嗕笉鍚岀紪杈戣鍥?鏍囩鐨?Agent 浼氳瘽 */
  viewId?: string | null
  /** 鍚庣鍒嗛厤鐨?Agent 浼氳瘽 ID锛岀敤浜庤法璇锋眰澶嶇敤鍚屼竴 LangGraph 绾跨▼ */
  sessionId?: string | null
  model?: {
    providerID: string
    modelID: string
  } | null
}

export interface AgentInputFile {
  name: string
  mimeType: string
  content: string
}

export type TranslationScope = 'word' | 'sentence'

export interface TranslationWordSense {
  pos?: string | null
  meaning?: string | null
  note?: string | null
}

export interface TranslationWordPayload {
  phonetic?: string | null
  translation?: string | null
  example?: string | null
  lemma?: string | null
  morphology?: string | null
  forms?: string[]
  senses?: TranslationWordSense[]
}

export interface TranslationQuotaInfo {
  limit?: number | null
  remaining?: number | null
  reset_at?: string | null
}

export interface TranslationLookupResponse {
  translation?: string | null
  word?: TranslationWordPayload | null
  quota?: TranslationQuotaInfo | null
}

export interface TranslationLookupPayload {
  tenantId: number
  userId: string | number
  text: string
  scope: TranslationScope
}

export interface TranslationContext {
  backendBaseUrl: string
  tenantId: number
  userId: string | number
}

export interface AgentSendPayload {
  /** 鍙戦€佸埌 Copilot 杈撳叆妗嗙殑鍘熷鏂囨湰锛屼緥濡?"@棰樼洰3" 鎴栬嚜鐒惰瑷€鎸囦护 */
  text: string
  /** 鍙€夛細鍏宠仈鐨勬枃妗?绗旇涓婁笅鏂囷紝鐢ㄤ簬 DocumentReadTool */
  noteFocus?: AgentNoteFocus
  /** 鍙€夛細瑕嗙洊鏈疆瀵硅瘽鐨?uiContext锛岀敤浜庤Е鍙戠壒瀹?LangGraph 鍒嗘敮锛堝 batch_question锛夈€?*/
  uiContextOverride?: AgentRunContext
  /** 鍙€夛細鎵归噺鍑洪鐩稿叧鐨勫厓淇℃伅锛岀敱棰樺崱渚т紶鍏ャ€?*/
  batchMeta?: {
    mode: 'batch_question'
    baseSequenceIndex?: number
    baseQuestionId?: number
    /** 褰撳墠鍗＄墖鍓╀綑鍙敤棰樻暟涓婇檺锛堜緥濡?5 - 宸叉湁棰樻暟锛夈€?*/
    maxCapacity?: number
  }
}

export interface AgentRunResponse {
  /** 鍚庣杩斿洖鐨勪細璇?ID锛屽墠绔渶鍦ㄥ悗缁姹備腑缁х画鎼哄甫 */
  sessionId?: string | null
  messages: AgentRunMessage[]
  finalAnswerPayload?: AgentFinalAnswerPayload | null
}

// ===== Agent 浼氳瘽绠＄悊 =====

export interface AgentConversationMeta {
  /** 鏈湴 UI 浣跨敤鐨?key锛岀敤浜庡尯鍒嗗悓涓€鏂囨。涓嬪涓細璇濊鍥?*/
  key: string
  /** 鍚庣浼氳瘽 ID锛坅gent_sessions.id锛夛紝鐢ㄤ簬涓?LangGraph 绾跨▼鍙婂巻鍙茶褰曞叧鑱?*/
  sessionId: string | null
  /** 绉熸埛 + 鐢ㄦ埛 + 鏂囨。 + 瑙嗗浘涓婁笅鏂?*/
  tenantId: number
  userId: string | number
  documentId: string | number | null
  viewId: string | null
  /** 浼氳瘽鏍囬锛岀敱鍚庣鍏冩暟鎹垨棣栨潯鐢ㄦ埛娑堟伅鐢熸垚 */
  title: string
  /** 鏈€杩戜竴鏉℃秷鎭憳瑕侊紝渚夸簬鍦ㄤ細璇濆垪琛ㄤ腑棰勮 */
  lastMessagePreview?: string | null
  /** 绱娑堟伅鏁伴噺 */
  messageCount?: number
  /** 浼氳瘽鐘舵€佷笌褰掓。鏍囪 */
  status?: string
  archived?: boolean
  /** 鍒涘缓涓庢洿鏂版椂闂存埑锛堟绉掞級 */
  createdAt: number
  updatedAt: number
  selectedModel?: {
    providerID: string
    modelID: string
    updatedAt?: string
  } | null
}

export interface AgentSessionListItem {
  id: string
  document_id?: string | number | null
  view_id?: string | null
  title?: string | null
  last_message_preview?: string | null
  message_count: number
  status?: string
  archived?: boolean
  created_at?: string
  updated_at?: string
  selected_model?: {
    provider_id: string
    model_id: string
    updated_at?: string
  } | null
}

export interface AgentSessionListResponseDto {
  items: AgentSessionListItem[]
}

export interface AgentHistoryMessageDto {
  info: AgentMessageInfoFact
  parts: AgentMessagePartFact[]
}

export interface AgentSessionMessagesResponseDto {
  session_id: string
  messages: AgentHistoryMessageDto[]
}

export interface AgUiQuestionReplaceEvent {
  action: 'question.replace'
  target: {
    questionId?: number
    sequenceIndex?: number
    groupId?: number | null
  }
  payload: {
    mode: 'similar_insert'
    newContent: string
    legendImages: string[]
    versionCount?: number
    currentVersionIndex?: number
    versions?: QuestionVersionRecord[]
    solution?: QuestionSolutionPayload
    origin?: {
      requestLabel?: string
      agentRunId?: string
    }
    ui?: {
      shinyOverlay?: boolean
      answerModeReset?: boolean
      variantOfQuestionId?: number | null
    }
  }
}

export interface NoteSourceMeta {
  documentId?: string | number | null
  fileId?: string | number | null
  pages?: number[]
  blockRange?: [number | null, number | null] | null
  snippet?: string | null
  context?: string | null
  title?: string | null
  questionId?: number | null
  sequenceIndex?: number | null
}

export interface AgUiQuestionInsertEvent {
  action: 'question.insert'
  target: {
    questionId?: number
    sequenceIndex?: number
    groupId?: number | null
  }
  payload: {
    mode: 'similar_insert'
    content: string
    legendImages: string[]
    versionCount?: number
    currentVersionIndex?: number
    versions?: QuestionVersionRecord[]
    solution?: QuestionSolutionPayload
    origin?: {
      requestLabel?: string
      agentRunId?: string
    }
    ui?: {
      shinyOverlay?: boolean
      answerModeReset?: boolean
    }
    noteSource?: NoteSourceMeta
  }
}

export type AgUiEvent =
  | AgUiQuestionReplaceEvent
  | AgUiQuestionInsertEvent
  | (Record<string, unknown> & { action: string })

export interface GradeQuestionPayload {
  sequenceIndex: number
  content: string
  userAnswer: string
  canonicalAnswer?: string | null
  legendImages?: string[]
  page?: number | null
  fileName?: string
}

export interface GradeRunRequest {
  tenantId: number
  userId: string | number
  workroomId: string | number
  studioDocumentId: string | number
  sourceDocumentId?: string | number | null
  title?: string | null
  questions: GradeQuestionPayload[]
}

export interface GradeQuestionResult {
  sequence_index: number
  sequenceIndex?: number
  judgement: Exclude<GradingJudgement, 'pending'>
  predicted_answer?: string | null
  predictedAnswer?: string | null
  reasoning?: string | null
  confidence?: number | null
  raw_response?: string | null
  rawResponse?: string | null
  error?: string | null
}

export interface GradeRunResponse {
  results: GradeQuestionResult[]
}

export interface SplitQuestionsRequest {
  tenantId: number
  userId: string | number
  workroomId: string | number
  documentId?: string | number | null
  text: string
  maxQuestions?: number | null
}

export interface SplitQuestionItem {
  index: number
  text: string
}

export interface SplitQuestionsResponse {
  questions: SplitQuestionItem[]
}

export type AiModelOperationType = 'chat_completion' | 'ocr_layout'

export type AiCapability =
  | 'agent_chat'
  | 'question_split'
  | 'question_grading'
  | 'flashcard_generation'
  | 'flashcard_long_outline'
  | 'mindmap_outline_generation'
  | 'mindmap_generation'
  | 'translation_math'
  | 'translation_word'
  | 'translation_sentence'
  | 'studio_selection_ocr'
  | 'document_layout_ocr'

export interface ProviderAccountDto {
  accountID: string
  providerID: string
  label: string
  apiKeyMasked?: string
  hasApiKey?: boolean
  apiKey?: string
  baseURL?: string
  lastSyncAt?: string
  lastTestAt?: string
  lastTestStatus?: 'success' | 'failed'
  createdAt?: string
  updatedAt?: string
}

export interface ProviderConnectionTestResultDto {
  success: boolean
  latencyMs: number
  error?: string
  httpStatus?: number
  providerID: string
  baseURL: string
}

export interface ProviderModelSyncResultDto {
  success: boolean
  providerID: string
  baseURL: string
  syncedCount: number
  models: Array<{
    modelID: string
    label?: string
  }>
  latencyMs: number
  error?: string
  httpStatus?: number
  lastSyncAt?: string
}

export interface ProviderModelCatalogDto {
  providerID: string
  models: Array<{
    modelID: string
    label?: string
  }>
}

export interface DefaultModelDto {
  accountID: string
  modelID: string
  operationType: AiModelOperationType
  baseURLOverride?: string
}

export interface CapabilityBindingDto {
  bindingID: string
  capability: AiCapability
  enabled: boolean
  accountID: string
  modelID: string
  operationType: AiModelOperationType
  baseURLOverride?: string
  label?: string
  notes?: string
  createdAt?: string
  updatedAt?: string
}

export interface UserModelSettingsDto {
  userID: string | number
  providerAccounts: ProviderAccountDto[]
  providerModelCatalogs: ProviderModelCatalogDto[]
  defaultModel: DefaultModelDto | null
  capabilityBindings: CapabilityBindingDto[]
  experimentalFeatures: {
    mathInput: {
      enabled: boolean
    }
  }
  bindingSchemaVersion?: number
  updatedAt: string
}

export interface MathTranslationResponse {
  translated_text: string
  rendered_latex: string
  confidence: number
  notes: string
  meta: {
    model: string
    latencyMs: number
    usage?: Record<string, unknown> | null
  }
}

export interface ModelCatalogProvider {
  providerID: string
  label: string
  iconKey?: string
  defaultBaseURL?: string
  adapterNpm?: string
  adapterApi?: string
  adapterKind: 'official' | 'openai_compatible'
  docsUrl?: string
  envKeys: string[]
  supportedOperations: AiModelOperationType[]
  models: Array<{
    modelID: string
    label: string
    operationType: AiModelOperationType
    attachment?: boolean
    reasoning?: boolean
    toolCall?: boolean
    iconKey?: string
  }>
}

export interface ModelCatalogCapabilityGroup {
  key: string
  label: string
  capabilities: Array<{
    capability: AiCapability
    label: string
    operationType: AiModelOperationType
  }>
}

export interface ModelCatalogDto {
  providers: ModelCatalogProvider[]
  capabilityGroups: ModelCatalogCapabilityGroup[]
  operationTypes: AiModelOperationType[]
}

export interface MindMapNodePayload {
  id: string
  label: string
  type?: string
  /**
   * parentId / side 鐢ㄤ簬鏀寔 XMind 椋庢牸鏍戝舰甯冨眬锛?
   * - parentId 涓虹┖鏃惰涓烘牴鍊欓€夛紱
   * - side 浠呭绱ц创鏍硅妭鐐圭殑涓€绾ц妭鐐规湁鎰忎箟锛坙eft/right/center锛夈€?
   */
  parentId?: string | null
  side?: 'left' | 'right' | 'center' | null
  data?: {
    description?: string
    source?: string
    questionIds?: number[]
    sequenceIndexes?: number[]
    page?: number | null
    [key: string]: unknown
  }
}

export interface MindMapEdgePayload {
  id: string
  source: string
  target: string
  label?: string | null
  type?: string
}

export interface MindMapGraphResponse {
  nodes: MindMapNodePayload[]
  edges: MindMapEdgePayload[]
  /** 鍙€夌殑鏍硅妭鐐?id锛岀敤浜庢爲褰㈠竷灞€銆?*/
  rootId?: string | null
  cached?: boolean
  hasQuestionRefs?: boolean
}

export type MindMapRequestMode = 'document' | 'file'

export type MindMapSourceType = 'document' | 'wiki_file' | 'studio_document'

export interface MindMapSourceRef {
  sourceType: MindMapSourceType
  sourceId: string | number
  sourceIds?: Array<string | number>
  kind?: string | null
}

export interface MindMapNavigateTarget {
  questionId?: string | number | null
  sequenceIndex?: number | null
  page?: number | null
  label?: string
  rawNode?: MindMapNodePayload
}

export interface MindMapFocusRequest {
  questionId?: number | null
  sequenceIndex?: number | null
  page?: number | null
  highlightDuration?: number
  token: number
}

export interface ExportQuestionPayload {
  index: number
  markdown: string
}

export interface ExportWordRequestPayload {
  title: string
  questions: ExportQuestionPayload[]
  templateKey?: string | null
}

export interface ExportTemplateInfo {
  key: string
  name: string
  description?: string | null
}

export interface ExportTemplatesResponse {
  templates: ExportTemplateInfo[]
}

export interface AgentSkillItemDto {
  name: string
  description: string
  location: string
  enabled: boolean
}

export interface AgentSkillSettingsDto {
  items: AgentSkillItemDto[]
}

export interface AgentMcpLocalConfigDto {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export interface AgentMcpOAuthConfigDto {
  clientId?: string
  clientSecret?: string
  scope?: string
  redirectUri?: string
}

export interface AgentMcpRemoteConfigDto {
  type: 'remote'
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  oauth?: AgentMcpOAuthConfigDto | false
  timeout?: number
}

export type AgentMcpConfigDto = AgentMcpLocalConfigDto | AgentMcpRemoteConfigDto

export type AgentMcpStatusDto =
  | { status: 'connected' }
  | { status: 'disabled' }
  | { status: 'unknown' }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth' }
  | { status: 'needs_client_registration'; error: string }

export type AgentMcpAuthStatusDto = 'authenticated' | 'expired' | 'not_authenticated'

export interface AgentMcpItemDto {
  name: string
  config: AgentMcpConfigDto
  status: AgentMcpStatusDto
  supportsOAuth: boolean
  authStatus: AgentMcpAuthStatusDto | null
}

export interface AgentMcpSettingsDto {
  items: AgentMcpItemDto[]
}

// ===== 棰樺瀷銆佺鐩€佹爣绛剧浉鍏崇被鍨?=====

export interface QuestionType {
  id: number
  name: string
  created_at?: string
}

export interface Subject {
  id: number
  name: string
  created_at?: string
}

export interface Tag {
  id: number
  name: string
  created_at?: string
}

// ===== 棰樼洰鐩稿叧绫诲瀷 =====

export interface Question {
  id: number
  content: string
  legend_images: string[]
  page?: number | null
  document_id: number
  created_at: string
  updated_at: string
}

// ===== 鏀惰棌棰樼洰鐩稿叧绫诲瀷 =====

export interface QuestionFavorite {
  id: number
  question_id: number
  question: FavoriteQuestionDetail
  studio_question_card_id?: string | null
  question_type?: QuestionType | null
  subject?: Subject | null
  tags: Tag[]
  created_at: string
}

export interface FavoriteQuestionDetail {
  id: number
  document_id: number
  sequence_index: number
  knowledge_title?: string | null
  content: string
  legend_images: string[]
  page?: number | null
  created_at: string
  updated_at: string
}

export interface FavoritesListResponse {
  total: number
  page: number
  page_size: number
  items: QuestionFavorite[]
}

export interface FavoriteConfig {
  question_type_id?: number | null
  question_type_name?: string
  subject_id?: number | null
  subject_name?: string
  tag_ids: number[]
  new_tag_names: string[]
}

export interface AddFavoriteRequest {
  tenant_id: number
  user_id: number
  question_id: number
  question_type_id?: number | null
  subject_id?: number | null
  tag_ids?: number[] | null
}

export interface AddFavoriteResponse {
  id: number
  question_id: number
  question_type_id?: number | null
  subject_id?: number | null
  tags?: Tag[]
  created_at: string
}

export interface RemoveFavoriteResponse {
  success: boolean
}

export interface CheckFavoriteResponse {
  is_favorited: boolean
}

