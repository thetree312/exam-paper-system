import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildWorkroomPath, buildWorkspaceIndexPath, parseAppRoute } from './appRoutes'
import { AppHeader } from './components/AppHeader'
import { AIModelSettingsDialog } from './components/AIModelSettingsDialog'
import { AuthScreen } from './components/AuthScreen'
import { EditorWorkspaceShell } from './components/EditorWorkspaceShell'
import { AgentChatPanel } from './components/AgentChatPanel'
import { ExportTemplateDialog } from './components/ExportTemplateDialog'
import { FavoritesPage } from './components/FavoritesPage'
import { PreviewPaneShell } from './components/PreviewPaneShell'
import { WorkspacePage } from './components/WorkspacePage'
import { useAuth } from './hooks/useAuth'
import { useFileUpload } from './hooks/useFileUpload'
import { useOcrManager } from './hooks/useOcrManager'
import { usePreviewPane } from './hooks/usePreviewPane'
import { getQuestion } from './services/questionApi'
import { enterProblemCardAnswerMode } from './services/problemCardsApi'
import {
  importStudioQuestionCardsFromLayout,
  listStudioDocuments,
  listStudioQuestionCards,
} from './services/studioApi'
import { updateWorkroomState } from './services/workroomApi'
import { createWorkspace, deleteWorkspace, fetchWorkspaces, launchWorkspace } from './services/workspaceApi'
import { fetchWorkroomFile, saveWorkroomFile } from './services/workroomTreeApi'
import { createDocumentPreviewAssetRefs } from './services/documentPreviewAsset'
import { createTextMathDocument } from './lib/mathContent'
import { useAppStore } from './store/appStore'
import { buildOcrItemFromStudioQuestionCard } from './utils/studioQuestionCards'
import { applyThemeToDocument } from './lib/theme'
import type {
  AggregatedOcrItem,
  AgentCitationAnchor,
  AgentCitationFocus,
  AgentSendPayload,
  StudioTabKind,
  StudioWorkspaceTab,
  StatusMessageKey,
  StatusMessageSetter,
  UploadedFileTab,
  WorkspaceInfo,
  WorkroomCurrentResponse,
  WorkroomRecoveryDocument,
} from './types'

const FALLBACK_BACKEND = 'http://localhost:3000'
type StudioDataSourceMode = 'follow_preview' | 'keep_workset'
type StudioAutoSaveMode = 'off' | 'afterDelay'
const EDITOR_TAB_ID = 'editor-main'
const MAX_OPEN_PREVIEW_TABS = 20

function studioTabTitle(kind: StudioTabKind) {
  if (kind === 'mindmap') return '思维导图'
  if (kind === 'flashcard') return '闪卡'
  if (kind === 'preview') return '文件预览'
  return '题卡'
}

function buildStudioTab(kind: StudioTabKind, payload?: StudioWorkspaceTab['payload']): StudioWorkspaceTab {
  if (kind === 'editor') {
    return {
      id: EDITOR_TAB_ID,
      kind: 'editor',
      title: studioTabTitle('editor'),
      closable: false,
    }
  }
  return {
    id: kind === 'preview' ? `preview:${payload?.path ?? 'file'}` : kind,
    kind,
    title: kind === 'preview' && payload?.path ? payload.path.split('/').pop() || payload.path : studioTabTitle(kind),
    closable: true,
    payload:
      kind === 'preview' && payload
        ? {
            ...payload,
            isDirty: payload.draftContent !== payload.savedContent,
          }
        : payload,
  }
}

function normalizeStudioTabs(
  rawTabs: unknown,
  fallbackActiveKind: StudioTabKind = 'editor',
): { tabs: StudioWorkspaceTab[]; activeTabId: string } {
  const parsed: StudioWorkspaceTab[] = []
  if (Array.isArray(rawTabs)) {
    for (const entry of rawTabs) {
      if (!entry || typeof entry !== 'object') continue
      const id = typeof (entry as Record<string, unknown>).id === 'string' ? String((entry as Record<string, unknown>).id) : ''
      const kind = (entry as Record<string, unknown>).kind
      if (!id || (kind !== 'editor' && kind !== 'mindmap' && kind !== 'flashcard' && kind !== 'preview')) continue
      const payload = (entry as Record<string, unknown>).payload
      const previewPayload: StudioWorkspaceTab['payload'] =
        kind === 'preview' && payload && typeof payload === 'object'
          ? {
              path: typeof (payload as Record<string, unknown>).path === 'string' ? String((payload as Record<string, unknown>).path) : '',
              savedContent:
                typeof (payload as Record<string, unknown>).savedContent === 'string'
                  ? String((payload as Record<string, unknown>).savedContent)
                  : typeof (payload as Record<string, unknown>).draftContent === 'string'
                    ? String((payload as Record<string, unknown>).draftContent)
                    : typeof (payload as Record<string, unknown>).content === 'string'
                      ? String((payload as Record<string, unknown>).content)
                      : '',
              draftContent:
                typeof (payload as Record<string, unknown>).draftContent === 'string'
                  ? String((payload as Record<string, unknown>).draftContent)
                  : typeof (payload as Record<string, unknown>).savedContent === 'string'
                    ? String((payload as Record<string, unknown>).savedContent)
                    : typeof (payload as Record<string, unknown>).content === 'string'
                      ? String((payload as Record<string, unknown>).content)
                      : '',
              isDirty: Boolean((payload as Record<string, unknown>).isDirty),
              lastSavedAt:
                typeof (payload as Record<string, unknown>).lastSavedAt === 'string'
                  ? String((payload as Record<string, unknown>).lastSavedAt)
                  : null,
              saveError:
                typeof (payload as Record<string, unknown>).saveError === 'string'
                  ? String((payload as Record<string, unknown>).saveError)
                  : null,
              viewMode:
                (payload as Record<string, unknown>).viewMode === 'markdown-read'
                  ? 'markdown-read'
                  : 'edit',
            }
          : undefined
      if (kind === 'preview' && (!previewPayload || !previewPayload.path.trim())) {
        continue
      }
      parsed.push({
        ...buildStudioTab(kind, previewPayload),
        id,
      })
    }
  }

  const byId = new Map<string, StudioWorkspaceTab>()
  byId.set(EDITOR_TAB_ID, buildStudioTab('editor'))
  for (const tab of parsed) {
    byId.set(tab.id, tab)
  }

  if (fallbackActiveKind !== 'editor' && fallbackActiveKind !== 'preview' && !byId.has(fallbackActiveKind)) {
    byId.set(fallbackActiveKind, buildStudioTab(fallbackActiveKind))
  }

  const hasPreviewTab = parsed.some((tab) => tab.kind === 'preview')
  const resolvedFallbackKind: StudioTabKind =
    fallbackActiveKind === 'preview' && !hasPreviewTab ? 'editor' : fallbackActiveKind

  const tabs = Array.from(byId.values())
  const activeTabId =
    resolvedFallbackKind === 'editor' || (resolvedFallbackKind === 'preview' && !tabs.some((tab) => tab.kind === 'preview'))
      ? EDITOR_TAB_ID
      : resolvedFallbackKind
  return {
    tabs,
    activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : EDITOR_TAB_ID,
  }
}

const MemoizedAgentChatPanel = React.memo(AgentChatPanel)

function mapDocumentStatusToTabStatus(
  status: WorkroomRecoveryDocument['status'],
): UploadedFileTab['status'] {
  if (status === 'ready') return 'ready'
  if (status === 'failed') return 'failed'
  if (status === 'uploaded') return 'pending'
  return 'processing'
}

function mapDocumentSourceType(sourceType?: string | null): UploadedFileTab['previewType'] {
  const normalized = String(sourceType ?? '').toLowerCase()
  if (normalized === 'image') return 'image'
  if (normalized === 'pdf') return 'pdf'
  if (normalized === 'word') return 'word'
  return null
}

function buildRecoveredTabs(
  workroomId: string | number,
  payload: Pick<WorkroomCurrentResponse, 'documents' | 'restoration' | 'runtime_state'>,
) {
  const documentsById = new Map(payload.documents.map((document) => [String(document.id), document]))
  const runtimeOpenDocumentIDs = Array.isArray(payload.runtime_state?.open_document_ids)
    ? payload.runtime_state.open_document_ids.map((id) => String(id))
    : []
  const restorationOpenDocumentIDs = Array.isArray(payload.restoration?.openDocumentIDs)
    ? payload.restoration.openDocumentIDs.map((id) => String(id))
    : []
  const orderedDocumentIDs = Array.from(
    new Set([
      ...restorationOpenDocumentIDs,
      ...runtimeOpenDocumentIDs,
      ...(payload.restoration?.activeDocumentID != null ? [String(payload.restoration.activeDocumentID)] : []),
      ...(payload.runtime_state?.active_file_id != null ? [String(payload.runtime_state.active_file_id)] : []),
    ]),
  )

  const tabs = orderedDocumentIDs
    .map((documentID) => documentsById.get(documentID))
    .filter((document): document is WorkroomRecoveryDocument => Boolean(document))
    .map((document) => {
      const previewPages = createDocumentPreviewAssetRefs({
        documentId: document.id,
        workroomId,
        pageCount: (document.previewPages ?? []).length,
      })

      return {
        sessionId: String(document.id),
        fileId: String(document.id),
        name: document.name,
        previewType: mapDocumentSourceType(document.sourceType),
        previewUrl: previewPages[0] ?? null,
        previewPages,
        status: mapDocumentStatusToTabStatus(document.status),
        isPlaceholder: false,
      } satisfies UploadedFileTab
    })

  const activeDocumentID =
    payload.restoration?.activeDocumentID != null
      ? String(payload.restoration.activeDocumentID)
      : payload.runtime_state?.active_file_id != null
        ? String(payload.runtime_state.active_file_id)
        : null

  let activeTabIndex = -1
  if (activeDocumentID) {
    activeTabIndex = tabs.findIndex((tab) => String(tab.fileId) === activeDocumentID)
  }
  if (activeTabIndex < 0) {
    const runtimeTabIndex = payload.runtime_state?.active_tab_index
    if (typeof runtimeTabIndex === 'number' && runtimeTabIndex >= 0 && runtimeTabIndex < tabs.length) {
      activeTabIndex = runtimeTabIndex
    }
  }
  if (activeTabIndex < 0 && tabs.length > 0) {
    activeTabIndex = 0
  }

  return { tabs, activeTabIndex }
}

const App: React.FC = () => {
  const backendBaseUrl = useMemo(
    () => (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? FALLBACK_BACKEND,
    [],
  )

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({})
  const userMenuRef = useRef<HTMLDivElement>(null)
  const toastTimerRef = useRef<number | null>(null)
  const launchedWorkspaceIdRef = useRef<string | number | null>(null)
  const runtimeStateSyncTimerRef = useRef<number | null>(null)
  const lastRuntimeStateSyncKeyRef = useRef<string>('')
  const runtimeStateSyncInFlightRef = useRef(false)
  const restoredSnapshotKeyRef = useRef<string | null>(null)
  const appliedRuntimeStateKeyRef = useRef<string | null>(null)
  const runtimeStatePendingTaskRef = useRef<{
    syncKey: string
    workroomId: string | number
    tenantId: number
    userId: string | number
    patch: {
      active_file_id?: string | number
      active_session_id?: string | number
      active_tab_index?: number
      active_studio_document_id?: string | number
      active_extraction_session_id?: string | number
      open_document_ids?: string[]
      center_panel_state_json: {
        studio_view: 'editor' | 'mindmap' | 'flashcard' | 'preview'
        studio_tabs?: StudioWorkspaceTab[]
        active_studio_tab_id?: string
        studio_data_source_mode?: StudioDataSourceMode
        is_answer_mode: boolean
      }
      right_panel_state_json: {
        agent_view_id?: string
        is_agent_drawer_open: boolean
      }
    }
  } | null>(null)

  const { t } = useTranslation('common')
  const appPerfDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('debug_settings_perf') === '1'
  }, [])
  const appPerfLog = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      if (!appPerfDebugEnabled) return
      console.log(`[settings-perf][app] ${event}`, payload)
    },
    [appPerfDebugEnabled],
  )

  const {
    user,
    authMode,
    setAuthMode,
    authEmail,
    setAuthEmail,
    authPassword,
    setAuthPassword,
    authDisplayName,
    setAuthDisplayName,
    authError,
    authLoading,
    handleAuthSubmit,
    handleLogout,
  } = useAuth(backendBaseUrl)

  const workroom = useAppStore((state) => state.workroom)
  const setWorkroom = useAppStore((state) => state.setWorkroom)
  const workroomRuntimeState = useAppStore((state) => state.workroomRuntimeState)
  const setWorkroomRuntimeState = useAppStore((state) => state.setWorkroomRuntimeState)
  const setWorkroomSources = useAppStore((state) => state.setWorkroomSources)
  const setWorkroomArtifacts = useAppStore((state) => state.setWorkroomArtifacts)
  const setPreviewScrollPositions = useAppStore((state) => state.setPreviewScrollPositions)
  const setStoreIsPreviewCollapsed = useAppStore((state) => state.setIsPreviewCollapsed)
  const setStoreLeftWidth = useAppStore((state) => state.setLeftWidth)
  const storeLeftWidth = useAppStore((state) => state.leftWidth)
  const storeIsPreviewCollapsed = useAppStore((state) => state.isPreviewCollapsed)
  const storeAppView = useAppStore((state) => state.appView)
  const theme = useAppStore((state) => state.theme)
  const setTheme = useAppStore((state) => state.setTheme)

  const [routePath, setRoutePath] = useState(() => window.location.pathname)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false)
  const [isWorkroomLoading, setIsWorkroomLoading] = useState(false)
  const [workroomLoadError, setWorkroomLoadError] = useState<string | null>(null)
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceInfo | null>(null)
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)

  const [statusMessageKey, setStatusMessageKey] = useState<StatusMessageKey>('upload_prompt')
  const [statusValues, setStatusValues] = useState<Record<string, string | number> | undefined>()

  const setStatusMessage: StatusMessageSetter = (key, values) => {
    setStatusMessageKey(key)
    setStatusValues(values)
  }

  const sendRuntimeStateSync = useCallback(
    async (task: {
      syncKey: string
      workroomId: string | number
      tenantId: number
      userId: string | number
      patch: {
        active_file_id?: string | number
        active_session_id?: string | number
        active_tab_index?: number
        active_studio_document_id?: string | number
        active_extraction_session_id?: string | number
        open_document_ids?: string[]
        center_panel_state_json: {
          studio_view: 'editor' | 'mindmap' | 'flashcard' | 'preview'
          studio_tabs?: StudioWorkspaceTab[]
          active_studio_tab_id?: string
          studio_data_source_mode?: StudioDataSourceMode
          is_answer_mode: boolean
        }
        right_panel_state_json: {
          agent_view_id?: string
          is_agent_drawer_open: boolean
        }
      }
    }) => {
      if (task.syncKey === lastRuntimeStateSyncKeyRef.current) {
        return
      }

      if (runtimeStateSyncInFlightRef.current) {
        runtimeStatePendingTaskRef.current = task
        return
      }

      runtimeStateSyncInFlightRef.current = true
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      lastRuntimeStateSyncKeyRef.current = task.syncKey
      try {
        const nextState = await updateWorkroomState(
          backendBaseUrl,
          String(task.workroomId),
          task.tenantId,
          String(task.userId),
          task.patch,
        )
        setWorkroomRuntimeState(nextState)
        appPerfLog('runtime-sync-ok', {
          syncKeySize: task.syncKey.length,
          duration: Number(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt).toFixed(2)),
        })
      } catch {
        appPerfLog('runtime-sync-failed', {
          syncKeySize: task.syncKey.length,
          duration: Number(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt).toFixed(2)),
        })
        if (lastRuntimeStateSyncKeyRef.current === task.syncKey) {
          lastRuntimeStateSyncKeyRef.current = ''
        }
      } finally {
        runtimeStateSyncInFlightRef.current = false
        const pending = runtimeStatePendingTaskRef.current
        runtimeStatePendingTaskRef.current = null
        if (pending && pending.syncKey !== lastRuntimeStateSyncKeyRef.current) {
          void sendRuntimeStateSync(pending)
        }
      }
    },
    [appPerfLog, backendBaseUrl, setWorkroomRuntimeState],
  )

  const {
    fileTabs,
    setFileTabs,
    activeTabIndex,
    setActiveTabIndex,
    isUploading,
    fileInputRef,
    previewScrollRef,
    previewScrollPositions,
    activeFile,
    currentFile,
    previewType,
    sessionId,
    activeStatus,
    previewSources,
    handleUploadClick,
    handleAddEmptyTab,
    handleTabSelect,
    handleCloseTab,
    handleFileChange,
    rememberPreviewScroll,
  } = useFileUpload(backendBaseUrl, user, setStatusMessage)

  const [toastState, setToastState] = useState<{
    id: number
    message: string
    type: 'info' | 'success' | 'error'
  } | null>(null)

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  const showToast = useCallback(
    (message: string, type: 'info' | 'success' | 'error' = 'info') => {
      const payload = { id: Date.now(), message, type }
      setToastState(payload)
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
      toastTimerRef.current = window.setTimeout(() => {
        setToastState((current) => (current?.id === payload.id ? null : current))
      }, 4000)
    },
    [],
  )

  const route = useMemo(() => parseAppRoute(routePath), [routePath])
  const workroomErrorMeta = useMemo(() => {
    if (!workroomLoadError) return null
    const normalized = workroomLoadError.toLowerCase()

    if (normalized.includes('workspace_not_found') || normalized.includes('404')) {
      return {
        title: '404 Workspace 不存在',
        description: '该 workspace 可能已被删除，或当前账号没有访问权限。',
        recoverable: true,
      }
    }
    if (normalized.includes('failed to fetch') || normalized.includes('networkerror')) {
      return {
        title: '网络连接失败',
        description: '无法连接后端服务，请检查后端是否启动以及 CORS/端口配置。',
        recoverable: true,
      }
    }
    return {
      title: '工作台加载失败',
      description: workroomLoadError,
      recoverable: true,
    }
  }, [workroomLoadError])
  const isWorkroomNotFound = workroomErrorMeta?.title.startsWith('404') ?? false

  const [activeStudioDocumentId, setActiveStudioDocumentId] = useState<string | null>(null)
  const {
    ocrItems,
    setOcrItems,
    isExtracting,
    isGrading,
    splittingItemId,
    selectionSnapshotRef,
    handleSelectionSnapshotChange,
    handleAddToEditor,
    handleOcrItemUpdate,
    handleOcrItemDelete,
    handleAnswerChange,
    handleSplitOcrItem,
    handleSubmitGrading,
    handleAgUiEvent,
  } = useOcrManager(backendBaseUrl, setStatusMessage, showToast, activeStudioDocumentId)

  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false)
  const [agentDrawerWidth, setAgentDrawerWidth] = useState(360)
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [citationFocus, setCitationFocus] = useState<AgentCitationFocus | null>(null)
  const [agentAppendToken, setAgentAppendToken] = useState<
    | {
        id: number
        payload: AgentSendPayload
      }
    | null
  >(null)
  const [isAnswerMode, setIsAnswerMode] = useState(false)
  const [studioTabs, setStudioTabs] = useState<StudioWorkspaceTab[]>([buildStudioTab('editor')])
  const [activeStudioTabId, setActiveStudioTabId] = useState<string>(EDITOR_TAB_ID)
  const [lastActiveStudioTabIds, setLastActiveStudioTabIds] = useState<string[]>([EDITOR_TAB_ID])
  const lastActiveStudioTabIdsRef = useRef<string[]>([EDITOR_TAB_ID])
  const [studioDataSourceMode, setStudioDataSourceMode] = useState<StudioDataSourceMode>('keep_workset')
  const [studioAutoSaveMode, setStudioAutoSaveMode] = useState<StudioAutoSaveMode>(() => {
    if (typeof window === 'undefined') return 'off'
    return window.localStorage.getItem('studio_auto_save_mode') === 'afterDelay' ? 'afterDelay' : 'off'
  })
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [isAiModelSettingsOpen, setIsAiModelSettingsOpen] = useState(false)
  const [modelSettingsRevision, setModelSettingsRevision] = useState(0)
  const [unsavedConfirmState, setUnsavedConfirmState] = useState<{
    title: string
    message: string
    resolve: (decision: 'save' | 'discard' | 'cancel') => void
  } | null>(null)
  const activeStudioTabKind = useMemo<StudioTabKind>(() => {
    const found = studioTabs.find((tab) => tab.id === activeStudioTabId)
    return found?.kind ?? 'editor'
  }, [activeStudioTabId, studioTabs])

  const activateStudioTab = useCallback((tabId: string) => {
    setActiveStudioTabId(tabId)
    setLastActiveStudioTabIds((prev) => [...prev.filter((id) => id !== tabId), tabId])
  }, [])

  const openStudioTab = useCallback((kind: StudioTabKind) => {
    if (kind === 'preview') return
    const targetId = kind === 'editor' ? EDITOR_TAB_ID : kind
    setStudioTabs((prev) => {
      if (prev.some((tab) => tab.id === targetId)) return prev
      return [...prev, buildStudioTab(kind)]
    })
    setActiveStudioTabId(targetId)
    setLastActiveStudioTabIds((prev) => [...prev.filter((id) => id !== targetId), targetId])
  }, [])

  const openStudioPreviewTab = useCallback((path: string, content: string) => {
    const tabId = `preview:${path}`
    setStudioTabs((prev) => {
      const existing = prev.find((tab) => tab.id === tabId)
      if (existing) {
        return prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                payload: {
                  path,
                  savedContent: content,
                  draftContent: content,
                  isDirty: false,
                  viewMode: existing.payload?.viewMode === 'markdown-read' ? 'markdown-read' : 'edit',
                  lastSavedAt: new Date().toISOString(),
                  saveError: null,
                },
                title: path.split('/').pop() || path,
              }
            : tab,
        )
      }
      let next = [
        ...prev,
        buildStudioTab('preview', {
          path,
          savedContent: content,
          draftContent: content,
          isDirty: false,
          viewMode: 'edit',
          lastSavedAt: new Date().toISOString(),
          saveError: null,
        }),
      ]
      const previewTabs = next.filter((tab) => tab.kind === 'preview')
      if (previewTabs.length > MAX_OPEN_PREVIEW_TABS) {
        const evict = previewTabs.find((tab) => !tab.payload?.isDirty && tab.id !== tabId)
        if (evict) {
          next = next.filter((tab) => tab.id !== evict.id)
        }
      }
      return next
    })
    setActiveStudioTabId(tabId)
    setLastActiveStudioTabIds((prev) => [...prev.filter((id) => id !== tabId), tabId])
  }, [])

  const requestUnsavedDecision = useCallback((title: string, message: string) => {
    return new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
      setUnsavedConfirmState({ title, message, resolve })
    })
  }, [])

  const closeStudioTab = useCallback((tabId: string) => {
    if (tabId === EDITOR_TAB_ID) return
    void (async () => {
      const tab = studioTabs.find((item) => item.id === tabId)
      if (tab?.kind === 'preview' && tab.payload?.isDirty) {
        const action = await requestUnsavedDecision('关闭前保存？', '文件有未保存修改，是否保存后再关闭？')
        if (action === 'cancel') return
        if (action === 'save') {
          if (!workroom?.id || !tab.payload?.path) return
          try {
            const savedContent = await saveWorkroomFile(
              backendBaseUrl,
              String(workroom.id),
              tab.payload.path,
              tab.payload.draftContent ?? '',
            )
            setStudioTabs((prev) =>
              prev.map((item) =>
                item.id === tabId && item.kind === 'preview' && item.payload?.path
                  ? {
                      ...item,
                      payload: {
                        ...item.payload,
                        savedContent,
                        draftContent: savedContent,
                        isDirty: false,
                        lastSavedAt: new Date().toISOString(),
                        saveError: null,
                      },
                    }
                  : item,
              ),
            )
          } catch {
            return
          }
        }
      }
      setStudioTabs((prev) => {
        const remaining = prev.filter((item) => item.id !== tabId)
        return remaining.some((item) => item.id === EDITOR_TAB_ID)
          ? remaining
          : [buildStudioTab('editor'), ...remaining]
      })
      setLastActiveStudioTabIds((prev) => {
        const next = prev.filter((id) => id !== tabId)
        lastActiveStudioTabIdsRef.current = next
        return next
      })
      setActiveStudioTabId((current) => {
        if (current !== tabId) return current
        const fallbackFromHistory = [...lastActiveStudioTabIdsRef.current]
          .filter((id) => id !== tabId)
          .reverse()
          .find((id) => id === EDITOR_TAB_ID || id === 'mindmap' || id === 'flashcard' || id.startsWith('preview:'))
        return fallbackFromHistory ?? EDITOR_TAB_ID
      })
    })()
  }, [backendBaseUrl, requestUnsavedDecision, studioTabs, workroom?.id])

  const reorderStudioTabs = useCallback((fromTabId: string, toTabId: string) => {
    if (fromTabId === toTabId) return
    setStudioTabs((prev) => {
      const fromIndex = prev.findIndex((tab) => tab.id === fromTabId)
      const toIndex = prev.findIndex((tab) => tab.id === toTabId)
      if (fromIndex < 0 || toIndex < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }, [])

  const updateStudioPreviewContent = useCallback((tabId: string, content: string) => {
    setStudioTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'preview' || !tab.payload?.path) return tab
        return {
          ...tab,
          payload: {
            ...tab.payload,
            draftContent: content,
            isDirty: content !== (tab.payload.savedContent ?? ''),
            saveError: null,
          },
        }
      }),
    )
  }, [])

  const updateStudioPreviewViewMode = useCallback((tabId: string, viewMode: 'edit' | 'markdown-read') => {
    setStudioTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'preview' || !tab.payload?.path) return tab
        return {
          ...tab,
          payload: {
            ...tab.payload,
            viewMode,
          },
        }
      }),
    )
  }, [])

  const saveStudioPreviewTab = useCallback(
    async (tabId: string) => {
      if (!workroom?.id) return false
      const tab = studioTabs.find((item) => item.id === tabId)
      if (!tab || tab.kind !== 'preview' || !tab.payload?.path) return false
      try {
        const savedContent = await saveWorkroomFile(
          backendBaseUrl,
          String(workroom.id),
          tab.payload.path,
          tab.payload.draftContent ?? '',
        )
        setStudioTabs((prev) =>
          prev.map((item) =>
            item.id === tabId && item.kind === 'preview' && item.payload?.path
              ? {
                  ...item,
                  payload: {
                    ...item.payload,
                    savedContent,
                    draftContent: savedContent,
                    isDirty: false,
                    lastSavedAt: new Date().toISOString(),
                    saveError: null,
                  },
                }
              : item,
          ),
        )
        showToast('已保存', 'success')
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : '保存失败'
        setStudioTabs((prev) =>
          prev.map((item) =>
            item.id === tabId && item.kind === 'preview' && item.payload
              ? {
                  ...item,
                  payload: {
                    ...item.payload,
                    saveError: message,
                  },
                }
              : item,
          ),
        )
        showToast(message, 'error')
        return false
      }
    },
    [backendBaseUrl, showToast, studioTabs, workroom?.id],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('studio_auto_save_mode', studioAutoSaveMode)
  }, [studioAutoSaveMode])

  useEffect(() => {
    if (studioAutoSaveMode !== 'afterDelay') return
    const active = studioTabs.find((tab) => tab.id === activeStudioTabId)
    if (!active || active.kind !== 'preview' || !active.payload?.isDirty) return
    const timer = window.setTimeout(() => {
      void saveStudioPreviewTab(active.id)
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [activeStudioTabId, saveStudioPreviewTab, studioAutoSaveMode, studioTabs])

  useEffect(() => {
    applyThemeToDocument(theme)
  }, [theme])

  useEffect(() => {
    const hasDirty = studioTabs.some((tab) => tab.kind === 'preview' && tab.payload?.isDirty)
    if (!hasDirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [studioTabs])

  useEffect(() => {
    lastActiveStudioTabIdsRef.current = lastActiveStudioTabIds
  }, [lastActiveStudioTabIds])

  const {
    leftPaneRef,
    previewPaneStyle,
    isPreviewCollapsed,
    appView,
    setAppView,
    isMobileOrTablet,
    collapsePreview,
    expandPreview,
    startResize,
  } = usePreviewPane()

  const agentViewId = useMemo(() => {
    if (!currentFile) return null
    return `view-${currentFile.fileId}-${currentFile.sessionId}`
  }, [currentFile])

  useEffect(() => {
    if (appView === 'favorites') {
      setIsAgentDrawerOpen(false)
    }
  }, [appView])

  const resetWorkroomSurface = useCallback(() => {
    setFileTabs([])
    setActiveTabIndex(-1)
    setPreviewScrollPositions({})
    setOcrItems([])
    setCitationFocus(null)
    setWorkroom(null)
    setWorkroomRuntimeState(null)
    setWorkroomSources([])
    setWorkroomArtifacts([])
    setActiveWorkspace(null)
    setWorkroomLoadError(null)
    setActiveStudioDocumentId(null)
    setAgentSessionId(null)
    setIsAgentDrawerOpen(false)
    setIsAnswerMode(false)
    setStudioTabs([buildStudioTab('editor')])
    setActiveStudioTabId(EDITOR_TAB_ID)
    setLastActiveStudioTabIds([EDITOR_TAB_ID])
    restoredSnapshotKeyRef.current = null
    appliedRuntimeStateKeyRef.current = null
  }, [
    setActiveTabIndex,
    setFileTabs,
    setOcrItems,
    setPreviewScrollPositions,
    setWorkroom,
    setWorkroomArtifacts,
    setWorkroomRuntimeState,
    setWorkroomSources,
  ])

  const navigate = useCallback((path: string, replace = false) => {
    if (window.location.pathname === path) {
      setRoutePath(path)
      return
    }
    if (replace) {
      window.history.replaceState({}, '', path)
    } else {
      window.history.pushState({}, '', path)
    }
    setRoutePath(path)
  }, [])

  const loadWorkspaceIndex = useCallback(async () => {
    if (!user) return
    setIsWorkspaceLoading(true)
    try {
      const items = await fetchWorkspaces(backendBaseUrl, user.tenant_id, String(user.id))
      setWorkspaces(items)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'load_workspaces_failed'
      showToast(message, 'error')
    } finally {
      setIsWorkspaceLoading(false)
    }
  }, [backendBaseUrl, showToast, user])

  useEffect(() => {
    const handlePopState = () => {
      setRoutePath(window.location.pathname)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isUserMenuOpen && userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setIsUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isUserMenuOpen])

  useEffect(() => {
    if (!user) return
    void loadWorkspaceIndex()
  }, [loadWorkspaceIndex, user])

  useEffect(() => {
    if (!user) return
    if (!route) {
      navigate(buildWorkspaceIndexPath(), true)
    }
  }, [navigate, route, user])

  useEffect(() => {
    if (!user || !route) return

    if (route.kind === 'workspace-index') {
      launchedWorkspaceIdRef.current = null
      setActiveWorkspace(null)
      setIsWorkroomLoading(false)
      setWorkroomLoadError(null)
      return
    }

    const targetWorkspace = workspaces.find((item) => item.id === route.workspaceId)
    if (!targetWorkspace) {
      if (!isWorkspaceLoading) {
        setWorkroomLoadError('workspace_not_found')
      }
      return
    }

    if (
      launchedWorkspaceIdRef.current === targetWorkspace.id &&
      workroom?.workspace_id === targetWorkspace.id &&
      workroom?.id
    ) {
      setActiveWorkspace(targetWorkspace)
      setIsWorkroomLoading(false)
      setWorkroomLoadError(null)
      return
    }

    launchedWorkspaceIdRef.current = targetWorkspace.id
    setIsWorkroomLoading(true)
    resetWorkroomSurface()
    setActiveWorkspace(targetWorkspace)

    void launchWorkspace(backendBaseUrl, {
      tenantId: user.tenant_id,
      userId: String(user.id),
      workspaceId: String(targetWorkspace.id),
    })
      .then((payload) => {
        setActiveWorkspace(targetWorkspace)
        setWorkroom(payload.workroom)
        setWorkroomRuntimeState(payload.runtime_state)
        setWorkroomSources(payload.sources)
        setWorkroomArtifacts(payload.artifacts)
        const recovered = buildRecoveredTabs(payload.workroom.id, payload)
        setFileTabs(recovered.tabs)
        setActiveTabIndex(recovered.activeTabIndex)
        setWorkroomLoadError(null)
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'launch_workspace_failed'
        setWorkroomLoadError(message)
        showToast(message, 'error')
      })
      .finally(() => {
        setIsWorkroomLoading(false)
      })
  }, [
    backendBaseUrl,
    isWorkspaceLoading,
    resetWorkroomSurface,
    route,
    setActiveTabIndex,
    setFileTabs,
    setWorkroom,
    setWorkroomArtifacts,
    setWorkroomRuntimeState,
    setWorkroomSources,
    showToast,
    user,
    workroom?.id,
    workroom?.workspace_id,
    workspaces,
  ])

  useEffect(() => {
    if (!workroomRuntimeState) return
    // Runtime state只用于首次进入workroom时恢复界面，后续本地交互不再被服务端回灌覆盖。
    if (appliedRuntimeStateKeyRef.current !== null) return
    const left = (workroomRuntimeState.left_panel_state_json ?? {}) as Record<string, unknown>
    const center = (workroomRuntimeState.center_panel_state_json ?? {}) as Record<string, unknown>
    const right = (workroomRuntimeState.right_panel_state_json ?? {}) as Record<string, unknown>
    const nextView = center.studio_view
    const nextSourceMode = center.studio_data_source_mode
    const restoredDocumentContext = workroomRuntimeState.active_studio_document_id ?? null
    const restoredAgentSession = workroomRuntimeState.active_agent_session_id ?? null
    const runtimeStateKey = JSON.stringify({
      runtimeStateId: workroomRuntimeState.id,
      activeStudioDocumentId: restoredDocumentContext,
      activeAgentSessionId: restoredAgentSession,
      left,
      center,
      right,
    })

    appliedRuntimeStateKeyRef.current = runtimeStateKey

    const fallbackKind: StudioTabKind =
      nextView === 'mindmap' || nextView === 'flashcard' || nextView === 'editor' || nextView === 'preview'
        ? nextView
        : 'editor'
    const normalizedTabState = normalizeStudioTabs(center.studio_tabs, fallbackKind)
    const restoredActiveTabId =
      typeof center.active_studio_tab_id === 'string' && center.active_studio_tab_id.trim()
        ? center.active_studio_tab_id
        : normalizedTabState.activeTabId
    const effectiveActiveTabId = normalizedTabState.tabs.some((tab) => tab.id === restoredActiveTabId)
      ? restoredActiveTabId
      : normalizedTabState.activeTabId
    let resolvedActiveTabId = effectiveActiveTabId
    setStudioTabs((prev) => {
      const previewTabs = prev.filter((tab) => tab.kind === 'preview')
      const merged = [...normalizedTabState.tabs, ...previewTabs.filter((tab) => !normalizedTabState.tabs.some((base) => base.id === tab.id))]
      if (activeStudioTabId.startsWith('preview:') && merged.some((tab) => tab.id === activeStudioTabId)) {
        resolvedActiveTabId = activeStudioTabId
      } else if (!merged.some((tab) => tab.id === resolvedActiveTabId)) {
        resolvedActiveTabId = merged[0]?.id ?? EDITOR_TAB_ID
      }
      return merged
    })
    setActiveStudioTabId(resolvedActiveTabId)
    setLastActiveStudioTabIds((prev) => {
      const next = [...prev.filter((id) => id !== effectiveActiveTabId), effectiveActiveTabId]
      return next.length > 0 ? next : [EDITOR_TAB_ID]
    })
    if (nextSourceMode === 'follow_preview' || nextSourceMode === 'keep_workset') {
      setStudioDataSourceMode(nextSourceMode)
    }
    if (typeof center.is_answer_mode === 'boolean') {
      setIsAnswerMode(center.is_answer_mode)
    }
    if (left.app_view === 'editor' || left.app_view === 'favorites') {
      setAppView(left.app_view)
    }
    if (typeof left.is_preview_collapsed === 'boolean') {
      setStoreIsPreviewCollapsed(left.is_preview_collapsed)
    }
    if (typeof left.left_width === 'number' && Number.isFinite(left.left_width)) {
      setStoreLeftWidth(left.left_width)
    }
    if (left.preview_scroll_positions && typeof left.preview_scroll_positions === 'object') {
      const raw = left.preview_scroll_positions as Record<string, unknown>
      const normalized = Object.fromEntries(
        Object.entries(raw)
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .map(([key, value]) => [key, value as number]),
      )
      setPreviewScrollPositions(normalized)
    }
    if (typeof restoredDocumentContext === 'string' || typeof restoredDocumentContext === 'number') {
      setActiveStudioDocumentId(String(restoredDocumentContext))
    }
    if (typeof restoredAgentSession === 'string' || typeof restoredAgentSession === 'number') {
      setAgentSessionId(String(restoredAgentSession))
    }
    if (typeof right.is_agent_drawer_open === 'boolean') {
      setIsAgentDrawerOpen(right.is_agent_drawer_open)
    }
  }, [setAppView, setPreviewScrollPositions, setStoreIsPreviewCollapsed, setStoreLeftWidth, workroomRuntimeState])

  useEffect(() => {
    if (!user?.id || !workroom?.id) return

    const sourceDocumentID = currentFile?.fileId != null ? String(currentFile.fileId) : null
    // keep_workset means the studio document is pinned by workset context (or explicit operations),
    // and must not be auto-switched by preview tab changes.
    if (studioDataSourceMode === 'keep_workset') return

    if (!sourceDocumentID) {
      if (activeStudioDocumentId !== null) {
        setActiveStudioDocumentId(null)
      }
      if (agentSessionId !== null) {
        setAgentSessionId(null)
      }
      if (ocrItems.length > 0) {
        setOcrItems((prev) => (prev.length > 0 ? [] : prev))
      }
      restoredSnapshotKeyRef.current = null
      return
    }

    let cancelled = false
    void listStudioDocuments(backendBaseUrl, {
      workroomID: String(workroom.id),
      sourceDocumentID,
    })
      .then((documents) => {
        if (cancelled) return
        const nextDocument = documents[0] ?? null
        const hasCurrentDocument = nextDocument && activeStudioDocumentId === String(nextDocument.id)
        if (!hasCurrentDocument) {
          setActiveStudioDocumentId(nextDocument ? String(nextDocument.id) : null)
          setAgentSessionId(null)
          setOcrItems((prev) => (prev.length > 0 ? [] : prev))
          restoredSnapshotKeyRef.current = null
        }
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[workroom.context] failed to resolve studio document for active tab', err)
      })

    return () => {
      cancelled = true
    }
  }, [
    studioDataSourceMode,
    activeStudioDocumentId,
    backendBaseUrl,
    currentFile?.fileId,
    setOcrItems,
    user?.id,
    workroom?.id,
  ])

  useEffect(() => {
    const restoreKey = workroom?.id && activeStudioDocumentId && user ? `${workroom.id}:${activeStudioDocumentId}:${user.id}` : null
    if (!restoreKey || restoredSnapshotKeyRef.current === restoreKey) return
    if (ocrItems.length > 0) {
      restoredSnapshotKeyRef.current = restoreKey
      return
    }
    if (!user || !workroom || !activeStudioDocumentId) return

    let cancelled = false
    void listStudioQuestionCards(backendBaseUrl, {
      workroomID: String(workroom.id),
      studioDocumentID: activeStudioDocumentId,
    })
      .then((cards) => {
        if (cancelled) return
        const activeTab = activeTabIndex >= 0 ? fileTabs[activeTabIndex] ?? null : null
        const restoredItems: AggregatedOcrItem[] = cards.map((card) => ({
          ...buildOcrItemFromStudioQuestionCard({
            card,
            fileName: activeTab?.name ?? '题卡集',
          }),
        }))
        setOcrItems(restoredItems)
        restoredSnapshotKeyRef.current = restoreKey
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[workroom.restore] failed to restore OCR cards', err)
      })

    return () => {
      cancelled = true
    }
  }, [
    activeTabIndex,
    activeStudioDocumentId,
    backendBaseUrl,
    fileTabs,
    ocrItems.length,
    setOcrItems,
    user,
    workroom?.id,
    workroomRuntimeState?.active_file_id,
    workroomRuntimeState?.active_session_id,
  ])

  useEffect(() => {
    if (!workroom?.id || !user || route?.kind !== 'workroom') return
    if (isAiModelSettingsOpen) return

    const openDocumentIdSet = new Set(fileTabs.filter((tab) => !tab.isPlaceholder).map((tab) => String(tab.fileId)))
    const persistedPreviewScrollPositions = Object.fromEntries(
      Object.entries(previewScrollPositions).filter(([key]) => openDocumentIdSet.has(key)),
    )
    const persistedStudioTabs = studioTabs
    const persistedActiveStudioTabId = persistedStudioTabs.some((tab) => tab.id === activeStudioTabId)
      ? activeStudioTabId
      : EDITOR_TAB_ID
    const hasPreviewTab = persistedStudioTabs.some((tab) => tab.kind === 'preview')
    const patch = {
      active_file_id: currentFile?.fileId ?? undefined,
      active_session_id: sessionId ?? undefined,
      active_tab_index: activeTabIndex >= 0 ? activeTabIndex : undefined,
      active_studio_document_id: activeStudioDocumentId ?? undefined,
      active_agent_session_id: agentSessionId ?? undefined,
      active_extraction_session_id: sessionId ?? undefined,
      open_document_ids: fileTabs.filter((tab) => !tab.isPlaceholder).map((tab) => String(tab.fileId)),
      left_panel_state_json: {
        app_view: storeAppView,
        is_preview_collapsed: storeIsPreviewCollapsed,
        left_width: storeLeftWidth,
        preview_scroll_positions: persistedPreviewScrollPositions,
      },
      center_panel_state_json: {
        studio_view: activeStudioTabKind === 'preview' && !hasPreviewTab ? 'editor' : activeStudioTabKind,
        studio_tabs: persistedStudioTabs,
        active_studio_tab_id: persistedActiveStudioTabId,
        studio_data_source_mode: studioDataSourceMode,
        is_answer_mode: isAnswerMode,
      },
      right_panel_state_json: {
        agent_view_id: agentViewId ?? undefined,
        is_agent_drawer_open: isAgentDrawerOpen,
      },
    }
    const syncKey = JSON.stringify({
      workroom_id: workroom.id,
      tenant_id: user.tenant_id,
      user_id: user.id,
      patch,
    })

    // 内容没有变化时，不重复持久化，避免请求风暴与页面抖动。
    if (syncKey === lastRuntimeStateSyncKeyRef.current) {
      return
    }

    if (runtimeStateSyncTimerRef.current != null) {
      window.clearTimeout(runtimeStateSyncTimerRef.current)
      runtimeStateSyncTimerRef.current = null
    }

    runtimeStateSyncTimerRef.current = window.setTimeout(() => {
      appPerfLog('runtime-sync-scheduled', {
        openDocumentCount: patch.open_document_ids.length,
        activeTabIndex: patch.active_tab_index ?? null,
        studioView: patch.center_panel_state_json.studio_view,
      })
      void sendRuntimeStateSync({
        syncKey,
        workroomId: String(workroom.id),
        tenantId: user.tenant_id,
        userId: String(user.id),
        patch,
      })
    }, 350)

    return () => {
      if (runtimeStateSyncTimerRef.current != null) {
        window.clearTimeout(runtimeStateSyncTimerRef.current)
        runtimeStateSyncTimerRef.current = null
      }
    }
  }, [
    activeTabIndex,
    activeStudioDocumentId,
    agentSessionId,
    agentViewId,
    currentFile?.fileId,
    fileTabs,
    previewScrollPositions,
    isAnswerMode,
    isAgentDrawerOpen,
    route?.kind,
    sendRuntimeStateSync,
    appPerfLog,
    sessionId,
    storeAppView,
    storeIsPreviewCollapsed,
    storeLeftWidth,
    activeStudioTabKind,
    activeStudioTabId,
    studioTabs,
    studioDataSourceMode,
    isAiModelSettingsOpen,
    user,
    workroom?.id,
  ])

  useEffect(() => {
    const container = previewScrollRef.current
    if (!container) return
    const handleScroll = () => {
      rememberPreviewScroll()
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [previewScrollRef, rememberPreviewScroll])

  useEffect(() => {
    if (user) {
      setStatusMessage('logged_in', { email: user.email })
    } else {
      setStatusMessage('login_required')
    }
  }, [user])

  const handleAppLogout = useCallback(() => {
    handleLogout()
    resetWorkroomSurface()
    navigate(buildWorkspaceIndexPath(), true)
    setStatusMessage('login_required')
    setIsUserMenuOpen(false)
  }, [handleLogout, navigate, resetWorkroomSurface])

  const handleSelectionAddClick = useCallback(() => {
    if (!sessionId || !activeFile) {
      setStatusMessage('session_missing')
      return
    }
    void handleAddToEditor(String(sessionId), activeFile, selectionSnapshotRef.current).then((studioDocumentID) => {
      if (studioDocumentID) {
        setActiveStudioDocumentId(String(studioDocumentID))
      }
    })
  }, [activeFile, handleAddToEditor, selectionSnapshotRef, sessionId])

  const handleWorkspaceSplitItem = useCallback(
    (item: AggregatedOcrItem, index: number) => {
      void handleSplitOcrItem(item, index, user)
    },
    [handleSplitOcrItem, user],
  )

  const handleWorkspaceSubmitGrading = useCallback(() => {
    const sourceDocumentId = currentFile?.fileId != null ? String(currentFile.fileId) : null
    void handleSubmitGrading(currentFile, activeStudioDocumentId, sourceDocumentId, user)
  }, [activeStudioDocumentId, currentFile, handleSubmitGrading, user])

  const handleToggleAnswerMode = useCallback(() => {
    const next = !isAnswerMode
    setIsAnswerMode(next)
    if (!next || !workroom?.id) return
    const cardIDs = Array.from(
      new Set(
        ocrItems
          .filter((item) => item.documentContext?.studioDocumentID && item.id)
          .map((item) => item.id),
      ),
    )
    if (!cardIDs.length) return
    void Promise.allSettled(
      cardIDs.map((problemCardID) =>
        enterProblemCardAnswerMode(backendBaseUrl, {
          workroomID: String(workroom.id),
          problemCardID,
        }),
      ),
    )
  }, [backendBaseUrl, isAnswerMode, ocrItems, workroom?.id])

  const handleRunGlmOcr = useCallback(async (): Promise<string | null> => {
    if (!user) {
      showToast(t('app.toast.login_required'), 'error')
      return null
    }
    if (!currentFile || !workroom?.id) {
      showToast(t('app.toast.upload_required'), 'error')
      return null
    }

    try {
      const imported = await importStudioQuestionCardsFromLayout(backendBaseUrl, {
        workroomID: String(workroom.id),
        sourceDocumentID: String(currentFile.fileId),
        title: currentFile.name,
        replaceExisting: false,
      })
      const { studioDocument } = imported
      const cards = imported.questionCards

      setActiveStudioDocumentId(studioDocument.id)
      setOcrItems(
        cards.map((card) =>
          buildOcrItemFromStudioQuestionCard({
            card,
            fileName: currentFile.name,
          }),
        ),
      )

      setStatusMessage('glm_done')
      showToast(
        cards.length > 0
          ? t('app.toast.glm_success', { count: cards.length })
          : '没有从当前文档中解析到题卡',
        'success',
      )
      setAppView('editor')
      return studioDocument.id
    } catch (err) {
      console.error('[studio.open_document] failed', err)
      const msg = err instanceof Error ? err.message : '未知错误'
      showToast(t('app.toast.glm_failed', { error: msg }), 'error')
      return null
    }
  }, [backendBaseUrl, currentFile, setAppView, setOcrItems, showToast, t, user, workroom?.id])

  const handleOpenWorkroomFile = useCallback(
    async (path: string) => {
      if (!workroom?.id) return
      const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '')
      if (!normalizedPath) {
        showToast('请选择具体文件', 'info')
        return
      }
      const active = studioTabs.find((tab) => tab.id === activeStudioTabId)
      if (active?.kind === 'preview' && active.payload?.isDirty) {
        const action = await requestUnsavedDecision('切换文件前保存？', '当前文件有未保存修改，是否保存后再切换？')
        if (action === 'cancel') return
        if (action === 'save') {
          const ok = await saveStudioPreviewTab(active.id)
          if (!ok) return
        }
      }
      const lowerPath = normalizedPath.toLowerCase()
      const isLikelyBinary = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.zip', '.doc', '.docx']
        .some((ext) => lowerPath.endsWith(ext))
      if (isLikelyBinary) {
        showToast('该文件类型暂不支持文本预览', 'info')
        return
      }
      try {
        const content = await fetchWorkroomFile(backendBaseUrl, String(workroom.id), normalizedPath)
        openStudioPreviewTab(normalizedPath, content)
      } catch (err) {
        const message = err instanceof Error ? err.message : '读取文件失败'
        showToast(message, 'error')
      }
    },
    [activeStudioTabId, backendBaseUrl, openStudioPreviewTab, requestUnsavedDecision, saveStudioPreviewTab, showToast, studioTabs, workroom?.id],
  )

  const handleRequestSaveOpenFile = useCallback(
    async (path: string) => {
      const tabId = `preview:${path}`
      const tab = studioTabs.find((item) => item.id === tabId)
      if (!tab || tab.kind !== 'preview') {
        showToast('该文件未在编辑标签中打开', 'info')
        return
      }
      await saveStudioPreviewTab(tabId)
    },
    [saveStudioPreviewTab, showToast, studioTabs],
  )

  const handleAddFavoriteToEditor = useCallback(
    async (questionId: number) => {
      if (!user) {
        showToast(t('app.toast.login_required'), 'error')
        return
      }

      try {
        showToast(t('app.toast.favorite_loading'), 'info')
        const question = await getQuestion(questionId, user.tenant_id, backendBaseUrl)
        const newItem: AggregatedOcrItem = {
          id: `favorite-${questionId}-${Date.now()}`,
          region_index: ocrItems.length,
          text: question.content,
          sessionId: 'favorite',
          fileId: 'favorite',
          fileName: '收藏题目',
          page: question.page || 1,
          createdAt: Date.now(),
          legendImages: question.legend_images || [],
          sourceType: 'favorite',
          questionMeta: {
            questionId,
            groupId: (question as any).group_id ?? questionId,
          },
          originalText: question.content,
          answerContent: createTextMathDocument(''),
          answerText: '',
        }

        setOcrItems((prev) => [...prev, newItem])
        setAppView('editor')
        showToast(t('app.toast.favorite_success'), 'success')
      } catch (err) {
        console.error('[add_favorite_to_editor] failed', err)
        const errorMsg = err instanceof Error ? err.message : '加载失败'
        showToast(t('app.toast.favorite_failed', { error: errorMsg }), 'error')
      }
    },
    [backendBaseUrl, ocrItems.length, setAppView, setOcrItems, showToast, t, user],
  )

  const handleSendQuestionToAgent = useCallback((payload: AgentSendPayload) => {
    if (!payload.text?.trim()) return
    setIsAgentDrawerOpen(true)
    setAgentAppendToken({ id: Date.now(), payload })
  }, [])
  const handleToggleAgentDrawer = useCallback(() => {
    setIsAgentDrawerOpen((prev) => !prev)
  }, [])
  const handleStudioDocumentChange = useCallback((id: string | null) => {
    setActiveStudioDocumentId(id != null ? String(id) : null)
  }, [])

  const handleAgentCitationClick = useCallback((citation: AgentCitationAnchor) => {
    if (
      !citation ||
      (typeof citation.file_id !== 'string' && typeof citation.file_id !== 'number') ||
      typeof citation.page_no !== 'number'
    ) {
      return
    }
    const nextBbox = citation.bbox_norm ?? null
    const sameCitation =
      citationFocus?.citationId === citation.citation_id &&
      citationFocus.fileId === citation.file_id &&
      citationFocus.pageNo === citation.page_no &&
      JSON.stringify(citationFocus.bboxNorm ?? null) === JSON.stringify(nextBbox)

    if (sameCitation) {
      setCitationFocus(null)
      return
    }

    const targetFileId = String(citation.file_id)
    const targetTabIndex = fileTabs.findIndex((tab) => String(tab.fileId) === targetFileId)
    if (targetTabIndex >= 0 && targetTabIndex !== activeTabIndex) {
      handleTabSelect(targetTabIndex)
    }
    setCitationFocus({
      token: Date.now(),
      citationId: citation.citation_id,
      fileId: targetFileId,
      pageNo: citation.page_no,
      bboxNorm: nextBbox,
    })
  }, [activeTabIndex, citationFocus, fileTabs, handleTabSelect])

  const handleAppendTokenConsumed = useCallback((tokenId: number) => {
    setAgentAppendToken((current) => {
      if (!current || current.id !== tokenId) return current
      return null
    })
  }, [])

  const handleAgentDocumentResolved = useCallback((id: string | number | null) => {
    setActiveStudioDocumentId(id != null ? String(id) : null)
  }, [])

  const handleAgentSessionResolved = useCallback((id: string | null) => {
    setAgentSessionId(id != null ? String(id) : null)
  }, [])

  const handleCreateWorkspace = useCallback(
    async () => {
      if (!user) return
      const now = new Date()
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate(),
      ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
        2,
        '0',
      )}:${String(now.getSeconds()).padStart(2, '0')}`
      const defaultName = `未命名学习空间 ${timestamp}`

      try {
        const result = await createWorkspace(backendBaseUrl, {
          tenantId: user.tenant_id,
          userId: String(user.id),
          name: defaultName,
          topic: null,
        })
        const nextWorkspace = result.workspace
        setWorkspaces((prev) => [nextWorkspace, ...prev])
        navigate(buildWorkroomPath(String(nextWorkspace.id)))
      } catch (err) {
        const message = err instanceof Error ? err.message : 'create_workspace_failed'
        showToast(message, 'error')
      }
    },
    [backendBaseUrl, navigate, showToast, user],
  )

  const handleDeleteWorkspace = useCallback(
    async (workspace: WorkspaceInfo) => {
      if (!user) return
      try {
        await deleteWorkspace(backendBaseUrl, {
          tenantId: user.tenant_id,
          userId: String(user.id),
          workspaceId: String(workspace.id),
        })
        setWorkspaces((prev) => prev.filter((item) => item.id !== workspace.id))
        if (route?.kind === 'workroom' && String(route.workspaceId) === String(workspace.id)) {
          resetWorkroomSurface()
          navigate('/workspaces')
        }
        showToast('Workspace deleted', 'success')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'delete_workspace_failed'
        showToast(message, 'error')
      }
    },
    [backendBaseUrl, navigate, resetWorkroomSurface, route, showToast, user],
  )

  if (!user) {
    return (
      <AuthScreen
        authMode={authMode}
        onAuthModeChange={setAuthMode}
        authEmail={authEmail}
        onAuthEmailChange={setAuthEmail}
        authPassword={authPassword}
        onAuthPasswordChange={setAuthPassword}
        authDisplayName={authDisplayName}
        onAuthDisplayNameChange={setAuthDisplayName}
        authError={authError}
        authLoading={authLoading}
        onSubmit={handleAuthSubmit}
      />
    )
  }

  if (route?.kind !== 'workroom') {
    return (
      <WorkspacePage
        user={user}
        workspaces={workspaces}
        onCreateWorkspace={handleCreateWorkspace}
        onDeleteWorkspace={handleDeleteWorkspace}
        onOpenWorkspace={(workspace) => {
          navigate(buildWorkroomPath(String(workspace.id)))
        }}
      />
    )
  }

  return (
    <div
      className="bg-background-light text-[var(--ui-text-primary)] font-display antialiased overflow-hidden h-screen flex flex-col"
      data-workspace-id={activeWorkspace?.id ?? ''}
    >
      <AppHeader
        onExportClick={() => setIsExportDialogOpen(true)}
        rightOffset={0}
      />

        {isWorkroomLoading || !workroom ? (
          <div className="flex flex-1 items-center justify-center bg-[var(--ui-bg-panel-muted)]">
            {isWorkroomNotFound ? (
              <div className="rounded-3xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-10 py-12 text-center shadow-sm">
                <div className="text-5xl font-black tracking-tight text-[var(--ui-text-primary)]">404</div>
                <div className="mt-3 text-xl font-semibold text-[var(--ui-text-primary)]">Workspace Not Found</div>
                <div className="mt-2 text-sm text-[var(--ui-text-primary)]">{workroomErrorMeta?.description}</div>
                <button
                  type="button"
                  onClick={() => navigate(buildWorkspaceIndexPath())}
                  className="mt-6 rounded-xl border border-[var(--ui-border-default)] px-4 py-2 text-sm font-medium text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]"
                >
                  返回 Workspace 列表
                </button>
              </div>
            ) : (
              <div className="rounded-3xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] px-8 py-10 text-center shadow-sm">
                <div className="text-lg font-semibold text-[var(--ui-text-primary)]">
                  {isWorkroomLoading ? '正在打开工作台' : '工作台尚未就绪'}
                </div>
                <div className="mt-2 text-sm text-[var(--ui-text-primary)]">
                  {isWorkroomLoading
                    ? '正在为当前 workspace 加载对应的 workroom。'
                    : workroomErrorMeta?.title ?? '加载失败'}
                </div>
                {!isWorkroomLoading && workroomErrorMeta && (
                  <div className="mt-2 text-sm text-[var(--ui-text-primary)]">{workroomErrorMeta.description}</div>
                )}
                {!isWorkroomLoading && (
                  <button
                    type="button"
                    onClick={() => navigate(buildWorkspaceIndexPath())}
                    className="mt-5 rounded-xl border border-[var(--ui-border-default)] px-4 py-2 text-sm font-medium text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]"
                  >
                    返回 Workspace
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <main
            className={`flex flex-1 ${isMobileOrTablet ? 'flex-col overflow-y-auto' : 'overflow-hidden'}`}
            style={undefined}
          >
            <PreviewPaneShell
              leftPaneRef={leftPaneRef as React.RefObject<HTMLElement>}
              style={previewPaneStyle}
              isPreviewCollapsed={isPreviewCollapsed}
              isMobileOrTablet={isMobileOrTablet}
              appView={appView}
              onAppViewChange={setAppView}
              collapsePreview={collapsePreview}
              expandPreview={expandPreview}
              fileTabs={fileTabs}
              activeTabIndex={activeTabIndex}
              isUploading={isUploading}
              onAddEmptyTab={handleAddEmptyTab}
              onTabSelect={handleTabSelect}
              onCloseTab={handleCloseTab}
              onUploadClick={handleUploadClick}
              fileInputRef={fileInputRef as React.RefObject<HTMLInputElement>}
              onFileChange={handleFileChange}
              previewSources={previewSources}
              previewType={previewType}
              activeStatus={activeStatus}
              hasActiveFile={!!currentFile}
              activeFileId={currentFile?.fileId != null ? String(currentFile.fileId) : null}
              pageRefs={pageRefs}
              imageRefs={imageRefs}
              isExtracting={isExtracting}
              previewScrollRef={previewScrollRef as React.RefObject<HTMLDivElement>}
              citationFocus={citationFocus}
              onSelectionSnapshotChange={handleSelectionSnapshotChange}
              onSelectionAddClick={handleSelectionAddClick}
              onClearSelection={() => {
                selectionSnapshotRef.current = null
              }}
              backendBaseUrl={backendBaseUrl}
              user={user}
              isUserMenuOpen={isUserMenuOpen}
              userMenuRef={userMenuRef as React.RefObject<HTMLDivElement>}
              onToggleUserMenu={() => setIsUserMenuOpen((prev) => !prev)}
              onOpenAiModelSettings={() => {
                setIsUserMenuOpen(false)
                setIsAiModelSettingsOpen(true)
              }}
              theme={theme}
              onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              onLogout={handleAppLogout}
              onOpenWorkroomFile={handleOpenWorkroomFile}
              onRequestSaveOpenFile={handleRequestSaveOpenFile}
              onToast={showToast}
              onBackToWorkspace={() => {
                resetWorkroomSurface()
                navigate(buildWorkspaceIndexPath())
              }}
            />

            {!isMobileOrTablet && appView !== 'favorites' && (
              <div
                onMouseDown={startResize}
                className="w-1 cursor-col-resize bg-[var(--ui-border-default)] hover:bg-[var(--ui-border-strong)] transition-colors"
              />
            )}

            {appView === 'favorites' ? (
              <div className="flex-1 overflow-hidden">
                <FavoritesPage
                  backendBaseUrl={backendBaseUrl}
                  user={user}
                  workroomID={String(workroom.id)}
                  onToast={showToast}
                  onBack={() => setAppView('editor')}
                  onAddToEditor={handleAddFavoriteToEditor}
                />
              </div>
            ) : (
              <EditorWorkspaceShell
                backendBaseUrl={backendBaseUrl}
                user={user}
                workroomId={workroom?.id != null ? String(workroom.id) : null}
                studioTabs={studioTabs}
                activeStudioTabId={activeStudioTabId}
                onOpenStudioTab={openStudioTab}
                onActivateStudioTab={activateStudioTab}
                onCloseStudioTab={closeStudioTab}
                onReorderStudioTabs={reorderStudioTabs}
                onUpdateStudioPreviewContent={updateStudioPreviewContent}
                onUpdateStudioPreviewViewMode={updateStudioPreviewViewMode}
                onSaveStudioPreviewTab={saveStudioPreviewTab}
                studioDataSourceMode={studioDataSourceMode}
                onStudioDataSourceModeChange={setStudioDataSourceMode}
                isAnswerMode={isAnswerMode}
                onToggleAnswerMode={handleToggleAnswerMode}
                onOpenAgentDrawer={handleToggleAgentDrawer}
                currentFile={currentFile}
                sessionId={sessionId != null ? String(sessionId) : null}
                ocrItems={ocrItems}
                studioDocumentId={activeStudioDocumentId}
                sourceDocumentId={currentFile?.fileId != null ? String(currentFile.fileId) : null}
                onDocumentChange={handleStudioDocumentChange}
                onUpdateItem={handleOcrItemUpdate}
                onDeleteItem={handleOcrItemDelete}
                onSendToAgent={handleSendQuestionToAgent}
                onAnswerChange={handleAnswerChange}
                onSubmitGrading={handleWorkspaceSubmitGrading}
                isGrading={isGrading}
                onSplitItem={handleWorkspaceSplitItem}
                splittingItemId={splittingItemId}
                previewScrollRef={previewScrollRef as React.RefObject<HTMLDivElement>}
                onToast={showToast}
                onRunGlmOcr={handleRunGlmOcr}
                modelSettingsRevision={modelSettingsRevision}
                agentDrawerInset={!isMobileOrTablet && isAgentDrawerOpen ? agentDrawerWidth : 0}
              />
            )}
          </main>
        )}

        {workroom && (
          <MemoizedAgentChatPanel
            backendBaseUrl={backendBaseUrl}
            user={user}
            workroomId={workroom.id}
            documentId={activeStudioDocumentId}
            viewId={agentViewId ?? undefined}
            preferredSessionId={agentSessionId}
            isOpen={isAgentDrawerOpen}
            onClose={() => setIsAgentDrawerOpen(false)}
            width={agentDrawerWidth}
            onResize={setAgentDrawerWidth}
            appendToken={agentAppendToken}
            onAgUiEvent={handleAgUiEvent}
            onAppendTokenConsumed={handleAppendTokenConsumed}
            onDocumentResolved={handleAgentDocumentResolved}
            onSessionResolved={handleAgentSessionResolved}
            onCitationClick={handleAgentCitationClick}
            modelSettingsRevision={modelSettingsRevision}
          />
        )}

        <ExportTemplateDialog
          open={isExportDialogOpen}
          onClose={() => setIsExportDialogOpen(false)}
          backendBaseUrl={backendBaseUrl}
          ocrItems={ocrItems}
          documentTitle={currentFile?.name ?? null}
          user={user}
          onStatusMessage={setStatusMessage}
        />

        <AIModelSettingsDialog
          open={isAiModelSettingsOpen}
          onClose={() => setIsAiModelSettingsOpen(false)}
          backendBaseUrl={backendBaseUrl}
          user={user}
          onLogout={handleAppLogout}
          studioAutoSaveMode={studioAutoSaveMode}
          onStudioAutoSaveModeChange={setStudioAutoSaveMode}
          theme={theme}
          onThemeChange={setTheme}
          onSaved={() => {
            setModelSettingsRevision((prev) => prev + 1)
          }}
        />

      {toastState && (
        <div
          key={toastState.id}
          className={`fixed bottom-6 right-6 z-50 min-w-[240px] origin-bottom-right rounded-xl px-4 py-3 text-sm text-white shadow-lg transition-all ${
            toastState.type === 'success'
              ? 'bg-emerald-600'
              : toastState.type === 'error'
                ? 'bg-rose-600'
                : 'bg-slate-800'
          }`}
        >
          {toastState.message}
        </div>
      )}
      {unsavedConfirmState && (
        <div className="fixed inset-0 z-[260] flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-md rounded-xl border border-[var(--ui-border-default)] bg-[var(--ui-bg-panel)] p-5 shadow-2xl">
            <div className="text-base font-semibold text-[var(--ui-text-primary)]">{unsavedConfirmState.title}</div>
            <div className="mt-2 text-sm text-[var(--ui-text-primary)]">{unsavedConfirmState.message}</div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-[var(--ui-border-default)] px-3 py-1.5 text-sm text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]"
                onClick={() => {
                  unsavedConfirmState.resolve('cancel')
                  setUnsavedConfirmState(null)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md border border-[var(--ui-border-default)] px-3 py-1.5 text-sm text-[var(--ui-text-primary)] hover:bg-[var(--ui-bg-panel-muted)]"
                onClick={() => {
                  unsavedConfirmState.resolve('discard')
                  setUnsavedConfirmState(null)
                }}
              >
                不保存
              </button>
              <button
                type="button"
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800"
                onClick={() => {
                  unsavedConfirmState.resolve('save')
                  setUnsavedConfirmState(null)
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App




