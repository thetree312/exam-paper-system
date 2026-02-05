import { useCallback, useEffect, useMemo, useRef } from 'react'
import type React from 'react'
import { useAppStore } from '../store/appStore'

interface UsePreviewPaneReturn {
  leftPaneRef: React.MutableRefObject<HTMLElement | null>
  previewPaneStyle: React.CSSProperties
  isPreviewCollapsed: boolean
  appView: 'editor' | 'favorites'
  setAppView: (view: 'editor' | 'favorites') => void
  isMobileOrTablet: boolean
  collapsePreview: () => void
  expandPreview: () => void
  startResize: () => void
}

export const usePreviewPane = (): UsePreviewPaneReturn => {
  const isPreviewCollapsed = useAppStore((state) => state.isPreviewCollapsed)
  const setIsPreviewCollapsed = useAppStore((state) => state.setIsPreviewCollapsed)
  const appView = useAppStore((state) => state.appView)
  const setAppView = useAppStore((state) => state.setAppView)
  const leftWidth = useAppStore((state) => state.leftWidth)
  const setLeftWidth = useAppStore((state) => state.setLeftWidth)
  const isResizing = useAppStore((state) => state.isResizing)
  const setIsResizing = useAppStore((state) => state.setIsResizing)
  const viewportWidth = useAppStore((state) => state.viewportWidth)
  const setViewportWidth = useAppStore((state) => state.setViewportWidth)

  const leftPaneRef = useRef<HTMLElement | null>(null)
  const pendingLeftWidthRef = useRef<number | null>(null)

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [setViewportWidth])

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

  const isMobileOrTablet = viewportWidth < 1024

  const previewPaneStyle = useMemo<React.CSSProperties>(() => {
    if (isMobileOrTablet) {
      return { width: '100%', minWidth: 0 }
    }
    if (isPreviewCollapsed) {
      return { width: 64, minWidth: 64 }
    }
    return { width: leftWidth, minWidth: 320 }
  }, [isMobileOrTablet, isPreviewCollapsed, leftWidth])

  const collapsePreview = useCallback(() => {
    setIsPreviewCollapsed(true)
  }, [setIsPreviewCollapsed])

  const expandPreview = useCallback(() => {
    setIsPreviewCollapsed(false)
    setAppView('editor')
  }, [setAppView, setIsPreviewCollapsed])

  const startResize = useCallback(() => {
    if (isMobileOrTablet) return
    setIsResizing(true)
  }, [isMobileOrTablet, setIsResizing])

  return {
    leftPaneRef,
    previewPaneStyle,
    isPreviewCollapsed,
    appView,
    setAppView,
    isMobileOrTablet,
    collapsePreview,
    expandPreview,
    startResize,
  }
}
