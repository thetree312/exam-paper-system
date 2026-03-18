import React from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentSendPayload, AggregatedOcrItem, UploadedFileTab, UserInfo } from '../types'
import { MindMapPanel } from '../features/mindmap/MindMapPanel'
import { AgentWorkspacePanel } from './AgentWorkspacePanel'
import { FlashcardPanel } from './FlashcardPanel'

export type StudioView = 'editor' | 'mindmap' | 'flashcard'

interface EditorWorkspaceShellProps {
  backendBaseUrl: string
  user: UserInfo | null
  workroomId?: number | null
  studioView: StudioView
  onStudioViewChange: (view: StudioView) => void
  isAnswerMode: boolean
  onToggleAnswerMode: () => void
  isAgentDrawerOpen: boolean
  onOpenAgentDrawer: () => void
  currentFile: UploadedFileTab | null
  sessionId: number | null
  ocrItems: AggregatedOcrItem[]
  agentDocumentId: number | null
  onDocumentChange: (id: number | null) => void
  onUpdateItem: (id: string, updater: (prev: AggregatedOcrItem) => AggregatedOcrItem) => void
  onDeleteItem: (id: string) => void
  onSendToAgent: (payload: AgentSendPayload) => void
  onAnswerChange: (id: string, value: string) => void
  onSubmitGrading: () => void
  isGrading: boolean
  onSplitItem: (item: AggregatedOcrItem, index: number) => void
  splittingItemId: string | null
  previewScrollRef: React.RefObject<HTMLDivElement>
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
  onRunGlmOcr: () => Promise<number | null>
}

export const EditorWorkspaceShell: React.FC<EditorWorkspaceShellProps> = ({
  backendBaseUrl,
  user,
  workroomId = null,
  studioView,
  onStudioViewChange,
  isAnswerMode,
  onToggleAnswerMode,
  onOpenAgentDrawer,
  currentFile,
  sessionId,
  ocrItems,
  agentDocumentId,
  onDocumentChange,
  onUpdateItem,
  onDeleteItem,
  onSendToAgent,
  onAnswerChange,
  onSubmitGrading,
  isGrading,
  onSplitItem,
  splittingItemId,
  previewScrollRef,
  onToast,
  onRunGlmOcr,
}) => {
  const { t } = useTranslation('common')

  return (
    <section className="relative flex flex-1 flex-col bg-background-light">
      <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 gap-1 rounded-full border border-slate-200 bg-white p-1.5 shadow-lg">
        <button
          className="rounded-full p-2 text-slate-600"
          type="button"
          title={t('editor_workspace.text_button')}
          onClick={() => {
            void onRunGlmOcr()
          }}
        >
          <span className="material-symbols-outlined text-[20px]">title</span>
        </button>
        <button
          className={`rounded-full p-2 text-slate-600 ${studioView === 'flashcard' ? 'bg-slate-200' : ''}`}
          type="button"
          title={t('editor_workspace.flashcard_button')}
          onClick={() => onStudioViewChange(studioView === 'flashcard' ? 'editor' : 'flashcard')}
        >
          <span className="material-symbols-outlined text-[20px]">image</span>
        </button>
        <button
          className={`rounded-full p-2 text-slate-600 ${studioView === 'mindmap' ? 'bg-slate-200' : ''}`}
          type="button"
          title={t('editor_workspace.mindmap_button')}
          onClick={() => onStudioViewChange(studioView === 'mindmap' ? 'editor' : 'mindmap')}
        >
          <span className="material-symbols-outlined text-[20px]">account_tree</span>
        </button>
        <button
          className={`flex items-center gap-1.5 rounded-full p-2 text-sm ${
            isAnswerMode ? 'bg-slate-900 text-white shadow-inner' : 'text-slate-600'
          }`}
          type="button"
          title={t('editor_workspace.answer_mode_button')}
          onClick={onToggleAnswerMode}
        >
          <span className="material-symbols-outlined text-[18px]">edit_note</span>
        </button>
        <div className="mx-1 w-px bg-slate-200" />
        <button
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-purple-600"
          type="button"
          onClick={onOpenAgentDrawer}
          title={t('editor_workspace.copilot_button')}
        >
          <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
          {t('editor_workspace.copilot_button')}
        </button>
      </div>

      <div className="scrollbar-hidden flex-1 overflow-y-auto p-0 pb-8 lg:p-6">
        {studioView === 'mindmap' ? (
          <div className="h-full w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-inner">
            <MindMapPanel
              backendBaseUrl={backendBaseUrl}
              documentId={agentDocumentId}
              fileId={currentFile?.fileId ?? null}
              user={user}
              onBack={() => onStudioViewChange('editor')}
              onNavigateToQuestion={(target) => {
                if (!target) return
                if (typeof target.sequenceIndex === 'number') {
                  const index = target.sequenceIndex
                  const el = document.querySelector(`#question-card-${index + 1}`)
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                }
                if (typeof target.page === 'number' && previewScrollRef.current) {
                  previewScrollRef.current.scrollTo({
                    top: (target.page - 1) * 400,
                    behavior: 'smooth',
                  })
                }
              }}
            />
          </div>
        ) : studioView === 'flashcard' ? (
          <FlashcardPanel
            backendBaseUrl={backendBaseUrl}
            documentId={agentDocumentId}
            documentTitle={currentFile?.name ?? null}
            user={user}
            onBack={() => onStudioViewChange('editor')}
            onToast={onToast}
            ensureDocument={onRunGlmOcr}
            onDocumentResolved={onDocumentChange}
          />
        ) : (
          <div className="mx-auto flex min-h-[900px] w-full max-w-[800px] flex-col gap-6 rounded-sm border border-slate-200 bg-white p-12 shadow-sm">
            <div className="border-b-2 border-slate-900 pb-6 text-center">
              <h1 className="mb-2 text-3xl font-bold text-slate-900">{t('editor_workspace.workspace_title')}</h1>
              <p className="font-medium text-slate-500">
                {sessionId
                  ? t('editor_workspace.session_label', { sessionId })
                  : t('editor_workspace.session_not_started')}
              </p>
            </div>

            <div className="mb-2 text-sm text-slate-500">{t('editor_workspace.recognition_results')}</div>
            <div className="space-y-6">
              <AgentWorkspacePanel
                backendBaseUrl={backendBaseUrl}
                user={user!}
                items={ocrItems}
                documentTitle={currentFile?.name}
                initialDocumentId={agentDocumentId}
                workroomId={workroomId}
                onUpdateItem={onUpdateItem}
                onDeleteItem={onDeleteItem}
                onDocumentChange={onDocumentChange}
                onSendToAgent={onSendToAgent}
                onAnswerChange={onAnswerChange}
                onSubmitGrading={onSubmitGrading}
                isGrading={isGrading}
                answerMode={isAnswerMode}
                onSplitItem={onSplitItem}
                splittingItemId={splittingItemId}
                onToast={onToast}
              />
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
