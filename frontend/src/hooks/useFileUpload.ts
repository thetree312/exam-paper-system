import { useState, useRef, useEffect, useCallback } from 'react'
import type { DocumentPreviewAssetRef, UploadedFileTab, StatusMessageSetter, UserInfo } from '../types'
import { useAppStore } from '../store/appStore'
import { apiFetch } from '../lib/api'
import { createDocumentPreviewAssetRefs } from '../services/documentPreviewAsset'

interface UseFileUploadReturn {
  fileTabs: UploadedFileTab[]
  setFileTabs: (tabs: UploadedFileTab[] | ((prev: UploadedFileTab[]) => UploadedFileTab[])) => void
  activeTabIndex: number
  setActiveTabIndex: (index: number) => void
  isUploading: boolean
  setIsUploading: (loading: boolean) => void
  fileInputRef: React.RefObject<HTMLInputElement>
  previewScrollRef: React.RefObject<HTMLDivElement>
  previewScrollPositions: Record<string, number>
  setPreviewScrollPositions: (positions: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => void
  activeFile: UploadedFileTab | null
  currentFile: UploadedFileTab | null
  fileName: string
  previewType: UploadedFileTab['previewType']
  previewPages: DocumentPreviewAssetRef[]
  previewUrl: DocumentPreviewAssetRef | null
  sessionId: string | number | null
  activeStatus: UploadedFileTab['status']
  previewSources: DocumentPreviewAssetRef[]
  handleUploadClick: () => void
  handleAddEmptyTab: () => void
  handleTabSelect: (index: number) => void
  handleCloseTab: (index: number) => void
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  rememberPreviewScroll: () => void
}

export const useFileUpload = (
  backendBaseUrl: string,
  user: UserInfo | null,
  onStatusMessage: StatusMessageSetter,
): UseFileUploadReturn => {
  const storeFileTabs = useAppStore((state) => state.fileTabs)
  const setStoreFileTabs = useAppStore((state) => state.setFileTabs)
  const storeActiveTabIndex = useAppStore((state) => state.activeTabIndex)
  const setStoreActiveTabIndex = useAppStore((state) => state.setActiveTabIndex)
  const storePreviewScrollPositions = useAppStore((state) => state.previewScrollPositions)
  const setStorePreviewScrollPositions = useAppStore((state) => state.setPreviewScrollPositions)
  const workroom = useAppStore((state) => state.workroom)

  const [isUploading, setIsUploading] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const fileTabsRef = useRef<UploadedFileTab[]>([])

  // 保留 ref 仅用于读取最新 tabs，上传链路已经切到同步完成的 /api/documents/upload，
  // 不再轮询旧 /api/files/session/*。
  useEffect(() => {
    fileTabsRef.current = [...storeFileTabs]
  }, [storeFileTabs])

  const activeFile = storeActiveTabIndex >= 0 ? storeFileTabs[storeActiveTabIndex] ?? null : null
  const currentFile = activeFile?.isPlaceholder ? null : activeFile
  const fileName = currentFile?.name ?? '未选择文件'
  const previewType = currentFile?.previewType ?? null
  const previewPages = currentFile?.previewPages ?? []
  const previewUrl = currentFile?.previewUrl ?? null
  const sessionId = currentFile?.sessionId ?? null
  const activeStatus = currentFile?.status ?? 'pending'
  const previewSources = previewPages.length > 0 ? previewPages : previewUrl ? [previewUrl] : []

  useEffect(() => {
    if (sessionId == null) return
    const container = previewScrollRef.current
    if (!container) return
    const key = String(sessionId)
    const targetTop = storePreviewScrollPositions[key] ?? 0
    const rafId = window.requestAnimationFrame(() => {
      if (previewScrollRef.current) {
        previewScrollRef.current.scrollTop = targetTop
      }
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [sessionId, storePreviewScrollPositions])

  const rememberPreviewScroll = useCallback(() => {
    if (!sessionId) return
    const container = previewScrollRef.current
    if (!container) return
    const currentTop = container.scrollTop
    const key = String(sessionId)
    setStorePreviewScrollPositions((prev) => {
      if (prev[key] === currentTop) return prev
      return {
        ...prev,
        [key]: currentTop,
      }
    })
  }, [sessionId, setStorePreviewScrollPositions])

  const handleUploadClick = useCallback(() => {
    rememberPreviewScroll()
    fileInputRef.current?.click()
  }, [rememberPreviewScroll])

  const handleAddEmptyTab = useCallback(() => {
    const placeholderId = `placeholder_${Date.now()}`
    const newTab: UploadedFileTab = {
      sessionId: placeholderId,
      fileId: placeholderId,
      name: '新建标签',
      previewType: null,
      previewUrl: null,
      previewPages: [],
      status: 'pending',
      isPlaceholder: true,
    }
    setStoreFileTabs((prev) => [...prev, newTab])
    setStoreActiveTabIndex(storeFileTabs.length)
    onStatusMessage('tab_placeholder')
  }, [storeFileTabs.length, onStatusMessage, setStoreFileTabs, setStoreActiveTabIndex])

  const handleTabSelect = useCallback(
    (index: number) => {
      rememberPreviewScroll()
      setStoreActiveTabIndex(index)
    },
    [rememberPreviewScroll, setStoreActiveTabIndex],
  )

  const handleCloseTab = useCallback((index: number) => {
    setStoreFileTabs((prev) => {
      if (index < 0 || index >= prev.length) return prev
      const removed = prev[index]
      const next = prev.filter((_, idx) => idx !== index)

      const relatedSessionIds = [
        ...(removed.sessionId != null ? [String(removed.sessionId)] : []),
        ...(Array.isArray(removed.pageSessionIds)
          ? removed.pageSessionIds.map((id) => String(id))
          : []),
      ]

      if (relatedSessionIds.length) {
        setStorePreviewScrollPositions((positions) => {
          const updated = { ...positions }
          relatedSessionIds.forEach((id) => {
            delete updated[id]
          })
          return updated
        })
      }

      const nextActiveIndex =
        storeActiveTabIndex === index
          ? next.length
            ? Math.min(index, next.length - 1)
            : -1
          : storeActiveTabIndex > index
            ? storeActiveTabIndex - 1
            : storeActiveTabIndex
      setStoreActiveTabIndex(nextActiveIndex)

      return next
    })
  }, [setStoreFileTabs, setStoreActiveTabIndex, setStorePreviewScrollPositions, storeActiveTabIndex])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const inputEl = e.target
      const file = inputEl.files?.[0]
      if (!file) return

      if (!user) {
        onStatusMessage('login_required')
        return
      }

      setIsUploading(true)
      onStatusMessage('uploading')

      console.log('[upload] start', {
        name: file.name,
        size: file.size,
        type: file.type,
        user: user.id,
        workroom: workroom?.id ?? null,
      })

      let previewType: UploadedFileTab['previewType'] = null
      if (file.type.startsWith('image/')) {
        previewType = 'image'
      } else if (file.type === 'application/pdf') {
        previewType = 'pdf'
      } else if (
        file.type === 'application/msword' ||
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        previewType = 'word'
      } else {
        onStatusMessage('unsupported_file')
      }

      const formData = new FormData()
      if (!workroom?.id) {
        onStatusMessage('upload_failed')
        setIsUploading(false)
        if (inputEl) inputEl.value = ''
        return
      }
      formData.append('workroomID', String(workroom.id))
      formData.append('file', file)

      try {
        console.log('[upload] sending fetch to', `${backendBaseUrl}/api/documents/upload`)
        const resp = await apiFetch(`${backendBaseUrl}/api/documents/upload`, {
          method: 'POST',
          body: formData,
        })
        const data = (await resp.json()) as {
          id: string
          name: string
          mimeType: string
          previewPages: Array<{
            pageNumber: number
          }>
        }

        const targetIsPlaceholder =
          activeFile?.isPlaceholder === true && storeActiveTabIndex >= 0
        const pageCount = Math.max(1, Number(data.previewPages?.length ?? 1))
        const previewPages = createDocumentPreviewAssetRefs({
          documentId: data.id,
          workroomId: workroom.id,
          pageCount,
        })
        const newTab: UploadedFileTab = {
          sessionId: data.id,
          fileId: data.id,
          name: data.name ?? file.name,
          previewType,
          previewUrl: previewPages[0] ?? null,
          previewPages,
          pageSessionIds: previewType === 'image' ? [data.id] : undefined,
          pageFileIds: previewType === 'image' ? [data.id] : undefined,
          pageStatuses: previewType === 'image' ? ['ready'] : undefined,
          status: 'ready',
          isPlaceholder: false,
        }

        if (targetIsPlaceholder) {
          setStoreFileTabs((prev) =>
            prev.map((tab, idx) => {
              if (idx !== storeActiveTabIndex) return tab
              return newTab
            }),
          )
          setStoreActiveTabIndex(storeActiveTabIndex)
        } else {
          const nextIndex = storeFileTabs.length
          setStoreFileTabs((prev) => [...prev, newTab])
          setStoreActiveTabIndex(nextIndex)
        }

        onStatusMessage('preview_generating')
        console.log('[upload] success document', data.id)
      } catch (err) {
        console.error('[upload] failed', err)
        onStatusMessage('upload_failed')
      } finally {
        setIsUploading(false)
        if (inputEl) {
          inputEl.value = ''
        }
      }
    },
    [activeFile, storeActiveTabIndex, backendBaseUrl, storeFileTabs.length, onStatusMessage, user, workroom?.id, setStoreFileTabs, setStoreActiveTabIndex],
  )

  return {
    fileTabs: storeFileTabs,
    setFileTabs: setStoreFileTabs,
    activeTabIndex: storeActiveTabIndex,
    setActiveTabIndex: setStoreActiveTabIndex,
    isUploading,
    setIsUploading,
    fileInputRef: fileInputRef as React.RefObject<HTMLInputElement>,
    previewScrollRef: previewScrollRef as React.RefObject<HTMLDivElement>,
    previewScrollPositions: storePreviewScrollPositions,
    setPreviewScrollPositions: setStorePreviewScrollPositions,
    activeFile,
    currentFile,
    fileName,
    previewType,
    previewPages,
    previewUrl,
    sessionId,
    activeStatus,
    previewSources,
    handleUploadClick,
    handleAddEmptyTab,
    handleTabSelect,
    handleCloseTab,
    handleFileChange,
    rememberPreviewScroll,
  }
}
