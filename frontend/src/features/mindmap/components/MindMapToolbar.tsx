import React from 'react'
import { useTranslation } from 'react-i18next'

export interface MindMapToolbarProps {
  mode: 'document' | 'file'
  onModeChange: (next: 'document' | 'file') => void
  mindmapMode: 'knowledge_structure' | 'exam_review'
  onMindmapModeChange: (next: 'knowledge_structure' | 'exam_review') => void
  layoutMode: 'side' | 'left' | 'right'
  onCycleLayout: () => void
  canUseDocument: boolean
  canUseFile: boolean
  onRefresh: () => void
  refreshDisabled: boolean
  refreshLabel: string
  showSave: boolean
  onSave: () => void
  saveDisabled: boolean
  canControlView: boolean
  onUndo: () => void
  onRedo: () => void
  onFitView: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onExportPng: () => void
}

const MindMapToolbar: React.FC<MindMapToolbarProps> = ({
  mode,
  onModeChange,
  mindmapMode,
  onMindmapModeChange,
  layoutMode,
  onCycleLayout,
  canUseDocument,
  canUseFile,
  onRefresh,
  refreshDisabled,
  refreshLabel,
  showSave,
  onSave,
  saveDisabled,
  canControlView,
  onUndo,
  onRedo,
  onFitView,
  onExpandAll,
  onCollapseAll,
  onExportPng,
}) => {
  const { t } = useTranslation('common')
  const layoutIcon =
    layoutMode === 'left' ? 'left_panel_open' : layoutMode === 'right' ? 'right_panel_open' : 'account_tree'
  const layoutTitle =
    layoutMode === 'left'
      ? t('mindmap_toolbar.layout_left')
      : layoutMode === 'right'
        ? t('mindmap_toolbar.layout_right')
        : t('mindmap_toolbar.layout_side')

  return (
    <div className="absolute inset-x-2 bottom-3 z-10 flex justify-center lg:inset-x-auto lg:bottom-4 lg:right-4 lg:top-4 lg:items-start">
      <div className="flex max-w-full items-center gap-2 overflow-x-auto rounded-[22px] border border-slate-200 bg-white/92 px-2 py-2 shadow-lg backdrop-blur scrollbar-hidden lg:max-h-full lg:flex-col lg:items-center lg:gap-2 lg:overflow-x-visible lg:overflow-y-auto lg:rounded-[26px] lg:px-2 lg:py-2">
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-50/90 p-1.5 lg:flex-col lg:p-2">
          <button
            type="button"
            title={t('mindmap_toolbar.document_mode')}
            disabled={!canUseDocument}
            onClick={() => onModeChange('document')}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
              mode === 'document' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-900'
            } disabled:cursor-not-allowed disabled:opacity-30`}
          >
            <span className="material-symbols-outlined text-[20px] leading-none">description</span>
          </button>
          <button
            type="button"
            title={t('mindmap_toolbar.file_mode')}
            disabled={!canUseFile}
            onClick={() => onModeChange('file')}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
              mode === 'file' ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-900'
            } disabled:cursor-not-allowed disabled:opacity-30`}
          >
            <span className="material-symbols-outlined text-[20px] leading-none">article</span>
          </button>
        </div>

        <div className="h-8 w-px shrink-0 bg-slate-200 lg:h-px lg:w-8" />
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-50/90 p-1.5 lg:flex-col lg:p-2">
          <button
            type="button"
            title={t('mindmap_toolbar.mode_knowledge_structure')}
            onClick={() => onMindmapModeChange('knowledge_structure')}
            aria-label={t('mindmap_toolbar.mode_knowledge_structure')}
            className={`inline-flex min-w-[72px] items-center justify-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors lg:h-9 lg:min-w-0 lg:px-2 ${
              mindmapMode === 'knowledge_structure'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="material-symbols-outlined text-[16px] leading-none">book_ribbon</span>
            <span className="lg:hidden">{t('mindmap_toolbar.mode_knowledge_short')}</span>
          </button>
          <button
            type="button"
            title={t('mindmap_toolbar.mode_exam_review')}
            onClick={() => onMindmapModeChange('exam_review')}
            aria-label={t('mindmap_toolbar.mode_exam_review')}
            className={`inline-flex min-w-[72px] items-center justify-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors lg:h-9 lg:min-w-0 lg:px-2 ${
              mindmapMode === 'exam_review' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="material-symbols-outlined text-[16px] leading-none">cognition_2</span>
            <span className="lg:hidden">{t('mindmap_toolbar.mode_exam_short')}</span>
          </button>
        </div>

        <div className="h-8 w-px shrink-0 bg-slate-200 lg:h-px lg:w-8" />

        <button
          type="button"
          title={layoutTitle}
          onClick={onCycleLayout}
          disabled={!canControlView}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">{layoutIcon}</span>
        </button>
        <button
          type="button"
          title={refreshLabel}
          onClick={onRefresh}
          disabled={refreshDisabled}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">autorenew</span>
        </button>
        <button
          type="button"
          title={t('mindmap_toolbar.undo')}
          onClick={onUndo}
          disabled={!canControlView}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">undo</span>
        </button>
        <button
          type="button"
          title={t('mindmap_toolbar.redo')}
          onClick={onRedo}
          disabled={!canControlView}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">redo</span>
        </button>
        <button
          type="button"
          title={t('mindmap_toolbar.fit_view')}
          onClick={onFitView}
          disabled={!canControlView}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">fit_screen</span>
        </button>
        <button
          type="button"
          title={t('mindmap_toolbar.expand_all')}
          onClick={onExpandAll}
          disabled={!canControlView}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">unfold_more</span>
        </button>
        <button
          type="button"
          title={t('mindmap_toolbar.collapse_all')}
          onClick={onCollapseAll}
          disabled={!canControlView}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">unfold_less</span>
        </button>
        <button
          type="button"
          title={t('mindmap_toolbar.export_png')}
          onClick={onExportPng}
          disabled={!canControlView}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <span className="material-symbols-outlined text-[18px] leading-none">download</span>
        </button>
        {showSave && (
          <button
            type="button"
            title={t('mindmap_toolbar.save_mindmap')}
            onClick={onSave}
            disabled={saveDisabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <span className="material-symbols-outlined text-[18px] leading-none">save</span>
          </button>
        )}
      </div>
    </div>
  )
}

export default MindMapToolbar
