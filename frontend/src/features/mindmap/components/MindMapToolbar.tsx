import React from 'react'
import { useTranslation } from 'react-i18next'
import type { MindMapLayoutStyle } from './MindMapFlow'

export interface MindMapToolbarProps {
  mode: 'document' | 'file'
  onModeChange: (next: 'document' | 'file') => void
  canUseDocument: boolean
  canUseFile: boolean
  layoutStyle: MindMapLayoutStyle
  onLayoutChange: (style: MindMapLayoutStyle) => void
  onRefresh: () => void
  refreshDisabled: boolean
  refreshLabel: string
  showSave: boolean
  onSave: () => void
  saveDisabled: boolean
}

const MODE_BUTTON_SIZE = 36
const MODE_BUTTON_GAP = 6
const MODE_BUTTON_PADDING = 6

const MindMapToolbar: React.FC<MindMapToolbarProps> = ({
  mode,
  onModeChange,
  canUseDocument,
  canUseFile,
  layoutStyle,
  onLayoutChange,
  onRefresh,
  refreshDisabled,
  refreshLabel,
  showSave,
  onSave,
  saveDisabled,
}) => {
  const { t } = useTranslation('common')
  const modeOptions: Array<{
    key: 'document' | 'file'
    icon: string
    label: string
    disabled: boolean
  }> = [
    { key: 'document', icon: 'contextual_token_add', label: t('mindmap_toolbar.document_mode'), disabled: !canUseDocument },
    { key: 'file', icon: 'article', label: t('mindmap_toolbar.file_mode'), disabled: !canUseFile },
  ]
  const layoutOptions: Array<{ key: MindMapLayoutStyle; icon: string; title: string }> = [
    { key: 'xmind', icon: 'schema', title: t('mindmap_toolbar.xmind_layout') },
    { key: 'hierarchy', icon: 'account_tree', title: t('mindmap_toolbar.hierarchy_layout') },
    { key: 'grid', icon: 'family_history', title: t('mindmap_toolbar.grid_layout') },
  ]

  const activeModeIndex = modeOptions.findIndex((opt) => opt.key === mode)
  const highlightOffset = activeModeIndex * (MODE_BUTTON_SIZE + MODE_BUTTON_GAP)

  const toolbarButtonClasses = (active: boolean) =>
    [
      'w-8 h-8 flex items-center justify-center rounded-lg transition-colors duration-150',
      'text-[18px] material-symbols-outlined leading-none',
      active ? 'text-slate-900 drop-shadow-sm' : 'text-slate-400 hover:text-slate-900',
      'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-slate-400',
    ].join(' ')

  const actionButtonClasses =
    'w-8 h-8 flex items-center justify-center rounded-lg text-[18px] material-symbols-outlined leading-none text-slate-500 hover:text-slate-900 transition-colors disabled:opacity-30 disabled:cursor-not-allowed'

  return (
    <div className="absolute top-6 right-6 z-10">
      <div className="flex flex-col items-center gap-3 rounded-[26px] border border-slate-200 bg-white/90 backdrop-blur px-2.5 py-3 shadow-lg w-[66px]">
        <div className="relative flex flex-col items-center gap-[6px] rounded-full border border-slate-200 bg-slate-50/90 px-2 py-2 w-full">
          <span
            className="absolute rounded-full bg-slate-900 transition-transform duration-200 ease-out shadow-lg"
            style={{
              width: MODE_BUTTON_SIZE,
              height: MODE_BUTTON_SIZE,
              left: '50%',
              top: MODE_BUTTON_PADDING + highlightOffset,
              transform: 'translateX(-50%)',
            }}
          />
          {modeOptions.map((option) => {
            const isActive = option.key === mode
            return (
              <button
                key={option.key}
                type="button"
                title={option.label}
                disabled={option.disabled}
                onClick={() => onModeChange(option.key)}
                className={[
                  'relative z-10 rounded-full flex items-center justify-center transition-colors duration-150',
                  isActive ? 'text-white' : 'text-slate-500 hover:text-slate-900',
                  option.disabled ? 'opacity-40 cursor-not-allowed hover:text-slate-500' : '',
                ].join(' ')}
                style={{ width: MODE_BUTTON_SIZE, height: MODE_BUTTON_SIZE }}
              >
                <span className="material-symbols-outlined text-[22px] leading-none">{option.icon}</span>
              </button>
            )
          })}
        </div>

        <div className="w-8 h-px bg-slate-200" />

        <div className="flex flex-col items-center gap-1.5">
          {layoutOptions.map((option) => {
            const isActive = layoutStyle === option.key
            return (
              <button
                key={option.key}
                type="button"
                title={option.title}
                onClick={() => onLayoutChange(option.key)}
                className={toolbarButtonClasses(isActive)}
              >
                <span className="material-symbols-outlined text-[16px] leading-none">{option.icon}</span>
              </button>
            )
          })}
        </div>

        <div className="w-6 h-px bg-slate-200" />

        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            title={refreshLabel}
            onClick={onRefresh}
            disabled={refreshDisabled}
            className={actionButtonClasses}
          >
            <span className="material-symbols-outlined text-[16px] leading-none">refresh</span>
          </button>
          {showSave && (
            <button type="button" title={t('mindmap_toolbar.save_mindmap')} onClick={onSave} disabled={saveDisabled} className={actionButtonClasses}>
              <span className="material-symbols-outlined text-[16px] leading-none">save</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default MindMapToolbar
