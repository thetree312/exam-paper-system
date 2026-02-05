import React, { useEffect, useRef } from 'react'
import { AppHeader } from './AppHeader'
import { SourcePaneConnector } from './SourcePaneConnector'
import { EditorConnector } from './EditorConnector'
import { AgentConnector } from './AgentConnector'
import { ExportTemplateDialog } from './ExportTemplateDialog'
import { useAppStore } from '../store/appStore'
import { useAuth } from '../hooks'

interface MainLayoutProps {
  backendBaseUrl: string
  statusMessage: string
  isUploading: boolean
  isExtracting: boolean
  onStatusMessage: (msg: string) => void
  onToast: (message: string, type: 'info' | 'success' | 'error') => void
  toastState: { id: number; message: string; type: 'info' | 'success' | 'error' } | null
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  backendBaseUrl,
  statusMessage,
  isUploading,
  isExtracting,
  onStatusMessage,
  onToast,
  toastState,
}) => {
  const user = useAppStore((state) => state.user)
  const isAgentDrawerOpen = useAppStore((state) => state.isAgentDrawerOpen)
  const agentDrawerWidth = useAppStore((state) => state.agentDrawerWidth)
  const isUserMenuOpen = useAppStore((state) => state.isUserMenuOpen)
  const setIsUserMenuOpen = useAppStore((state) => state.setIsUserMenuOpen)
  const isResizing = useAppStore((state) => state.isResizing)
  const setIsResizing = useAppStore((state) => state.setIsResizing)
  const leftWidth = useAppStore((state) => state.leftWidth)
  const setLeftWidth = useAppStore((state) => state.setLeftWidth)
  const isPreviewCollapsed = useAppStore((state) => state.isPreviewCollapsed)
  const appView = useAppStore((state) => state.appView)
  const isExportDialogOpen = useAppStore((state) => state.isExportDialogOpen)
  const setIsExportDialogOpen = useAppStore((state) => state.setIsExportDialogOpen)
  const viewportWidth = useAppStore((state) => state.viewportWidth)

  const { handleLogout } = useAuth(backendBaseUrl)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const leftPaneRef = useRef<HTMLElement>(null)
  const pendingLeftWidthRef = useRef<number | null>(null)

  const isMobileOrTablet = viewportWidth < 1024

  // 监听用户菜单外部点击
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        isUserMenuOpen &&
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setIsUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isUserMenuOpen, setIsUserMenuOpen])

  // 处理左侧面板拖拽
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizing) return
      const minWidth = 320
      const maxWidth = 700
      const newWidth = Math.min(maxWidth, Math.max(minWidth, event.clientX))
      pendingLeftWidthRef.current = newWidth
      const pane = leftPaneRef.current
      if (pane) {
        pane.style.width = `${newWidth}px`
        pane.style.minWidth = `${minWidth}px`
      }
    }

    const handleMouseUp = () => {
      if (!isResizing) return
      setIsResizing(false)
      if (pendingLeftWidthRef.current != null) {
        setLeftWidth(pendingLeftWidthRef.current)
      }
    }

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, setIsResizing, setLeftWidth])

  const handleLogoutClick = () => {
    handleLogout()
    setIsUserMenuOpen(false)
  }

  return (
    <div className="bg-background-light dark:bg-background-dark text-slate-900 font-display antialiased overflow-hidden h-screen flex flex-col">
      <AppHeader
        statusMessage={statusMessage}
        isUploading={isUploading}
        isExtracting={isExtracting}
        onExportClick={() => setIsExportDialogOpen(true)}
        user={user!}
        userMenuRef={userMenuRef as React.RefObject<HTMLDivElement>}
        isUserMenuOpen={isUserMenuOpen}
        onToggleUserMenu={() => setIsUserMenuOpen(!isUserMenuOpen)}
        onLogout={handleLogoutClick}
        rightOffset={!isMobileOrTablet && isAgentDrawerOpen ? agentDrawerWidth : 0}
      />

      <main
        className={`flex flex-1 ${isMobileOrTablet ? 'flex-col overflow-y-auto' : 'overflow-hidden'}`}
        style={
          isMobileOrTablet
            ? undefined
            : {
                paddingRight: isAgentDrawerOpen ? agentDrawerWidth : 0,
                transition: 'padding-right 200ms ease',
              }
        }
      >
        {/* 左侧：源文件或收藏页面 */}
        <div
          ref={leftPaneRef as React.RefObject<HTMLDivElement>}
          style={
            isMobileOrTablet
              ? { width: '100%', minWidth: 0 }
              : isPreviewCollapsed
                ? { width: 64, minWidth: 64 }
                : { width: leftWidth, minWidth: 320 }
          }
        >
          <SourcePaneConnector
            backendBaseUrl={backendBaseUrl}
            onStatusMessage={onStatusMessage}
            onToast={onToast}
          />
        </div>

        {/* 中间拖拽条 */}
        {!isMobileOrTablet && appView !== 'favorites' && (
          <div
            onMouseDown={() => setIsResizing(true)}
            className="w-1 cursor-col-resize bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
          />
        )}

        {/* 右侧：编辑区 */}
        <EditorConnector
          backendBaseUrl={backendBaseUrl}
          onStatusMessage={onStatusMessage}
          onToast={onToast}
        />
      </main>

      {/* Agent 面板 */}
      <AgentConnector backendBaseUrl={backendBaseUrl} />

      {/* 导出弹窗 */}
      <ExportTemplateDialog
        open={isExportDialogOpen}
        onClose={() => setIsExportDialogOpen(false)}
        backendBaseUrl={backendBaseUrl}
        ocrItems={[]}
        documentTitle={null}
        user={user}
        onStatusMessage={onStatusMessage}
      />

      {/* Toast 通知 */}
      {toastState && (
        <div
          key={toastState.id}
          className={`fixed right-6 bottom-6 z-50 min-w-[240px] rounded-xl px-4 py-3 shadow-lg text-sm text-white transition-all origin-bottom-right ${
            toastState.type === 'success'
              ? 'bg-emerald-600'
              : toastState.type === 'error'
                ? 'bg-rose-600'
                : 'bg-slate-800'
          }`}
        >
          {toastState.message}
        </div>
      )}
    </div>
  )
}
