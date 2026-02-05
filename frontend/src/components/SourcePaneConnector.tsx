import React, { useRef } from 'react'
import { FileTabsBar } from './FileTabsBar'
import { SelectionPane } from './SelectionPane'
import { FavoritesPage } from './FavoritesPage'
import { useAppStore } from '../store/appStore'
import { useFileUpload, useOcrManager } from '../hooks'

interface SourcePaneConnectorProps {
  backendBaseUrl: string
  onStatusMessage: (msg: string) => void
  onToast: (message: string, type: 'info' | 'success' | 'error') => void
}

export const SourcePaneConnector: React.FC<SourcePaneConnectorProps> = ({
  backendBaseUrl,
  onStatusMessage,
  onToast,
}) => {
  const user = useAppStore((state) => state.user)
  const isPreviewCollapsed = useAppStore((state) => state.isPreviewCollapsed)
  const setIsPreviewCollapsed = useAppStore((state) => state.setIsPreviewCollapsed)
  const appView = useAppStore((state) => state.appView)
  const setAppView = useAppStore((state) => state.setAppView)
  const viewportWidth = useAppStore((state) => state.viewportWidth)

  const {
    fileTabs,
    activeTabIndex,
    isUploading,
    fileInputRef,
    previewScrollRef,
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
  } = useFileUpload(backendBaseUrl, user, onStatusMessage)

  const {
    selectionSnapshotRef,
    handleSelectionSnapshotChange,
    handleAddToEditor,
  } = useOcrManager(backendBaseUrl, onStatusMessage, onToast, agentDocumentId)

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({})

  const isMobileOrTablet = viewportWidth < 1024

  return (
    <aside
      className="bg-white dark:bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 flex flex-col relative"
      style={
        isMobileOrTablet
          ? { width: '100%', minWidth: 0 }
          : isPreviewCollapsed
            ? { width: 64, minWidth: 64 }
            : { width: 420, minWidth: 320 }
      }
    >
      {!isPreviewCollapsed && (
        <>
          <FileTabsBar
            fileTabs={fileTabs}
            activeTabIndex={activeTabIndex}
            onTabSelect={handleTabSelect}
            onAddTab={handleAddEmptyTab}
            onCloseTab={handleCloseTab}
            isUploading={isUploading}
            onCollapse={!isMobileOrTablet ? () => setIsPreviewCollapsed(true) : undefined}
          />

          <SelectionPane
            previewSources={previewSources}
            previewType={previewType}
            activeStatus={activeStatus}
            hasActiveFile={!!currentFile}
            pageRefs={pageRefs}
            imageRefs={imageRefs}
            isExtracting={false}
            previewScrollRef={previewScrollRef as React.RefObject<HTMLDivElement>}
            onSelectionSnapshotChange={handleSelectionSnapshotChange}
            onAddClick={() => handleAddToEditor(sessionId, currentFile, selectionSnapshotRef.current)}
            onClearSelection={() => {
              selectionSnapshotRef.current = null
            }}
          />

          <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <button
              type="button"
              className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-full shadow-xl text-sm font-medium hover:scale-105 transition-transform disabled:opacity-60"
              onClick={handleUploadClick}
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
              onChange={handleFileChange}
            />
          </div>
        </>
      )}

      {!isPreviewCollapsed && appView === 'favorites' && (
        <div className="flex-1 overflow-hidden">
          <FavoritesPage
            backendBaseUrl={backendBaseUrl}
            user={user!}
            onToast={onToast}
            onBack={() => setAppView('editor')}
            onAddToEditor={() => {}}
          />
        </div>
      )}

      {isPreviewCollapsed && (
        <div className="flex flex-col items-center gap-4 py-4 w-full text-slate-500">
          <button
            type="button"
            className="w-10 h-10 flex items-center justify-center rounded-md border border-slate-200 hover:bg-slate-100"
            onClick={() => {
              setIsPreviewCollapsed(false)
              setAppView('editor')
            }}
            title="展开"
          >
            <span className="material-symbols-outlined text-[20px]">menu</span>
          </button>
          <div className="flex flex-col items-center gap-4 w-full">
            <span className="material-symbols-outlined text-[22px]">grid_view</span>
            <button
              type="button"
              className="w-10 h-10 flex items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
              onClick={() => setAppView('favorites')}
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
