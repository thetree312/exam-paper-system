import React, { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FileTabsBar } from './FileTabsBar'
import { SelectionPane } from './SelectionPane'
import { WorkroomWikiTree } from './WorkroomWikiTree'
import { useAppStore } from '../store/appStore'
import { useFileUpload, useOcrManager } from '../hooks'
import Icon from './Icon'


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
  const { t } = useTranslation('common')
  const [isWikiTreeOpen, setIsWikiTreeOpen] = React.useState(false)
  const user = useAppStore((state) => state.user)
  const isPreviewCollapsed = useAppStore((state) => state.isPreviewCollapsed)
  const setIsPreviewCollapsed = useAppStore((state) => state.setIsPreviewCollapsed)
  const appView = useAppStore((state) => state.appView)
  const setAppView = useAppStore((state) => state.setAppView)
  const viewportWidth = useAppStore((state) => state.viewportWidth)
  const studioDocumentId = useAppStore((state) => state.studioDocumentId)

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
  } = useOcrManager(backendBaseUrl, onStatusMessage, onToast, studioDocumentId)

  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const imageRefs = useRef<Record<number, HTMLImageElement | null>>({})

  const isMobileOrTablet = viewportWidth < 1024

  const renderPreviewRail = () => (
    <div className="flex w-11 shrink-0 flex-col items-center gap-2 py-2 text-slate-500">
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 hover:bg-slate-100"
        onClick={() => {
          setIsPreviewCollapsed(!isPreviewCollapsed)
          if (isPreviewCollapsed) {
            setAppView('editor')
            setIsWikiTreeOpen(false)
          }
        }}
        title={isPreviewCollapsed ? t('source_panel.collapsed.expand') : t('source_panel.collapsed.collapse')}
      >
        <Icon name={"menu"} className="text-[18px]" />
      </button>
      <div className="flex flex-col items-center gap-2">
        <Icon name={"grid_view"} className="text-[18px]" />
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
          onClick={() => {
            setAppView('editor')
            setIsPreviewCollapsed(false)
            setIsWikiTreeOpen(true)
          }}
          title={t('source_panel.collapsed.workroom_files')}
        >
          <Icon name={"alt_route"} className="text-[18px]" style={{ fontVariationSettings: isWikiTreeOpen ? "'FILL' 1" : "'FILL' 0" }} />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
          onClick={() => {
            setAppView('favorites')
            setIsPreviewCollapsed(true)
          }}
          title={t('source_panel.collapsed.favorites')}
        >
          <Icon name={"bookmark"} className="text-[18px]" style={{ fontVariationSettings: appView === 'favorites' ? "'FILL' 1" : "'FILL' 0" }} />
        </button>
        <div className="h-px w-6 bg-slate-200" />
        <Icon name={"home_app_logo"} className="text-[18px]" title={t('source_panel.collapsed.workspace')} />
      </div>
      <div className="flex-1" />
      <Icon name={"download"} className="mb-1 text-[18px]" />
    </div>
  )

  return (
    <aside
      className="bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex relative"
      style={
        isMobileOrTablet
          ? { width: '100%', minWidth: 0 }
          : isPreviewCollapsed
            ? { width: 44, minWidth: 44 }
            : { width: 420, minWidth: 320 }
      }
    >
      {!isMobileOrTablet && renderPreviewRail()}

      {!isPreviewCollapsed && appView === 'editor' && (
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className={`${isWikiTreeOpen ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
              <FileTabsBar
                fileTabs={fileTabs}
                activeTabIndex={activeTabIndex}
                onTabSelect={handleTabSelect}
                onAddTab={handleAddEmptyTab}
                onCloseTab={handleCloseTab}
                isUploading={isUploading}
                onToggleFileTree={!isMobileOrTablet ? () => setIsWikiTreeOpen(true) : undefined}
                isFileTreeOpen={isWikiTreeOpen}
              />

              <SelectionPane
                backendBaseUrl={backendBaseUrl}
                previewSources={previewSources}
                previewType={previewType}
                activeStatus={activeStatus}
                hasActiveFile={!!currentFile}
                activeFileId={currentFile?.fileId != null ? String(currentFile.fileId) : null}
                pageRefs={pageRefs}
                imageRefs={imageRefs}
                isExtracting={false}
                previewScrollRef={previewScrollRef as React.RefObject<HTMLDivElement>}
                citationFocus={null}
                onSelectionSnapshotChange={handleSelectionSnapshotChange}
                onAddClick={() =>
                  void handleAddToEditor(
                    sessionId != null ? String(sessionId) : null,
                    currentFile,
                    selectionSnapshotRef.current,
                  )
                }
                onClearSelection={() => {
                  selectionSnapshotRef.current = null
                }}
              />
          </div>
          <div className={`${isWikiTreeOpen ? 'flex' : 'hidden'} min-h-0 flex-1`}>
            <WorkroomWikiTree backendBaseUrl={backendBaseUrl} onTogglePreview={() => setIsWikiTreeOpen(false)} />
          </div>

          {!isWikiTreeOpen && <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <button
              type="button"
              className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-full shadow-xl text-sm font-medium hover:scale-105 transition-transform disabled:opacity-60"
              onClick={handleUploadClick}
              disabled={isUploading}
            >
              <Icon name={"upload_file"} className="text-[18px]" />
              {isUploading ? t('source_panel.upload.uploading') : t('source_panel.upload.idle')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,.doc,.docx"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>}
        </div>
      )}

      {isMobileOrTablet && isPreviewCollapsed && renderPreviewRail()}
    </aside>
  )
}
