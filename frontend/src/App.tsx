import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AppHeader } from './components/AppHeader'
import { AuthScreen } from './components/AuthScreen'
import { EditorWorkspaceShell } from './components/EditorWorkspaceShell'
import { AgentChatPanel } from './components/AgentChatPanel'
import { ExportTemplateDialog } from './components/ExportTemplateDialog'
import { FavoritesPage } from './components/FavoritesPage'
import { PreviewPaneShell } from './components/PreviewPaneShell'
import { getQuestion } from './services/questionApi'
import type {
  AggregatedOcrItem,
  AgentSendPayload,
  StatusMessageKey,
  StatusMessageSetter,
  UploadedFileTab,
} from './types'
import { useAuth } from './hooks/useAuth'
import { useFileUpload } from './hooks/useFileUpload'
import { useOcrManager } from './hooks/useOcrManager'
import { usePreviewPane } from './hooks/usePreviewPane'

const FALLBACK_BACKEND = 'http://localhost:8000'

const MemoizedAgentChatPanel = React.memo(AgentChatPanel)

const App: React.FC = () => {
  const backendBaseUrl = useMemo(
    () => (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? FALLBACK_BACKEND,
    [],
  )

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({})
  const fileTabsRef = useRef<UploadedFileTab[]>([])
  const userMenuRef = useRef<HTMLDivElement>(null)
  const toastTimerRef = useRef<number | null>(null)

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
    authTenantCode,
    setAuthTenantCode,
    authError,
    setAuthError,
    authLoading,
    setAuthLoading,
    handleAuthSubmit,
    handleLogout,
  } = useAuth(backendBaseUrl)

  const [statusMessageKey, setStatusMessageKey] = useState<StatusMessageKey>('upload_prompt')
  const [statusValues, setStatusValues] = useState<Record<string, string | number> | undefined>()

  const setStatusMessage: StatusMessageSetter = (key, values) => {
    setStatusMessageKey(key)
    setStatusValues(values)
  }

  const {
    fileTabs,
    setFileTabs,
    activeTabIndex,
    setActiveTabIndex,
    isUploading,
    setIsUploading,
    fileInputRef,
    previewScrollRef,
    previewScrollPositions,
    setPreviewScrollPositions,
    activeFile,
    currentFile,
    fileName,
    previewType,
    previewPages,
    previewUrl,
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

  const renderedStatusMessage = t(`app.status.${statusMessageKey}`, statusValues)

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
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
  const [isAnswerMode, setIsAnswerMode] = useState(false)
  const [workspaceView, setWorkspaceView] = useState<'editor' | 'mindmap' | 'flashcard'>('editor')
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

  const deriveTabStatus = (pageStatuses?: UploadedFileTab['status'][]): UploadedFileTab['status'] => {
    if (!pageStatuses || pageStatuses.length === 0) return 'pending'
    if (pageStatuses.includes('failed')) return 'failed'
    if (pageStatuses.includes('processing') || pageStatuses.includes('pending')) return 'processing'
    return 'ready'
  }

  useEffect(() => {
    // 移除未使用的 viewport width 监听
  }, [])

  // 加载登录用户信息
  // 把最新的 fileTabs 写入 ref，供轮询闭包使用
  useEffect(() => {
    fileTabsRef.current = [...fileTabs]
  }, [fileTabs])

  useEffect(() => {
    if (!sessionId) return
    const container = previewScrollRef.current
    if (!container) return
    const target = previewScrollPositions[sessionId] ?? 0
    if (container.scrollTop !== target) {
      container.scrollTo({ top: target })
    }
  }, [sessionId, previewScrollPositions])

  // 轮询后端会话状态，直到预览就绪
  useEffect(() => {
    const interval = window.setInterval(async () => {
      const pendingTabs = fileTabsRef.current.filter((t) => {
        if (t.isPlaceholder) return false
        if (t.previewType === 'image' && t.pageSessionIds?.length) {
          const pageStatuses = t.pageStatuses ?? []
          return pageStatuses.some((s) => s === 'pending' || s === 'processing')
        }
        return t.status === 'pending' || t.status === 'processing'
      })
      if (pendingTabs.length === 0) return

      try {
        const updates: UploadedFileTab[] = []
        for (const tab of pendingTabs) {
          // 对图片类型，逐页 session 轮询
          if (tab.previewType === 'image' && tab.pageSessionIds?.length) {
            const pageStatuses = tab.pageStatuses ?? Array(tab.pageSessionIds.length).fill('pending')
            const nextPreviewPages = [...tab.previewPages]
            const nextPageStatuses = [...pageStatuses]
            const normalizeUrl = (url: string) =>
              url.startsWith('http') ? url : `${backendBaseUrl}${url}`

            for (let i = 0; i < tab.pageSessionIds.length; i += 1) {
              const pageSessionId = tab.pageSessionIds[i]
              const status = nextPageStatuses[i] ?? 'pending'
              if (status !== 'pending' && status !== 'processing') continue
              const resp = await fetch(`${backendBaseUrl}/api/files/session/${pageSessionId}`)
              if (!resp.ok) continue
              const data = (await resp.json()) as SessionStatus
              let pageStatus: UploadedFileTab['status'] = status
              if (data.status === 'done') pageStatus = 'ready'
              else if (data.status === 'failed') pageStatus = 'failed'
              else if (data.status === 'processing') pageStatus = 'processing'

              nextPageStatuses[i] = pageStatus
              const pages = (data.preview_pages ?? []).map(normalizeUrl)
              const firstPreviewUrl =
                pages[0] ?? (data.preview_url ? normalizeUrl(data.preview_url) : null)
              if (firstPreviewUrl) {
                nextPreviewPages[i] = firstPreviewUrl
              }
            }

            const tabStatus = deriveTabStatus(nextPageStatuses)
            updates.push({
              ...tab,
              status: tabStatus,
              previewPages: nextPreviewPages,
              pageStatuses: nextPageStatuses,
            })
          } else {
            // 其他类型按原有单 session 轮询
            const resp = await fetch(
              `${backendBaseUrl}/api/files/session/${tab.sessionId}`,
            )
            if (!resp.ok) continue
            const data = (await resp.json()) as SessionStatus
            let nextStatus: UploadedFileTab['status'] = tab.status
            if (data.status === 'done') nextStatus = 'ready'
            else if (data.status === 'failed') nextStatus = 'failed'
            else if (data.status === 'processing') nextStatus = 'processing'

            if (nextStatus === tab.status && !data.preview_pages?.length) continue

            const normalizeUrl = (url: string) =>
              url.startsWith('http') ? url : `${backendBaseUrl}${url}`
            const pages = (data.preview_pages ?? []).map(normalizeUrl)
            const firstPreviewUrl =
              pages[0] ?? (data.preview_url ? normalizeUrl(data.preview_url) : null)

            updates.push({
              ...tab,
              status: nextStatus,
              previewUrl: firstPreviewUrl,
              previewPages: pages,
            })
          }
        }

        if (updates.length > 0) {
          const updateMap = new Map(
            updates.map((tab) => [`${tab.fileId}-${tab.sessionId}`, tab]),
          )
          setFileTabs((prev) =>
            prev.map((tab) => {
              const key = `${tab.fileId}-${tab.sessionId}`
              return updateMap.get(key) ?? tab
            }),
          )
        }
      } catch (err) {
        console.error('[session poll] failed', err)
      }
    }, 2000)

    return () => window.clearInterval(interval)
  }, [backendBaseUrl])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isUserMenuOpen &&
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setIsUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isUserMenuOpen])

  useEffect(() => {
    if (user) {
      setStatusMessage('logged_in', { email: user.email })
    } else {
      setStatusMessage('login_required')
    }
  }, [user])

  const handleAppLogout = useCallback(() => {
    handleLogout()
    setFileTabs([])
    setActiveTabIndex(-1)
    setOcrItems([])
    setStatusMessage('login_required')
    setIsUserMenuOpen(false)
  }, [handleLogout])

  const handleSelectionAddClick = useCallback(() => {
    if (!sessionId || !activeFile) {
      setStatusMessage('session_missing')
      return
    }
    void handleAddToEditor(sessionId, activeFile, selectionSnapshotRef.current)
  }, [activeFile, handleAddToEditor, selectionSnapshotRef, sessionId, setStatusMessage])

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
        return
      }

      setAgentDocumentId(documentId)

      const questions = await Promise.all(
        questionIds.map((qid) => getQuestion(qid, user.tenant_id, backendBaseUrl)),
      )

      const now = Date.now()
      const newItems = questions.map((q, idx) => {
        const createdAt = now + idx
        return {
          id: `glm-${documentId}-${q.id}`,
          region_index: idx,
          text: q.content,
          sessionId: sessionId,
          fileId: currentFile.fileId,
          fileName: currentFile.name,
          page: q.page ?? 1,
          createdAt,
          legendImages: q.legend_images ?? [],
          originalText: q.content,
          answerText: '',
          sourceType: 'upload' as const,
          questionMeta: {
            questionId: q.id,
            sequenceIndex: idx,
            groupId: null,
          },
        }
      })

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
  }, [
    backendBaseUrl,
    currentFile,
    sessionId,
    setOcrItems,
    setAgentDocumentId,
    setAppView,
    setStatusMessage,
    showToast,
    user,
  ])

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
            questionId: questionId,
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
    [user, backendBaseUrl, ocrItems.length, showToast, t],
  )

  const handleSendQuestionToAgent = useCallback((payload: AgentSendPayload) => {
    if (!payload || !payload.text?.trim()) return
    setIsAgentDrawerOpen(true)
    setAgentAppendToken({ id: Date.now(), payload })
  }, [])

  const handleAppendTokenConsumed = useCallback((tokenId: number) => {
    setAgentAppendToken((current) => {
      if (!current || current.id !== tokenId) return current
      return null
    })
  }, [])

  if (!user) {
    return (
      <AuthScreen
        authMode={authMode}
        onAuthModeChange={setAuthMode}
        authEmail={authEmail}
        onAuthEmailChange={setAuthEmail}
        authPassword={authPassword}
        onAuthPasswordChange={setAuthPassword}
        authTenantCode={authTenantCode}
        onAuthTenantCodeChange={(value) => setAuthTenantCode(value.trim() || 'default')}
        authDisplayName={authDisplayName}
        onAuthDisplayNameChange={setAuthDisplayName}
        authError={authError}
        authLoading={authLoading}
        onSubmit={handleAuthSubmit}
      />
    )
  }

  return (
    <div className="bg-background-light dark:bg-background-dark text-slate-900 font-display antialiased overflow-hidden h-screen flex flex-col">
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
        />

        {!isMobileOrTablet && appView !== 'favorites' && (
          <div
            onMouseDown={startResize}
            className="w-1 cursor-col-resize bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
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
          workspaceView={workspaceView}
          onWorkspaceViewChange={setWorkspaceView}
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

      <MemoizedAgentChatPanel
        backendBaseUrl={backendBaseUrl}
        user={user}
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
          className={`fixed right-6 bottom-6 z-50 min-w-[240px] rounded-xl px-4 py-3 shadow-lg text-sm text-white transition-all origin-bottom-right ${
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
