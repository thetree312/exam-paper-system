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
  id: number
  tenant_id: number
  email: string
  display_name: string
}

export interface WorkspaceInfo {
  id: number
  tenant_id: number
  user_id: number
  name: string
  topic?: string | null
  status: string
}

export interface WorkroomInfo {
  id: number
  workspace_id?: number | null
  tenant_id: number
  user_id: number
  name: string
  status: string
}

export interface WorkroomRuntimeState {
  active_file_id?: number | null
  active_session_id?: number | null
  active_tab_index: number
  active_studio_document_id?: number | null
  active_agent_session_id?: number | null
  active_extraction_session_id?: number | null
  left_panel_state_json: Record<string, unknown>
  center_panel_state_json: Record<string, unknown>
  right_panel_state_json: Record<string, unknown>
}

export interface WorkroomSourceBinding {
  file_id: number
  source_id?: number | null
  is_active: boolean
}

export interface WorkroomArtifact {
  artifact_type: string
  artifact_ref_id: string
  source_file_id?: number | null
  studio_document_id?: number | null
  payload_json: Record<string, unknown>
}

export interface WorkroomCurrentResponse {
  workroom: WorkroomInfo
  runtime_state: WorkroomRuntimeState
  sources: WorkroomSourceBinding[]
  artifacts: WorkroomArtifact[]
}

export interface WorkspaceLaunchResponse {
  workspace: WorkspaceInfo
  workroom: WorkroomInfo
}

export interface FlashcardItem {
  questionId: number | null
  documentId: number
  sequenceIndex: number
  page?: number | null
  frontMarkdown: string
  backMarkdown?: string | null
  legendImages: string[]
  answerStatus?: string | null
  answerSource?: string | null
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
  sessionId: number
  fileId: number
  fileName: string
  page: number
  createdAt: number
  legendImages?: string[]
  originalText?: string
  answerText?: string
  sourceType?: 'upload' | 'favorite'  // 鏂板锛氭爣璇嗘潵婧愶紙涓婁紶鎴栨敹钘忥級
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
  session_id: number
  file_id: number
  status: 'pending' | 'processing' | 'done' | 'failed'
  preview_url?: string | null
  preview_pages?: string[]
}

export interface UploadedFileTab {
  sessionId: number
  fileId: number
  name: string
  previewType: 'image' | 'pdf' | 'word' | null
  previewUrl: string | null
  previewPages: string[]
  pageSessionIds?: number[]
  pageFileIds?: number[]
  pageStatuses?: TabStatus[]
  status: TabStatus
  isPlaceholder?: boolean
}

export interface AgentQuestion {
  id: number
  sequenceIndex: number
  groupId?: number | null
  page?: number | null
  content: string
  legendImages: string[]
  studentAnswer?: string | null
  gradingJudgement?: string | null
  gradingPredictedAnswer?: string | null
  gradingReasoning?: string | null
  gradingConfidence?: number | null
}

export interface QuestionSyncPayload {
  tenantId: number
  userId: number
  workroomId: number
  documentId?: number | null
  sessionId?: number | null
  fileId?: number | null
  questionId?: number | null
  sequenceIndex: number
  page?: number | null
  content: string
  legendImages?: string[]
  title?: string | null
  studentAnswer?: string | null
  sourceType?: 'upload' | 'favorite'
}

export interface QuestionSyncResponse {
  document_id: number
  studio_document_id?: number
  question: {
    id: number
    sequence_index: number
  }
}

export interface AgentSnapshotResponse {
  document_id: number
  studio_document_id?: number
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

export interface AgentRunMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 褰撳墠娑堟伅鏄惁澶勪簬娴佸紡鐢熸垚涓紝浠呯敤浜庡墠绔?UI 鎺у埗銆?*/
  isStreaming?: boolean
  /** 褰撳墠娲昏穬鐨勬帹瀵肩劍鐐广€?*/
  activeThought?: AgentThinkingThoughtTrace | null
  /** 褰撳墠娲昏穬鐨勫伐鍏疯皟鐢ㄣ€?*/
  activeTool?: AgentThinkingToolTrace | null
  /** 宸叉矇娣€鐨勬€濊€?宸ュ叿杞ㄨ抗锛岀敤浜庡彲瑙嗗寲 Agentic 杩囩▼銆?*/
  historyTraces?: AgentThinkingTrace[]
}

export interface AgentNoteFocus {
  documentId?: number | null
  fileId?: number | null
  blockIndex?: number | null
  snippet?: string | null
  title?: string | null
}

export interface AgentRunRequest {
  tenantId: number
  userId: number
  workroomId: number
  uiContext?: AgentRunContext
  documentId?: number | null
  messages: AgentRunMessage[]
  noteFocus?: AgentNoteFocus | null
  /** 浼氳瘽瑙嗗浘 ID锛岀敤浜庡悓涓€鏂囨。涓嬪尯鍒嗕笉鍚岀紪杈戣鍥?鏍囩鐨?Agent 浼氳瘽 */
  viewId?: string | null
  /** 鍚庣鍒嗛厤鐨?Agent 浼氳瘽 ID锛岀敤浜庤法璇锋眰澶嶇敤鍚屼竴 LangGraph 绾跨▼ */
  sessionId?: number | null
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
  userId: number
  text: string
  scope: TranslationScope
}

export interface TranslationContext {
  backendBaseUrl: string
  tenantId: number
  userId: number
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
  sessionId?: number | null
  messages: AgentRunMessage[]
}

// ===== Agent 浼氳瘽绠＄悊 =====

export interface AgentConversationMeta {
  /** 鏈湴 UI 浣跨敤鐨?key锛岀敤浜庡尯鍒嗗悓涓€鏂囨。涓嬪涓細璇濊鍥?*/
  key: string
  /** 鍚庣浼氳瘽 ID锛坅gent_sessions.id锛夛紝鐢ㄤ簬涓?LangGraph 绾跨▼鍙婂巻鍙茶褰曞叧鑱?*/
  sessionId: number | null
  /** 绉熸埛 + 鐢ㄦ埛 + 鏂囨。 + 瑙嗗浘涓婁笅鏂?*/
  tenantId: number
  userId: number
  documentId: number | null
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
}

export interface AgentSessionListItem {
  id: number
  tenant_id: number
  user_id: number
  document_id: number
  view_id: string
  title?: string | null
  last_message_preview?: string | null
  message_count: number
  status: string
  archived: boolean
  created_at: string
  updated_at: string
}

export interface AgentSessionListResponseDto {
  sessions: AgentSessionListItem[]
}

export interface AgentHistoryMessageDto {
  id: number
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  created_at: string
}

export interface AgentSessionMessagesResponseDto {
  session_id: number
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
  documentId?: number | null
  fileId?: number | null
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

export interface NoteSourceMeta {
  documentId?: number | null
  fileId?: number | null
  pages?: number[]
  blockRange?: [number | null, number | null] | null
  snippet?: string | null
  context?: string | null
  title?: string | null
  questionId?: number | null
  sequenceIndex?: number | null
}

export type AgUiEvent =
  | AgUiQuestionReplaceEvent
  | AgUiQuestionInsertEvent
  | (Record<string, unknown> & { action: string })

export interface GradeQuestionPayload {
  sequenceIndex: number
  content: string
  userAnswer: string
  legendImages?: string[]
  page?: number | null
  fileName?: string
}

export interface GradeRunRequest {
  tenantId: number
  userId: number
  workroomId: number
  documentId?: number | null
  title?: string | null
  questions: GradeQuestionPayload[]
}

export interface GradeQuestionResult {
  sequence_index: number
  judgement: Exclude<GradingJudgement, 'pending'>
  predicted_answer?: string | null
  reasoning?: string | null
  confidence?: number | null
  raw_response?: string | null
  error?: string | null
}

export interface GradeRunResponse {
  results: GradeQuestionResult[]
}

export interface SplitQuestionsRequest {
  tenantId: number
  userId: number
  documentId?: number | null
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

export type MindMapSourceType = 'exam_document' | 'uploaded_file'

export interface MindMapSourceRef {
  sourceType: MindMapSourceType
  sourceId: number
  sourceIds?: number[]
  kind?: string | null
}

export interface MindMapNavigateTarget {
  questionId?: number | null
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
  question_type?: QuestionType | null
  subject?: Subject | null
  tags: Tag[]
  created_at: string
}

export interface FavoriteQuestionDetail {
  id: number
  document_id: number
  sequence_index: number
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

export interface FavoriteQuotaResponse {
  max_favorites: number
  current_count: number
  remaining: number
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

