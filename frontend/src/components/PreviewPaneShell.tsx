import React from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentCitationFocus, DocumentPreviewAssetRef, UploadedFileTab, UserInfo } from '../types'
import { FileTabsBar } from './FileTabsBar'
import { SelectionPane } from './SelectionPane'
import { WorkroomWikiTree } from './WorkroomWikiTree'
import Icon from './Icon'
import { useAppStore } from '../store/appStore'


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
  previewSources: DocumentPreviewAssetRef[]
  previewType: UploadedFileTab['previewType']
  activeStatus: UploadedFileTab['status']
  hasActiveFile: boolean
  activeFileId?: string | number | null
  pageRefs: React.MutableRefObject<Record<number, HTMLDivElement | null>>
  imageRefs: React.MutableRefObject<Record<number, HTMLImageElement | null>>
  isExtracting: boolean
  previewScrollRef: React.RefObject<HTMLDivElement>
  citationFocus?: AgentCitationFocus | null
  onSelectionSnapshotChange: (snapshot: any) => void
  onSelectionAddClick: () => void
  onClearSelection: () => void
  backendBaseUrl: string
  user: UserInfo
  isUserMenuOpen: boolean
  userMenuRef: React.RefObject<HTMLDivElement>
  onToggleUserMenu: () => void
  onOpenAiModelSettings: () => void
  onLogout: () => void
  onBackToWorkspace?: () => void
  onOpenWorkroomFile?: (path: string) => void
  onRequestSaveOpenFile?: (path: string) => Promise<void>
  onToast?: (message: string, type: 'info' | 'success' | 'error') => void
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
  activeFileId,
  pageRefs,
  imageRefs,
  isExtracting,
  previewScrollRef,
  citationFocus,
  onSelectionSnapshotChange,
  onSelectionAddClick,
  onClearSelection,
  backendBaseUrl,
  user,
  isUserMenuOpen,
  userMenuRef,
  onToggleUserMenu,
  onOpenAiModelSettings,
  onLogout,
  onBackToWorkspace,
  onOpenWorkroomFile,
  onRequestSaveOpenFile,
  onToast,
}) => {
  const { t } = useTranslation()
  const [isWikiTreeOpen, setIsWikiTreeOpen] = React.useState(false)
  const workroomTreeRevealRequest = useAppStore((state) => state.workroomTreeRevealRequest)

  React.useEffect(() => {
    if (!workroomTreeRevealRequest?.id) return
    onAppViewChange('editor')
    expandPreview()
    setIsWikiTreeOpen(true)
  }, [expandPreview, onAppViewChange, workroomTreeRevealRequest?.id])

  const renderPreviewRail = () => (
    <div className="flex w-11 shrink-0 flex-col items-center gap-2 py-2 text-slate-500">
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 hover:bg-slate-100"
        onClick={() => {
          if (isPreviewCollapsed) {
            setIsWikiTreeOpen(false)
            expandPreview()
          } else {
            collapsePreview()
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
            onAppViewChange('editor')
            expandPreview()
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
            onAppViewChange('favorites')
            collapsePreview()
          }}
          title={t('source_panel.collapsed.favorites')}
        >
          <Icon name={"bookmark"} className="text-[18px]" style={{ fontVariationSettings: appView === 'favorites' ? "'FILL' 1" : "'FILL' 0" }} />
        </button>
        <div className="h-px w-6 bg-slate-200" />
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
          onClick={onBackToWorkspace}
          title={t('source_panel.collapsed.workspace')}
        >
          <Icon name={"home_app_logo"} className="text-[18px]" />
        </button>
      </div>
      <div className="flex-1" />
      <button
        type="button"
        className="mb-1 flex h-8 w-8 items-center justify-center rounded-md hover:bg-slate-100 transition-colors"
        onClick={onOpenAiModelSettings}
        title={t('app.buttons.ai_model_settings')}
      >
        <Icon name={"settings"} className="text-[18px]" />
      </button>
      <div className="relative" ref={userMenuRef}>
        <button
          type="button"
          className="mb-1 flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-[11px] font-semibold text-white hover:bg-slate-800 transition-colors"
          onClick={onToggleUserMenu}
          title={user.display_name}
        >
          {(user.display_name || user.email || 'U').trim().charAt(0).toUpperCase()}
        </button>
        {isUserMenuOpen && (
          <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-56 rounded-2xl border border-slate-100 bg-white p-3 shadow-xl">
            <div className="mb-2">
              <p className="truncate text-sm font-semibold text-slate-900">{user.display_name}</p>
              <p className="truncate text-xs text-slate-500">{user.email}</p>
            </div>
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={onLogout}
            >
              <Icon name={"logout"} className="text-[16px]" />
              {t('app.buttons.logout')}
            </button>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <aside
      className="bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex relative"
      ref={leftPaneRef}
      style={style}
    >
      {!isMobileOrTablet && renderPreviewRail()}

      {!isPreviewCollapsed && appView === 'editor' && (
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className={`${isWikiTreeOpen ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
              <FileTabsBar
                fileTabs={fileTabs}
                activeTabIndex={activeTabIndex}
                onTabSelect={onTabSelect}
                onAddTab={onAddEmptyTab}
                onCloseTab={onCloseTab}
                isUploading={isUploading}
                onToggleFileTree={!isMobileOrTablet ? () => setIsWikiTreeOpen(true) : undefined}
                isFileTreeOpen={isWikiTreeOpen}
              />

              <SelectionPane
                backendBaseUrl={backendBaseUrl}
                previewSources={previewSources}
                previewType={previewType}
                activeStatus={activeStatus}
                hasActiveFile={hasActiveFile}
                activeFileId={activeFileId}
                pageRefs={pageRefs}
                imageRefs={imageRefs}
                isExtracting={isExtracting}
                previewScrollRef={previewScrollRef}
                citationFocus={citationFocus}
                onSelectionSnapshotChange={onSelectionSnapshotChange}
                onAddClick={onSelectionAddClick}
                onClearSelection={onClearSelection}
              />
          </div>
          {isWikiTreeOpen && (
            <div className="flex min-h-0 flex-1">
              <WorkroomWikiTree
                backendBaseUrl={backendBaseUrl}
                onTogglePreview={() => setIsWikiTreeOpen(false)}
                onFileOpen={onOpenWorkroomFile}
                onRequestSaveOpenFile={onRequestSaveOpenFile}
                onOpenToSide={onOpenWorkroomFile}
                onToast={onToast}
              />
            </div>
          )}

          {!isWikiTreeOpen && <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
            <button
              type="button"
              className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-full shadow-xl text-sm font-medium hover:scale-105 transition-transform disabled:opacity-60"
              onClick={onUploadClick}
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
              onChange={onFileChange}
            />
          </div>}
        </div>
      )}

      {isMobileOrTablet && isPreviewCollapsed && renderPreviewRail()}
    </aside>
  )
}
