import { useState, useRef, useEffect, useCallback } from 'react'
import type { UploadedFileTab, SessionStatus, UserInfo } from '../types'
import { useAppStore } from '../store/appStore'

interface UseFileUploadReturn {
  fileTabs: UploadedFileTab[]
  setFileTabs: (tabs: UploadedFileTab[] | ((prev: UploadedFileTab[]) => UploadedFileTab[])) => void
  activeTabIndex: number
  setActiveTabIndex: (index: number) => void
  isUploading: boolean
  setIsUploading: (loading: boolean) => void
  fileInputRef: React.RefObject<HTMLInputElement>
  previewScrollRef: React.RefObject<HTMLDivElement>
  previewScrollPositions: Record<number, number>
  setPreviewScrollPositions: (positions: Record<number, number> | ((prev: Record<number, number>) => Record<number, number>)) => void
  activeFile: UploadedFileTab | null
  currentFile: UploadedFileTab | null
  fileName: string
  previewType: UploadedFileTab['previewType']
  previewPages: string[]
  previewUrl: string | null
  sessionId: number | null
  activeStatus: UploadedFileTab['status']
  previewSources: string[]
  handleUploadClick: () => void
  handleAddEmptyTab: () => void
  handleTabSelect: (index: number) => void
  handleCloseTab: (index: number) => void
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>
  rememberPreviewScroll: () => void
}

const deriveTabStatus = (pageStatuses?: UploadedFileTab['status'][]): UploadedFileTab['status'] => {
  if (!pageStatuses || pageStatuses.length === 0) return 'pending'
  if (pageStatuses.includes('failed')) return 'failed'
  if (pageStatuses.includes('processing') || pageStatuses.includes('pending')) return 'processing'
  return 'ready'
}

export const useFileUpload = (
  backendBaseUrl: string,
  user: UserInfo | null,
  onStatusMessage: (msg: string) => void,
): UseFileUploadReturn => {
  const storeFileTabs = useAppStore((state) => state.fileTabs)
  const setStoreFileTabs = useAppStore((state) => state.setFileTabs)
  const storeActiveTabIndex = useAppStore((state) => state.activeTabIndex)
  const setStoreActiveTabIndex = useAppStore((state) => state.setActiveTabIndex)
  const storePreviewScrollPositions = useAppStore((state) => state.previewScrollPositions)
  const setStorePreviewScrollPositions = useAppStore((state) => state.setPreviewScrollPositions)

  const [isUploading, setIsUploading] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const fileTabsRef = useRef<UploadedFileTab[]>([])

  // 把最新的 fileTabs 写入 ref，供轮询闭包使用
  useEffect(() => {
    fileTabsRef.current = [...storeFileTabs]
  }, [storeFileTabs])

  // 轮询后端会话状态，直到预览就绪
  useEffect(() => {
    const interval = window.setInterval(async () => {
      const pendingTabs = fileTabsRef.current.filter((t) => {
        if (t.isPlaceholder) return false
        if (t.previewType === 'image' && t.pageSessionIds?.length) {
          const pageStatuses = t.pageStatuses ?? []
          return pageStatuses.some((s) => s === 'pending' || s === 'processing')
        }
        return t.status === 'pending' || t.status === 'processing'
      })
      if (pendingTabs.length === 0) return

      try {
        const updates: UploadedFileTab[] = []
        for (const tab of pendingTabs) {
          // 对图片类型，逐页 session 轮询
          if (tab.previewType === 'image' && tab.pageSessionIds?.length) {
            const pageStatuses = tab.pageStatuses ?? Array(tab.pageSessionIds.length).fill('pending')
            const nextPreviewPages = [...tab.previewPages]
            const nextPageStatuses = [...pageStatuses]
            const normalizeUrl = (url: string) =>
              url.startsWith('http') ? url : `${backendBaseUrl}${url}`

            for (let i = 0; i < tab.pageSessionIds.length; i += 1) {
              const pageSessionId = tab.pageSessionIds[i]
              const status = nextPageStatuses[i] ?? 'pending'
              if (status !== 'pending' && status !== 'processing') continue
              const resp = await fetch(`${backendBaseUrl}/api/files/session/${pageSessionId}`)
              if (!resp.ok) continue
              const data = (await resp.json()) as SessionStatus
              let pageStatus: UploadedFileTab['status'] = status
              if (data.status === 'done') pageStatus = 'ready'
              else if (data.status === 'failed') pageStatus = 'failed'
              else if (data.status === 'processing') pageStatus = 'processing'

              nextPageStatuses[i] = pageStatus
              const pages = (data.preview_pages ?? []).map(normalizeUrl)
              const firstPreviewUrl =
                pages[0] ?? (data.preview_url ? normalizeUrl(data.preview_url) : null)
              if (firstPreviewUrl) {
                nextPreviewPages[i] = firstPreviewUrl
              }
            }

            const tabStatus = deriveTabStatus(nextPageStatuses)
            updates.push({
              ...tab,
              status: tabStatus,
              previewPages: nextPreviewPages,
              pageStatuses: nextPageStatuses,
            })
          } else {
            // 其他类型按原有单 session 轮询
            const resp = await fetch(
              `${backendBaseUrl}/api/files/session/${tab.sessionId}`,
            )
            if (!resp.ok) continue
            const data = (await resp.json()) as SessionStatus
            let nextStatus: UploadedFileTab['status'] = tab.status
            if (data.status === 'done') nextStatus = 'ready'
            else if (data.status === 'failed') nextStatus = 'failed'
            else if (data.status === 'processing') nextStatus = 'processing'

            if (nextStatus === tab.status && !data.preview_pages?.length) continue

            const normalizeUrl = (url: string) =>
              url.startsWith('http') ? url : `${backendBaseUrl}${url}`
            const pages = (data.preview_pages ?? []).map(normalizeUrl)
            const firstPreviewUrl =
              pages[0] ?? (data.preview_url ? normalizeUrl(data.preview_url) : null)

            updates.push({
              ...tab,
              status: nextStatus,
              previewUrl: firstPreviewUrl,
              previewPages: pages,
            })
          }
        }

        if (updates.length > 0) {
          const updateMap = new Map(
            updates.map((tab) => [`${tab.fileId}-${tab.sessionId}`, tab]),
          )
          setStoreFileTabs((prev) =>
            prev.map((tab) => {
              const key = `${tab.fileId}-${tab.sessionId}`
              return updateMap.get(key) ?? tab
            }),
          )
        }
      } catch (err) {
        console.error('[session poll] failed', err)
      }
    }, 2000)

    return () => window.clearInterval(interval)
  }, [backendBaseUrl])

  const activeFile = storeActiveTabIndex >= 0 ? storeFileTabs[storeActiveTabIndex] ?? null : null
  const currentFile = activeFile?.isPlaceholder ? null : activeFile
  const fileName = currentFile?.name ?? '未选择文件'
  const previewType = currentFile?.previewType ?? null
  const previewPages = currentFile?.previewPages ?? []
  const previewUrl = currentFile?.previewUrl ?? null
  const sessionId = currentFile?.sessionId ?? null
  const activeStatus = currentFile?.status ?? 'pending'
  const previewSources = previewPages.length > 0 ? previewPages : previewUrl ? [previewUrl] : []

  const rememberPreviewScroll = useCallback(() => {
    if (!sessionId) return
    const container = previewScrollRef.current
    if (!container) return
    const currentTop = container.scrollTop
    setStorePreviewScrollPositions((prev) => {
      if (prev[sessionId] === currentTop) return prev
      return {
        ...prev,
        [sessionId]: currentTop,
      }
    })
  }, [sessionId, setStorePreviewScrollPositions])

  const handleUploadClick = useCallback(() => {
    rememberPreviewScroll()
    fileInputRef.current?.click()
  }, [rememberPreviewScroll])

  const handleAddEmptyTab = useCallback(() => {
    const placeholderId = -Date.now()
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
    onStatusMessage('请在该标签中上传文件')
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
        ...(typeof removed.sessionId === 'number' ? [removed.sessionId] : []),
        ...(Array.isArray(removed.pageSessionIds)
          ? removed.pageSessionIds.filter((id): id is number => typeof id === 'number')
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

      setStoreActiveTabIndex((current) => {
        if (current === index) {
          return next.length ? Math.min(index, next.length - 1) : -1
        }
        if (current > index) {
          return current - 1
        }
        return current
      })

      return next
    })
  }, [setStoreFileTabs, setStoreActiveTabIndex, setStorePreviewScrollPositions])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      if (!user) {
        onStatusMessage('请先登录后再上传文件')
        return
      }

      setIsUploading(true)
      onStatusMessage('正在上传...')

      console.log('[upload] start', {
        name: file.name,
        size: file.size,
        type: file.type,
        tenant: user.tenant_id,
        user: user.id,
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
        onStatusMessage('当前只支持图片、PDF 或 Word 预览')
      }

      const formData = new FormData()
      formData.append('tenant_id', String(user.tenant_id))
      formData.append('user_id', String(user.id))
      formData.append('file', file)

      try {
        console.log('[upload] sending fetch to', `${backendBaseUrl}/api/files/upload-image`)
        const resp = await fetch(`${backendBaseUrl}/api/files/upload-image`, {
          method: 'POST',
          body: formData,
        })
        if (!resp.ok) throw new Error(await resp.text())
        const data = (await resp.json()) as {
          file_id: number
          session_id: number
          preview_url?: string | null
          preview_pages?: string[]
        }

        const normalizeUrl = (url: string | null | undefined) =>
          url ? (url.startsWith('http') ? url : `${backendBaseUrl}${url}`) : null

        const targetIsPlaceholder =
          activeFile?.isPlaceholder === true && storeActiveTabIndex >= 0
        const canAppendImage =
          previewType === 'image' &&
          activeFile &&
          !activeFile.isPlaceholder &&
          activeFile.previewType === 'image'

        // 图片追加：如果当前 tab 是图片且已存在内容，则追加为新页
        if (canAppendImage && storeActiveTabIndex >= 0) {
          const newPreview =
            normalizeUrl(data.preview_url) ?? normalizeUrl(data.preview_pages?.[0]) ?? null
          setStoreFileTabs((prev) =>
            prev.map((tab, idx) => {
              if (idx !== storeActiveTabIndex) return tab
              return {
                ...tab,
                previewPages: [...tab.previewPages, ...(newPreview ? [newPreview] : [])],
                pageSessionIds: [...(tab.pageSessionIds ?? []), data.session_id],
                pageFileIds: [...(tab.pageFileIds ?? []), data.file_id],
                pageStatuses: [...(tab.pageStatuses ?? []), 'pending'],
                status: 'processing',
              }
            }),
          )
          onStatusMessage('新图片已追加，正在生成预览...')
        } else {
          // 新建或占位符替换（图片/PDF/Word）
          const pages = (data.preview_pages ?? []).map(normalizeUrl).filter(Boolean) as string[]
          const preview = normalizeUrl(data.preview_url) ?? pages[0] ?? null
          const newTab: UploadedFileTab = {
            sessionId: data.session_id,
            fileId: data.file_id,
            name: file.name,
            previewType,
            previewUrl: preview,
            previewPages: preview ? [preview] : [],
            pageSessionIds: previewType === 'image' ? [data.session_id] : undefined,
            pageFileIds: previewType === 'image' ? [data.file_id] : undefined,
            pageStatuses: previewType === 'image' ? ['pending'] : undefined,
            status: 'processing',
            isPlaceholder: false,
          }

          if (targetIsPlaceholder) {
            setStoreFileTabs((prev) =>
              prev.map((tab, idx) => {
                if (idx !== storeActiveTabIndex) return tab
                return newTab
              })
            )
            setStoreActiveTabIndex(storeActiveTabIndex)
            onStatusMessage('上传完成，正在生成预览...')
          } else {
            const nextIndex = storeFileTabs.length
            setStoreFileTabs((prev) => [...prev, newTab])
            setStoreActiveTabIndex(nextIndex)
            onStatusMessage('上传完成，正在生成预览...')
          }
        }

        console.log('[upload] success session', data.session_id)
      } catch (err) {
        console.error('[upload] failed', err)
        onStatusMessage('上传失败，请稍后重试')
      } finally {
        setIsUploading(false)
      }
    },
    [activeFile, storeActiveTabIndex, backendBaseUrl, storeFileTabs.length, onStatusMessage, user, setStoreFileTabs, setStoreActiveTabIndex],
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
