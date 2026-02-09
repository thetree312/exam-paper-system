import React from 'react'
import { useTranslation } from 'react-i18next'
import { EditorWorkspaceShell } from './EditorWorkspaceShell'
import { FavoritesPage } from './FavoritesPage'
import { useAppStore } from '../store/appStore'
import { useFileUpload, useOcrManager } from '../hooks'
import { getQuestion } from '../services/questionApi'
import type { AggregatedOcrItem } from '../types'

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
  const workspaceView = useAppStore((state) => state.workspaceView)
  const setWorkspaceView = useAppStore((state) => state.setWorkspaceView)
  const isAnswerMode = useAppStore((state) => state.isAnswerMode)
  const setIsAnswerMode = useAppStore((state) => state.setIsAnswerMode)
  const isAgentDrawerOpen = useAppStore((state) => state.isAgentDrawerOpen)
  const setIsAgentDrawerOpen = useAppStore((state) => state.setIsAgentDrawerOpen)
  const agentDocumentId = useAppStore((state) => state.agentDocumentId)
  const setAgentDocumentId = useAppStore((state) => state.setAgentDocumentId)
  const isExportDialogOpen = useAppStore((state) => state.isExportDialogOpen)
  const setIsExportDialogOpen = useAppStore((state) => state.setIsExportDialogOpen)

  const { t } = useTranslation('common')

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
  } = useOcrManager(backendBaseUrl, onStatusMessage, onToast, agentDocumentId)

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

        handleOcrItemUpdate(newItem.id, () => newItem)
        setAppView('editor')
        onToast(t('app.toast.favorite_success'), 'success')
      } catch (err) {
        console.error('[add_favorite_to_editor] failed', err)
        const errorMsg = err instanceof Error ? err.message : '加载失败'
        onToast(t('app.toast.favorite_failed', { error: errorMsg }), 'error')
      }
    },
    [user, backendBaseUrl, ocrItems.length, onToast, handleOcrItemUpdate, setAppView, t],
  )

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

  return (
    <EditorWorkspaceShell
      backendBaseUrl={backendBaseUrl}
      user={user}
      workspaceView={workspaceView}
      onWorkspaceViewChange={setWorkspaceView}
      isAnswerMode={isAnswerMode}
      onToggleAnswerMode={() => setIsAnswerMode(!isAnswerMode)}
      isAgentDrawerOpen={isAgentDrawerOpen}
      onOpenAgentDrawer={() => setIsAgentDrawerOpen(!isAgentDrawerOpen)}
      currentFile={currentFile}
      sessionId={sessionId}
      ocrItems={ocrItems}
      agentDocumentId={agentDocumentId}
      onDocumentChange={setAgentDocumentId}
      onUpdateItem={handleOcrItemUpdate}
      onDeleteItem={handleOcrItemDelete}
      onSendToAgent={() => {}}
      onAnswerChange={handleAnswerChange}
      onSubmitGrading={() => handleSubmitGrading(currentFile, agentDocumentId, user!)}
      isGrading={isGrading}
      onSplitItem={(item, idx) => handleSplitOcrItem(item, idx, user!)}
      splittingItemId={splittingItemId}
      previewScrollRef={previewScrollRef}
      onToast={onToast}
    />
  )
}
