import React from 'react'
import type { AgentSendPayload, AggregatedOcrItem, UploadedFileTab, UserInfo } from '../types'
import { AgentWorkspacePanel } from './AgentWorkspacePanel'
import { MindMapPanel } from '../features/mindmap/MindMapPanel'

export type WorkspaceView = 'editor' | 'mindmap'

interface EditorWorkspaceShellProps {
  backendBaseUrl: string
  user: UserInfo | null
  workspaceView: WorkspaceView
  onWorkspaceViewChange: (view: WorkspaceView) => void
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
  /** 触发 GLM-OCR 全卷解析的回调，由上层 App 负责调用后端并更新题卡列表 */
  onRunGlmOcr: () => void
}

export const EditorWorkspaceShell: React.FC<EditorWorkspaceShellProps> = ({
  backendBaseUrl,
  user,
  workspaceView,
  onWorkspaceViewChange,
  isAnswerMode,
  onToggleAnswerMode,
  isAgentDrawerOpen,
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
  return (
    <section className="flex-1 relative bg-background-light dark:bg-background-dark flex flex-col">
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex bg-white border border-slate-200 rounded-full shadow-lg p-1.5 gap-1">
        <button
          className="p-2 rounded-full text-slate-600"
          type="button"
          title="文本"
          onClick={onRunGlmOcr}
        >
          <span className="material-symbols-outlined text-[20px]">title</span>
        </button>
        <button className="p-2 rounded-full text-slate-600" type="button" title="图片">
          <span className="material-symbols-outlined text-[20px]">image</span>
        </button>
        <button
          className={`p-2 rounded-full text-slate-600 ${workspaceView === 'mindmap' ? 'bg-slate-200' : ''}`}
          type="button"
          title="思维导图"
          onClick={() => onWorkspaceViewChange(workspaceView === 'mindmap' ? 'editor' : 'mindmap')}
        >
          <span className="material-symbols-outlined text-[20px]">account_tree</span>
        </button>
        <button
          className={`p-2 rounded-full flex items-center gap-1.5 text-sm ${
            isAnswerMode ? 'bg-slate-900 text-white shadow-inner' : 'text-slate-600'
          }`}
          type="button"
          title="答题模式"
          onClick={onToggleAnswerMode}
        >
          <span className="material-symbols-outlined text-[18px]">edit_note</span>
        </button>
        <div className="w-px bg-slate-200 mx-1" />
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-purple-600"
          type="button"
          onClick={onOpenAgentDrawer}
          title="Copilot 对话"
        >
          <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
          Copilot
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-0 lg:p-6 pb-8 scrollbar-hidden">
        {workspaceView === 'mindmap' ? (
          <div className="h-full w-full rounded-xl border border-slate-200 overflow-hidden bg-white shadow-inner">
            <MindMapPanel
              backendBaseUrl={backendBaseUrl}
              documentId={agentDocumentId}
              fileId={currentFile?.fileId ?? null}
              user={user}
              onBack={() => onWorkspaceViewChange('editor')}
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
        ) : (
          <div className="bg-white w-full max-w-[800px] min-h-[900px] mx-auto shadow-sm border border-slate-200 rounded-sm p-12 flex flex-col gap-6">
            <div className="text-center border-b-2 border-slate-900 pb-6">
              <h1 className="text-3xl font-bold text-slate-900 mb-2">内容工作区</h1>
              <p className="text-slate-500 font-medium">{sessionId ? `当前 Session #${sessionId}` : '尚未开始'}</p>
            </div>

            <div className="text-sm text-slate-500 mb-2">识别结果</div>
            <div className="space-y-6">
              <AgentWorkspacePanel
                backendBaseUrl={backendBaseUrl}
                user={user!}
                items={ocrItems}
                documentTitle={currentFile?.name}
                initialDocumentId={agentDocumentId}
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
