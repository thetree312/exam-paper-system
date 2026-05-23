import React from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../store/appStore'
import { useFileUpload, useOcrManager } from '../hooks'
import { getQuestion } from '../services/questionApi'
import { createTextMathDocument } from '../lib/mathContent'
import type { AggregatedOcrItem, StudioWorkspaceTab } from '../types'
import { EditorWorkspaceShell } from './EditorWorkspaceShell'
import { FavoritesPage } from './FavoritesPage'

interface EditorConnectorProps {
  backendBaseUrl: string
  onStatusMessage: (msg: string) => void
  onToast: (message: string, type: 'info' | 'success' | 'error') => void
}

export const EditorConnector: React.FC<EditorConnectorProps> = ({
  backendBaseUrl,
  onStatusMessage,
  onToast,
}) => {
  const user = useAppStore((state) => state.user)
  const appView = useAppStore((state) => state.appView)
  const setAppView = useAppStore((state) => state.setAppView)
  const isAnswerMode = useAppStore((state) => state.isAnswerMode)
  const setIsAnswerMode = useAppStore((state) => state.setIsAnswerMode)
  const isAgentDrawerOpen = useAppStore((state) => state.isAgentDrawerOpen)
  const setIsAgentDrawerOpen = useAppStore((state) => state.setIsAgentDrawerOpen)
  const studioDocumentId = useAppStore((state) => state.studioDocumentId)
  const setStudioDocumentId = useAppStore((state) => state.setStudioDocumentId)
  const setOcrItems = useAppStore((state) => state.setOcrItems)
  const { t } = useTranslation('common')
  const [studioTabs, setStudioTabs] = React.useState<StudioWorkspaceTab[]>([
    { id: 'editor-main', kind: 'editor' as const, title: '题卡', closable: false },
  ])
  const [activeStudioTabId, setActiveStudioTabId] = React.useState('editor-main')
  const [historyTabIds, setHistoryTabIds] = React.useState(['editor-main'])

  const {
    fileTabs: _fileTabs,
    activeTabIndex: _activeTabIndex,
    currentFile,
    sessionId,
    previewScrollRef,
  } = useFileUpload(backendBaseUrl, user, onStatusMessage)

  const {
    ocrItems,
    isGrading,
    splittingItemId,
    handleOcrItemUpdate,
    handleOcrItemDelete,
    handleAnswerChange,
    handleSplitOcrItem,
    handleSubmitGrading,
  } = useOcrManager(backendBaseUrl, onStatusMessage, onToast, studioDocumentId)

  const handleAddFavoriteToEditor = React.useCallback(
    async (questionId: number) => {
      if (!user) {
        onToast(t('app.toast.login_required'), 'error')
        return
      }

      try {
        onToast(t('app.toast.favorite_loading'), 'info')
        const question = await getQuestion(questionId, user.tenant_id, backendBaseUrl)
        const newItem: AggregatedOcrItem = {
          id: `favorite-${questionId}-${Date.now()}`,
          region_index: ocrItems.length,
          text: question.content,
          sessionId: `favorite-${questionId}`,
          fileId: `favorite-${questionId}`,
          fileName: 'Favorite Question',
          page: question.page || 1,
          createdAt: Date.now(),
          legendImages: question.legend_images || [],
          sourceType: 'favorite',
          questionMeta: {
            questionId,
          },
          originalText: question.content,
          answerContent: createTextMathDocument(''),
          answerText: '',
        }

        setOcrItems((prev) => [...prev, newItem])
        setAppView('editor')
        onToast(t('app.toast.favorite_success'), 'success')
      } catch (err) {
        console.error('[add_favorite_to_editor] failed', err)
        const errorMsg = err instanceof Error ? err.message : 'load_failed'
        onToast(t('app.toast.favorite_failed', { error: errorMsg }), 'error')
      }
    },
    [backendBaseUrl, ocrItems.length, onToast, setAppView, setOcrItems, t, user],
  )

  if (!user) {
    return null
  }

  if (appView === 'favorites') {
    return (
      <div className="flex-1 overflow-hidden">
        <FavoritesPage
          backendBaseUrl={backendBaseUrl}
          user={user}
          onToast={onToast}
          onBack={() => setAppView('editor')}
          onAddToEditor={handleAddFavoriteToEditor}
        />
      </div>
    )
  }

  const openStudioTab = (kind: 'editor' | 'mindmap' | 'flashcard' | 'preview') => {
    if (kind === 'preview') return
    const tabId = kind === 'editor' ? 'editor-main' : kind
    setStudioTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) return prev
      return [
        ...prev,
        { id: tabId, kind, title: kind === 'mindmap' ? '思维导图' : kind === 'flashcard' ? '闪卡' : '题卡', closable: kind !== 'editor' },
      ]
    })
    setActiveStudioTabId(tabId)
    setHistoryTabIds((prev) => [...prev.filter((id) => id !== tabId), tabId])
  }

  const activateStudioTab = (tabId: string) => {
    setActiveStudioTabId(tabId)
    setHistoryTabIds((prev) => [...prev.filter((id) => id !== tabId), tabId])
  }

  const closeStudioTab = (tabId: string) => {
    if (tabId === 'editor-main') return
    setStudioTabs((prev) => prev.filter((tab) => tab.id !== tabId))
    setHistoryTabIds((prev) => prev.filter((id) => id !== tabId))
    if (activeStudioTabId === tabId) {
      const fallback = [...historyTabIds].filter((id) => id !== tabId).reverse()[0] ?? 'editor-main'
      setActiveStudioTabId(fallback)
    }
  }

  return (
    <EditorWorkspaceShell
      backendBaseUrl={backendBaseUrl}
      user={user}
      studioTabs={studioTabs}
      activeStudioTabId={activeStudioTabId}
      onOpenStudioTab={openStudioTab}
      onActivateStudioTab={activateStudioTab}
        onCloseStudioTab={closeStudioTab}
        onReorderStudioTabs={() => {}}
        onUpdateStudioPreviewContent={() => {}}
        onUpdateStudioPreviewViewMode={() => {}}
        onSaveStudioPreviewTab={async () => false}
      studioDataSourceMode={'keep_workset'}
      onStudioDataSourceModeChange={() => {}}
      isAnswerMode={isAnswerMode}
      onToggleAnswerMode={() => setIsAnswerMode(!isAnswerMode)}
      onOpenAgentDrawer={() => setIsAgentDrawerOpen(!isAgentDrawerOpen)}
      currentFile={currentFile}
      sessionId={sessionId != null ? String(sessionId) : null}
      ocrItems={ocrItems}
      studioDocumentId={studioDocumentId}
      sourceDocumentId={currentFile?.fileId != null ? String(currentFile.fileId) : null}
      onDocumentChange={(id) => setStudioDocumentId(id != null ? String(id) : null)}
      onUpdateItem={handleOcrItemUpdate}
      onDeleteItem={handleOcrItemDelete}
      onSendToAgent={() => {}}
      onAnswerChange={handleAnswerChange}
      onSubmitGrading={() =>
        handleSubmitGrading(
          currentFile,
          studioDocumentId,
          currentFile?.fileId != null ? String(currentFile.fileId) : null,
          user,
        )
      }
      isGrading={isGrading}
      onSplitItem={(item, idx) => handleSplitOcrItem(item, idx, user)}
      splittingItemId={splittingItemId}
      previewScrollRef={previewScrollRef}
      onToast={onToast}
      onRunGlmOcr={async () => studioDocumentId}
    />
  )
}


