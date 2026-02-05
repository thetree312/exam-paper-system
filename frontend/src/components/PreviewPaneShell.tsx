import React from 'react'
import type { UploadedFileTab, UserInfo } from '../types'
import { FileTabsBar } from './FileTabsBar'
import { SelectionPane } from './SelectionPane'
import { FavoritesPage } from './FavoritesPage'

interface PreviewPaneShellProps {
  leftPaneRef: React.RefObject<HTMLElement>
  style: React.CSSProperties
  isPreviewCollapsed: boolean
  isMobileOrTablet: boolean
  appView: 'editor' | 'favorites'
  onAppViewChange: (view: 'editor' | 'favorites') => void
  collapsePreview: () => void
  expandPreview: () => void
  fileTabs: UploadedFileTab[]
  activeTabIndex: number
  isUploading: boolean
  onAddEmptyTab: () => void
  onTabSelect: (index: number) => void
  onCloseTab: (index: number) => void
  onUploadClick: () => void
  fileInputRef: React.RefObject<HTMLInputElement>
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  previewSources: string[]
  previewType: UploadedFileTab['previewType']
  activeStatus: UploadedFileTab['status']
  hasActiveFile: boolean
  pageRefs: React.MutableRefObject<Record<number, HTMLDivElement | null>>
  imageRefs: React.MutableRefObject<Record<number, HTMLImageElement | null>>
  isExtracting: boolean
  previewScrollRef: React.RefObject<HTMLDivElement>
  onSelectionSnapshotChange: (snapshot: any) => void
  onSelectionAddClick: () => void
  onClearSelection: () => void
  backendBaseUrl: string
  user: UserInfo | null
  onToast: (message: string, type: 'info' | 'success' | 'error') => void
  onAddFavoriteToEditor: (questionId: number) => Promise<void> | void
}

export const PreviewPaneShell: React.FC<PreviewPaneShellProps> = ({
  leftPaneRef,
  style,
  isPreviewCollapsed,
  isMobileOrTablet,
  appView,
  onAppViewChange,
  collapsePreview,
  expandPreview,
  fileTabs,
  activeTabIndex,
  isUploading,
  onAddEmptyTab,
  onTabSelect,
  onCloseTab,
  onUploadClick,
  fileInputRef,
  onFileChange,
  previewSources,
  previewType,
  activeStatus,
  hasActiveFile,
  pageRefs,
  imageRefs,
  isExtracting,
  previewScrollRef,
  onSelectionSnapshotChange,
  onSelectionAddClick,
  onClearSelection,
  backendBaseUrl,
  user,
  onToast,
  onAddFavoriteToEditor,
}) => {
  return (
    <aside
      className="bg-white dark:bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 flex flex-col relative"
      ref={leftPaneRef}
      style={style}
    >
      {!isPreviewCollapsed && (
        <>
          <FileTabsBar
            fileTabs={fileTabs}
            activeTabIndex={activeTabIndex}
            onTabSelect={onTabSelect}
            onAddTab={onAddEmptyTab}
            onCloseTab={onCloseTab}
            isUploading={isUploading}
            onCollapse={!isMobileOrTablet ? collapsePreview : undefined}
          />

          <SelectionPane
            previewSources={previewSources}
            previewType={previewType}
            activeStatus={activeStatus}
            hasActiveFile={hasActiveFile}
            pageRefs={pageRefs}
            imageRefs={imageRefs}
            isExtracting={isExtracting}
            previewScrollRef={previewScrollRef}
            onSelectionSnapshotChange={onSelectionSnapshotChange}
            onAddClick={onSelectionAddClick}
            onClearSelection={onClearSelection}
          />

          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <button
              type="button"
              className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-full shadow-xl text-sm font-medium hover:scale-105 transition-transform disabled:opacity-60"
              onClick={onUploadClick}
              disabled={isUploading}
            >
              <span className="material-symbols-outlined text-[18px]">upload_file</span>
              {isUploading ? '上传中...' : '上传新素材'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,.doc,.docx"
              className="hidden"
              onChange={onFileChange}
            />
          </div>
        </>
      )}

      {!isPreviewCollapsed && appView === 'favorites' && (
        <div className="flex-1 overflow-hidden">
          <FavoritesPage
            backendBaseUrl={backendBaseUrl}
            user={user}
            onToast={onToast}
            onBack={() => onAppViewChange('editor')}
            onAddToEditor={onAddFavoriteToEditor}
          />
        </div>
      )}

      {isPreviewCollapsed && (
        <div className="flex flex-col items-center gap-4 py-4 w-full text-slate-500">
          <button
            type="button"
            className="w-10 h-10 flex items-center justify-center rounded-md border border-slate-200 hover:bg-slate-100"
            onClick={expandPreview}
            title="展开"
          >
            <span className="material-symbols-outlined text-[20px]">menu</span>
          </button>
          <div className="flex flex-col items-center gap-4 w-full">
            <span className="material-symbols-outlined text-[22px]">grid_view</span>
            <button
              type="button"
              className="w-10 h-10 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
              onClick={() => onAppViewChange('favorites')}
              title="我的收藏"
            >
              <span
                className="material-symbols-outlined text-[22px]"
                style={{ fontVariationSettings: appView === 'favorites' ? "'FILL' 1" : "'FILL' 0" }}
              >
                bookmark
              </span>
            </button>
            <div className="h-px w-8 bg-slate-200" />
            <span className="material-symbols-outlined text-[22px]">folder</span>
          </div>
          <div className="flex-1" />
          <span className="material-symbols-outlined text-[22px] mb-2">download</span>
        </div>
      )}
    </aside>
  )
}
