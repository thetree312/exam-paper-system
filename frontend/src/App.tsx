import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildWorkroomPath, buildWorkspaceIndexPath, parseAppRoute } from './appRoutes'
import { AppHeader } from './components/AppHeader'
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
import { fetchSnapshot } from './services/agentApi'
import { getQuestion } from './services/questionApi'
import { fetchWorkroomTabs, updateWorkroomState } from './services/workroomApi'
import { createWorkspace, deleteWorkspace, fetchWorkspaces, launchWorkspace } from './services/workspaceApi'
import { useAppStore } from './store/appStore'
import { buildOcrItemsFromSnapshot } from './utils/workroomRestore'
import type {
  AggregatedOcrItem,
  AgentSendPayload,
  StatusMessageKey,
  StatusMessageSetter,
  WorkspaceInfo,
} from './types'

const FALLBACK_BACKEND = 'http://localhost:8000'

const MemoizedAgentChatPanel = React.memo(AgentChatPanel)

const App: React.FC = () => {
  const backendBaseUrl = useMemo(
    () => (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? FALLBACK_BACKEND,
    [],
  )

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({})
  const userMenuRef = useRef<HTMLDivElement>(null)
  const toastTimerRef = useRef<number | null>(null)
  const launchedWorkspaceIdRef = useRef<number | null>(null)
  const runtimeStateSyncTimerRef = useRef<number | null>(null)
  const lastRuntimeStateSyncKeyRef = useRef<string>('')
  const runtimeStateSyncInFlightRef = useRef(false)
  const restoredSnapshotKeyRef = useRef<string | null>(null)
  const runtimeStatePendingTaskRef = useRef<{
    syncKey: string
    workroomId: number
    tenantId: number
    userId: number
    patch: {
      active_file_id?: number
      active_session_id?: number
      active_tab_index?: number
      active_studio_document_id?: number
      center_panel_state_json: {
        studio_view: 'editor' | 'mindmap' | 'flashcard'
        is_answer_mode: boolean
      }
      right_panel_state_json: {
        agent_view_id?: string
        is_agent_drawer_open: boolean
      }
    }
  } | null>(null)

  const { t } = useTranslation('common')

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
      workroomId: number
      tenantId: number
      userId: number
      patch: {
        active_file_id?: number
        active_session_id?: number
        active_tab_index?: number
        active_studio_document_id?: number
        center_panel_state_json: {
          studio_view: 'editor' | 'mindmap' | 'flashcard'
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
      lastRuntimeStateSyncKeyRef.current = task.syncKey
      try {
        const nextState = await updateWorkroomState(
          backendBaseUrl,
          task.workroomId,
          task.tenantId,
          task.userId,
          task.patch,
        )
        setWorkroomRuntimeState(nextState)
      } catch {
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
    [backendBaseUrl, setWorkroomRuntimeState],
  )

  const {
    fileTabs,
    setFileTabs,
    activeTabIndex,
    setActiveTabIndex,
    isUploading,
    fileInputRef,
    previewScrollRef,
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

  const renderedStatusMessage = t(`app.status.${statusMessageKey}`, statusValues)
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

  const [agentDocumentId, setAgentDocumentId] = useState<number | null>(null)
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
  } = useOcrManager(backendBaseUrl, setStatusMessage, showToast, agentDocumentId)

  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false)
  const [agentDrawerWidth, setAgentDrawerWidth] = useState(360)
  const [agentAppendToken, setAgentAppendToken] = useState<
    | {
        id: number
        payload: AgentSendPayload
      }
    | null
  >(null)
  const [isAnswerMode, setIsAnswerMode] = useState(false)
  const [studioView, setStudioView] = useState<'editor' | 'mindmap' | 'flashcard'>('editor')
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)

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

  const resetWorkroomSurface = useCallback(() => {
    setFileTabs([])
    setActiveTabIndex(-1)
    setOcrItems([])
    setWorkroom(null)
    setWorkroomRuntimeState(null)
    setWorkroomSources([])
    setWorkroomArtifacts([])
    setActiveWorkspace(null)
    setWorkroomLoadError(null)
    setAgentDocumentId(null)
    setIsAgentDrawerOpen(false)
    setIsAnswerMode(false)
    setStudioView('editor')
    restoredSnapshotKeyRef.current = null
  }, [
    setActiveTabIndex,
    setFileTabs,
    setOcrItems,
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
      const items = await fetchWorkspaces(backendBaseUrl, user.tenant_id, user.id)
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
      userId: user.id,
      workspaceId: targetWorkspace.id,
    })
      .then((payload) => {
        setActiveWorkspace(targetWorkspace)
        setWorkroom(payload.workroom)
        setWorkroomRuntimeState(payload.runtime_state)
        setWorkroomSources(payload.sources)
        setWorkroomArtifacts(payload.artifacts)
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
    const center = (workroomRuntimeState.center_panel_state_json ?? {}) as Record<string, unknown>
    const right = (workroomRuntimeState.right_panel_state_json ?? {}) as Record<string, unknown>
    const nextView = center.studio_view

    if (nextView === 'editor' || nextView === 'mindmap' || nextView === 'flashcard') {
      setStudioView(nextView)
    }
    if (typeof center.is_answer_mode === 'boolean') {
      setIsAnswerMode(center.is_answer_mode)
    }
    if (typeof workroomRuntimeState.active_studio_document_id === 'number') {
      setAgentDocumentId(workroomRuntimeState.active_studio_document_id)
    }
    if (typeof right.is_agent_drawer_open === 'boolean') {
      setIsAgentDrawerOpen(right.is_agent_drawer_open)
    }
  }, [workroomRuntimeState])

  useEffect(() => {
    const restoreKey =
      workroom?.id && agentDocumentId && user ? `${workroom.id}:${agentDocumentId}:${user.id}` : null
    if (!restoreKey || restoredSnapshotKeyRef.current === restoreKey) return
    if (ocrItems.length > 0) {
      restoredSnapshotKeyRef.current = restoreKey
      return
    }
    if (!user || !workroom || !agentDocumentId) return

    let cancelled = false
    void fetchSnapshot(backendBaseUrl, user.tenant_id, user.id, workroom.id, agentDocumentId)
      .then((snapshot) => {
        if (cancelled) return
        const activeTab = activeTabIndex >= 0 ? fileTabs[activeTabIndex] ?? null : null
        setOcrItems(
          buildOcrItemsFromSnapshot(snapshot, {
            sessionId: activeTab?.sessionId ?? workroomRuntimeState?.active_session_id ?? 0,
            fileId: activeTab?.fileId ?? workroomRuntimeState?.active_file_id ?? 0,
            fileName: activeTab?.name ?? snapshot.title,
          }),
        )
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
    agentDocumentId,
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
    if (!user || !workroom?.id) return
    if (fileTabs.length > 0) return

    const normalizeUrl = (url: string | null | undefined) =>
      url ? (url.startsWith('http') ? url : `${backendBaseUrl}${url}`) : null
    const toPreviewType = (sourceType?: string | null): 'image' | 'pdf' | 'word' | null => {
      const t = String(sourceType || '').toLowerCase()
      if (t === 'image') return 'image'
      if (t === 'pdf') return 'pdf'
      if (t === 'word') return 'word'
      return null
    }
    const toTabStatus = (status: string): 'pending' | 'processing' | 'ready' | 'failed' => {
      const s = status.toLowerCase()
      if (s === 'done' || s === 'ready') return 'ready'
      if (s === 'failed' || s === 'error') return 'failed'
      if (s === 'processing') return 'processing'
      return 'pending'
    }

    let cancelled = false
    void fetchWorkroomTabs(backendBaseUrl, workroom.id, user.tenant_id, user.id)
      .then((rows) => {
        if (cancelled) return
        const tabs = rows.map((row) => {
          const pages = (row.preview_pages || []).map(normalizeUrl).filter(Boolean) as string[]
          const previewUrl = normalizeUrl(row.preview_url) ?? pages[0] ?? null
          return {
            sessionId: row.session_id,
            fileId: row.file_id,
            name: row.name,
            previewType: toPreviewType(row.source_type),
            previewUrl,
            previewPages: pages.length ? pages : previewUrl ? [previewUrl] : [],
            status: toTabStatus(row.status),
            isPlaceholder: false,
          }
        })
        setFileTabs(tabs)

        const runtimeSessionId = workroomRuntimeState?.active_session_id ?? null
        if (runtimeSessionId != null) {
          const idx = tabs.findIndex((tab) => tab.sessionId === runtimeSessionId)
          setActiveTabIndex(idx >= 0 ? idx : tabs.length ? 0 : -1)
          return
        }
        const runtimeTabIndex = workroomRuntimeState?.active_tab_index
        if (typeof runtimeTabIndex === 'number' && runtimeTabIndex >= 0 && runtimeTabIndex < tabs.length) {
          setActiveTabIndex(runtimeTabIndex)
          return
        }
        setActiveTabIndex(tabs.length ? 0 : -1)
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'load_workroom_tabs_failed'
        showToast(message, 'error')
      })

    return () => {
      cancelled = true
    }
  }, [
    backendBaseUrl,
    fileTabs.length,
    setActiveTabIndex,
    setFileTabs,
    showToast,
    user,
    workroom?.id,
    workroomRuntimeState?.active_session_id,
    workroomRuntimeState?.active_tab_index,
  ])

  useEffect(() => {
    if (!workroom?.id || !user || route?.kind !== 'workroom') return

    const patch = {
      active_file_id: currentFile?.fileId ?? undefined,
      active_session_id: sessionId ?? undefined,
      active_tab_index: activeTabIndex >= 0 ? activeTabIndex : undefined,
      active_studio_document_id: agentDocumentId ?? undefined,
      center_panel_state_json: {
        studio_view: studioView,
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
      void sendRuntimeStateSync({
        syncKey,
        workroomId: workroom.id,
        tenantId: user.tenant_id,
        userId: user.id,
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
    agentDocumentId,
    agentViewId,
    currentFile?.fileId,
    isAnswerMode,
    isAgentDrawerOpen,
    route?.kind,
    sendRuntimeStateSync,
    sessionId,
    studioView,
    user,
    workroom?.id,
  ])

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
    void handleAddToEditor(sessionId, activeFile, selectionSnapshotRef.current)
  }, [activeFile, handleAddToEditor, selectionSnapshotRef, sessionId])

  const handleWorkspaceSplitItem = useCallback(
    (item: AggregatedOcrItem, index: number) => {
      void handleSplitOcrItem(item, index, user)
    },
    [handleSplitOcrItem, user],
  )

  const handleWorkspaceSubmitGrading = useCallback(() => {
    void handleSubmitGrading(currentFile, agentDocumentId, user)
  }, [agentDocumentId, currentFile, handleSubmitGrading, user])

  const handleRunGlmOcr = useCallback(async (): Promise<number | null> => {
    if (!user) {
      showToast(t('app.toast.login_required'), 'error')
      return null
    }
    if (!currentFile || !sessionId) {
      showToast(t('app.toast.upload_required'), 'error')
      return null
    }

    try {
      showToast(t('app.toast.glm_invoking'), 'info')
      const url = `${backendBaseUrl}/api/glm-ocr/sessions/${sessionId}/import?tenant_id=${user.tenant_id}&user_id=${user.id}`
      const resp = await fetch(url, { method: 'POST' })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || `HTTP ${resp.status}`)
      }
      const data = (await resp.json()) as { document_id: number; question_ids: number[] }
      const { document_id: documentId, question_ids: questionIds } = data
      if (!questionIds || questionIds.length === 0) {
        showToast(t('app.toast.glm_empty'), 'error')
        return null
      }

      setAgentDocumentId(documentId)

      const questions = await Promise.all(
        questionIds.map((qid) => getQuestion(qid, user.tenant_id, backendBaseUrl)),
      )

      const now = Date.now()
      const newItems = questions.map((q, idx) => ({
        id: `glm-${documentId}-${q.id}`,
        region_index: idx,
        text: q.content,
        sessionId,
        fileId: currentFile.fileId,
        fileName: currentFile.name,
        page: q.page ?? 1,
        createdAt: now + idx,
        legendImages: q.legend_images ?? [],
        originalText: q.content,
        answerText: '',
        sourceType: 'upload' as const,
        questionMeta: {
          questionId: q.id,
          sequenceIndex: idx,
          groupId: (q as any).group_id ?? q.id,
        },
      }))

      setOcrItems((prev) => [...prev, ...newItems])
      setStatusMessage('glm_done')
      showToast(t('app.toast.glm_success', { count: newItems.length }), 'success')
      setAppView('editor')
      return documentId
    } catch (err) {
      console.error('[glm_ocr_import] failed', err)
      const msg = err instanceof Error ? err.message : '未知错误'
      showToast(t('app.toast.glm_failed', { error: msg }), 'error')
      return null
    }
  }, [backendBaseUrl, currentFile, sessionId, setAppView, setOcrItems, showToast, t, user])

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
          sessionId: 0,
          fileId: 0,
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

  const handleAppendTokenConsumed = useCallback((tokenId: number) => {
    setAgentAppendToken((current) => {
      if (!current || current.id !== tokenId) return current
      return null
    })
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
          userId: user.id,
          name: defaultName,
          topic: null,
        })
        const nextWorkspace = result.workspace
        setWorkspaces((prev) => [nextWorkspace, ...prev])
        navigate(buildWorkroomPath(nextWorkspace.id))
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
          userId: user.id,
          workspaceId: workspace.id,
        })
        setWorkspaces((prev) => prev.filter((item) => item.id !== workspace.id))
        showToast('Workspace deleted', 'success')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'delete_workspace_failed'
        showToast(message, 'error')
      }
    },
    [backendBaseUrl, showToast, user],
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
          navigate(buildWorkroomPath(workspace.id))
        }}
      />
    )
  }

  return (
    <div
      className="bg-background-light text-slate-900 font-display antialiased overflow-hidden h-screen flex flex-col"
      data-workspace-id={activeWorkspace?.id ?? ''}
    >
      <AppHeader
        statusMessage={renderedStatusMessage}
        isUploading={isUploading}
        isExtracting={isExtracting}
        onExportClick={() => setIsExportDialogOpen(true)}
        user={user}
        userMenuRef={userMenuRef as React.RefObject<HTMLDivElement>}
        isUserMenuOpen={isUserMenuOpen}
        onToggleUserMenu={() => setIsUserMenuOpen((prev) => !prev)}
        onLogout={handleAppLogout}
        rightOffset={!isMobileOrTablet && isAgentDrawerOpen ? agentDrawerWidth : 0}
      />

        {isWorkroomLoading || !workroom ? (
          <div className="flex flex-1 items-center justify-center bg-slate-50">
            {isWorkroomNotFound ? (
              <div className="rounded-3xl border border-slate-200 bg-white px-10 py-12 text-center shadow-sm">
                <div className="text-5xl font-black tracking-tight text-slate-900">404</div>
                <div className="mt-3 text-xl font-semibold text-slate-900">Workspace Not Found</div>
                <div className="mt-2 text-sm text-slate-500">{workroomErrorMeta?.description}</div>
                <button
                  type="button"
                  onClick={() => navigate(buildWorkspaceIndexPath())}
                  className="mt-6 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  返回 Workspace 列表
                </button>
              </div>
            ) : (
              <div className="rounded-3xl border border-slate-200 bg-white px-8 py-10 text-center shadow-sm">
                <div className="text-lg font-semibold text-slate-900">
                  {isWorkroomLoading ? '正在打开工作台' : '工作台尚未就绪'}
                </div>
                <div className="mt-2 text-sm text-slate-500">
                  {isWorkroomLoading
                    ? '正在为当前 workspace 加载对应的 workroom。'
                    : workroomErrorMeta?.title ?? '加载失败'}
                </div>
                {!isWorkroomLoading && workroomErrorMeta && (
                  <div className="mt-2 text-sm text-slate-500">{workroomErrorMeta.description}</div>
                )}
                {!isWorkroomLoading && (
                  <button
                    type="button"
                    onClick={() => navigate(buildWorkspaceIndexPath())}
                    className="mt-5 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
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
            style={
              isMobileOrTablet
                ? undefined
                : {
                    paddingRight: isAgentDrawerOpen ? agentDrawerWidth : 0,
                    transition: 'padding-right 200ms ease',
                  }
            }
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
              pageRefs={pageRefs}
              imageRefs={imageRefs}
              isExtracting={isExtracting}
              previewScrollRef={previewScrollRef as React.RefObject<HTMLDivElement>}
              onSelectionSnapshotChange={handleSelectionSnapshotChange}
              onSelectionAddClick={handleSelectionAddClick}
              onClearSelection={() => {
                selectionSnapshotRef.current = null
              }}
              backendBaseUrl={backendBaseUrl}
              user={user}
              onToast={showToast}
              onAddFavoriteToEditor={handleAddFavoriteToEditor}
              onBackToWorkspace={() => {
                resetWorkroomSurface()
                navigate(buildWorkspaceIndexPath())
              }}
            />

            {!isMobileOrTablet && appView !== 'favorites' && (
              <div
                onMouseDown={startResize}
                className="w-1 cursor-col-resize bg-slate-200 hover:bg-slate-300 transition-colors"
              />
            )}

            {appView === 'favorites' ? (
              <div className="flex-1 overflow-hidden">
                <FavoritesPage
                  backendBaseUrl={backendBaseUrl}
                  user={user}
                  onToast={showToast}
                  onBack={() => setAppView('editor')}
                  onAddToEditor={handleAddFavoriteToEditor}
                />
              </div>
            ) : (
              <EditorWorkspaceShell
                backendBaseUrl={backendBaseUrl}
                user={user}
                workroomId={workroom?.id ?? null}
                studioView={studioView}
                onStudioViewChange={setStudioView}
                isAnswerMode={isAnswerMode}
                onToggleAnswerMode={() => setIsAnswerMode((prev) => !prev)}
                isAgentDrawerOpen={isAgentDrawerOpen}
                onOpenAgentDrawer={() => setIsAgentDrawerOpen((prev) => !prev)}
                currentFile={currentFile}
                sessionId={sessionId}
                ocrItems={ocrItems}
                agentDocumentId={agentDocumentId}
                onDocumentChange={setAgentDocumentId}
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
              />
            )}
          </main>
        )}

        {workroom && (
          <MemoizedAgentChatPanel
            backendBaseUrl={backendBaseUrl}
            user={user}
            workroomId={workroom.id}
            documentId={agentDocumentId}
            viewId={agentViewId ?? undefined}
            isOpen={isAgentDrawerOpen}
            onClose={() => setIsAgentDrawerOpen(false)}
            width={agentDrawerWidth}
            onResize={setAgentDrawerWidth}
            appendToken={agentAppendToken}
            onAgUiEvent={handleAgUiEvent}
            onAppendTokenConsumed={handleAppendTokenConsumed}
            onDocumentResolved={setAgentDocumentId}
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
    </div>
  )
}

export default App

