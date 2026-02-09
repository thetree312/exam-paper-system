import React, { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { UploadedFileTab } from '../types'

interface FileTabsBarProps {
  fileTabs: UploadedFileTab[]
  activeTabIndex: number
  onTabSelect: (index: number) => void
  onAddTab: () => void
  onCloseTab: (index: number) => void
  isUploading: boolean
  onCollapse?: () => void
}

const renderOfficeIcon = (type: UploadedFileTab['previewType']) => {
  switch (type) {
    case 'word':
      return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 mr-2 flex-shrink-0">
          <rect width="24" height="24" rx="2" fill="#2B579A" />
          <text x="12" y="17" fill="white" fontSize="14" fontWeight="bold" textAnchor="middle">
            W
          </text>
        </svg>
      )
    case 'excel':
      return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 mr-2 flex-shrink-0">
          <rect width="24" height="24" rx="2" fill="#217346" />
          <text x="12" y="17" fill="white" fontSize="14" fontWeight="bold" textAnchor="middle">
            X
          </text>
        </svg>
      )
    case 'powerpoint':
      return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 mr-2 flex-shrink-0">
          <rect width="24" height="24" rx="2" fill="#D24726" />
          <text x="12" y="17" fill="white" fontSize="14" fontWeight="bold" textAnchor="middle">
            P
          </text>
        </svg>
      )
    case 'onenote':
      return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 mr-2 flex-shrink-0">
          <rect width="24" height="24" rx="2" fill="#80397B" />
          <text x="12" y="17" fill="white" fontSize="14" fontWeight="bold" textAnchor="middle">
            N
          </text>
        </svg>
      )
    case 'pdf':
      return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 mr-2 flex-shrink-0">
          <rect width="24" height="24" rx="2" fill="#E02A00" />
          <circle cx="12" cy="12" r="6" fill="none" stroke="white" strokeWidth="2" />
        </svg>
      )
    case 'image':
      return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 mr-2 flex-shrink-0">
          <rect width="24" height="24" rx="2" fill="#1b9a59" />
          <circle cx="17" cy="8" r="2" fill="white" />
          <path d="M4 18l4-5 3 3 4-5 5 7" stroke="white" strokeWidth="2" fill="none" />
        </svg>
      )
    default:
      return (
        <span className="material-symbols-outlined text-[16px] text-slate-500 mr-2">insert_drive_file</span>
      )
  }
}

export const FileTabsBar: React.FC<FileTabsBarProps> = ({
  fileTabs,
  activeTabIndex,
  onTabSelect,
  onAddTab,
  onCloseTab,
  isUploading,
  onCollapse,
}) => {
  const { t } = useTranslation('common')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault()
        el.scrollBy({ left: event.deltaY, behavior: 'auto' })
      }
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', handleWheel)
    }
  }, [])

  const addButtonContent = useMemo(
    () =>
      isUploading ? (
        <span className="material-symbols-outlined text-[18px] text-gray-400 animate-spin">progress_activity</span>
      ) : (
        <span className="material-symbols-outlined text-[18px] text-gray-600">add</span>
      ),
    [isUploading],
  )

  return (
    <div
      className="bg-[#E9EEF5] px-2 border-b border-[#D1D1D1] h-[34px] flex items-end"
    >
      <div className="flex items-center gap-2 w-full">
        <div ref={scrollRef} className="flex items-end gap-1 overflow-x-auto no-scrollbar pr-2 flex-1 h-full">
          {fileTabs.map((tab, index) => {
            const isActive = index === activeTabIndex
            const showDivider =
              activeTabIndex !== index && activeTabIndex !== index + 1 && index < fileTabs.length - 1
            return (
              <div key={`${tab.fileId}-${tab.sessionId}`} className="flex items-center group relative">
                <button
                  type="button"
                  onClick={() => onTabSelect(index)}
                  className={`relative min-w-[140px] max-w-[210px] h-[32px] flex items-center pl-3 pr-2 cursor-default transition-all duration-150 border-none ${
                    isActive
                      ? 'bg-white text-gray-800 z-10 rounded-t-[6px] shadow-[0_-1px_4px_rgba(0,0,0,0.04)]'
                      : 'text-gray-600 hover:bg-[#DCE3ED] rounded-t-[6px]'
                  }`}
                >
                  {renderOfficeIcon(tab.previewType)}
                  <span className="text-[11px] truncate font-normal tracking-tight flex-1 text-left">
                    {tab.name}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className={`material-symbols-outlined text-[14px] ml-1 p-0.5 rounded-sm hover:bg-gray-200 transition-opacity [&:focus-visible]:ring-2 [&:focus-visible]:ring-offset-1 [&:focus-visible]:ring-slate-400 ${
                      isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onCloseTab(index)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onCloseTab(index)
                      }
                    }}
                    aria-label={t('file_tabs.close_label')}
                  >
                    close
                  </span>
                </button>
                {showDivider && <div className="h-[16px] w-[1px] bg-[#C1C6CC] self-center" />}
              </div>
            )
          })}

          <button
            type="button"
            onClick={onAddTab}
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-[#DCE3ED] mb-[3px] ml-1 cursor-pointer transition-colors"
            disabled={isUploading}
          >
            {addButtonContent}
          </button>
        </div>

        {onCollapse && (
          <button
            type="button"
            className="flex-shrink-0 inline-flex items-center justify-center px-1.5 h-8 text-[#647185] hover:text-[#4c586d] mr-[-8px]"
            onClick={onCollapse}
            title={t('file_tabs.collapse_label')}
          >
            <span className="material-symbols-outlined text-[22px] leading-none">menu_open</span>
          </button>
        )}
      </div>
    </div>
  )
}
