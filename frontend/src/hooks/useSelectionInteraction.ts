import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PageSelectionSegment,
  SelectionBox,
  SelectionExclusion,
  SelectionLegend,
  RegionPayload,
  LegendRegionPayload,
} from '../types'

type Rect = { x: number; y: number; width: number; height: number }

interface UseSelectionInteractionArgs {
  previewScrollRef: React.RefObject<HTMLDivElement>
  pageRefs: React.MutableRefObject<Record<number, HTMLDivElement | null>>
  imageRefs: React.MutableRefObject<Record<number, HTMLImageElement | null>>
}

const MIN_SEGMENT_SIZE = 4

const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

const intersectRect = (a: Rect, b: Rect): Rect | null => {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

const subtractRect = (rect: PageSelectionSegment, hole: PageSelectionSegment) => {
  const overlap = intersectRect(rect, hole)
  if (!overlap) return [rect]

  const pieces: PageSelectionSegment[] = []
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  const overlapRight = overlap.x + overlap.width
  const overlapBottom = overlap.y + overlap.height

  if (overlap.y > rect.y) {
    pieces.push({
      page: rect.page,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: overlap.y - rect.y,
    })
  }

  if (overlapBottom < bottom) {
    pieces.push({
      page: rect.page,
      x: rect.x,
      y: overlapBottom,
      width: rect.width,
      height: bottom - overlapBottom,
    })
  }

  if (overlap.x > rect.x) {
    pieces.push({
      page: rect.page,
      x: rect.x,
      y: overlap.y,
      width: overlap.x - rect.x,
      height: overlap.height,
    })
  }

  if (overlapRight < right) {
    pieces.push({
      page: rect.page,
      x: overlapRight,
      y: overlap.y,
      width: right - overlapRight,
      height: overlap.height,
    })
  }

  return pieces.filter((piece) => piece.width > 0 && piece.height > 0)
}

const clamp01 = (val: number) => Math.min(1, Math.max(0, val))

export const useSelectionInteraction = ({
  previewScrollRef,
  pageRefs,
  imageRefs,
}: UseSelectionInteractionArgs) => {
  const [selection, setSelection] = useState<SelectionBox | null>(null)
  const [interactionMode, setInteractionMode] = useState<'main' | 'exclude' | 'legend'>('main')
  const [dragKind, setDragKind] = useState<'main' | 'exclude' | 'legend' | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [pendingExclusions, setPendingExclusions] = useState<PageSelectionSegment[]>([])
  const [pendingLegends, setPendingLegends] = useState<PageSelectionSegment[]>([])
  const lastRectRef = useRef<Rect | null>(null)
  const geometrySnapshotRef = useRef<
    | {
        containerRect: DOMRect
        scrollTop: number
        scrollLeft: number
        pages: Record<number, { pageRect: DOMRect; imgRect: DOMRect }>
      }
    | null
  >(null)
  const lastPointerEventRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const frameRequestedRef = useRef(false)
  const lastProcessedPointRef = useRef<{ x: number; y: number } | null>(null)
  const isDraggingRef = useRef(false)
  const needsSnapshotRefreshRef = useRef(false)

  const getPageMetrics = useCallback(
    (page: number) => {
      const pageEl = pageRefs.current[page]
      const imgEl = imageRefs.current[page]
      if (!pageEl || !imgEl) return null
      const containerRect = pageEl.getBoundingClientRect()
      const imageRect = imgEl.getBoundingClientRect()
      return { containerRect, imageRect, imgEl }
    },
    [imageRefs, pageRefs],
  )

  const clamp = useCallback((value: number, min: number, max: number) => {
    return Math.min(Math.max(value, min), max)
  }, [])

  const getContainerPoint = useCallback(
    (clientX: number, clientY: number) => {
      const container = previewScrollRef.current
      if (!container) return null
      const rect = container.getBoundingClientRect()
      const x = clientX - rect.left + container.scrollLeft
      const y = clientY - rect.top + container.scrollTop
      return {
        x: Math.max(0, x),
        y: Math.max(0, y),
      }
    },
    [previewScrollRef],
  )

  const captureGeometrySnapshot = useCallback(() => {
    const container = previewScrollRef.current
    if (!container) {
      geometrySnapshotRef.current = null
      return
    }
    const containerRect = container.getBoundingClientRect()
    const scrollTop = container.scrollTop
    const scrollLeft = container.scrollLeft
    const pageKeys = Object.keys(pageRefs.current)
      .map((key) => Number(key))
      .sort((a, b) => a - b)
    const pages: Record<number, { pageRect: DOMRect; imgRect: DOMRect }> = {}
    for (const page of pageKeys) {
      const pageEl = pageRefs.current[page]
      const imgEl = imageRefs.current[page]
      if (!pageEl || !imgEl) continue
      pages[page] = {
        pageRect: pageEl.getBoundingClientRect(),
        imgRect: imgEl.getBoundingClientRect(),
      }
    }
    geometrySnapshotRef.current = { containerRect, scrollTop, scrollLeft, pages }
  }, [pageRefs, imageRefs, previewScrollRef])

  const computeSegmentsForRect = useCallback(
    (rect: Rect): PageSelectionSegment[] => {
      const container = previewScrollRef.current
      if (!container) return []
      const snapshot = geometrySnapshotRef.current
      const containerRect = snapshot?.containerRect ?? container.getBoundingClientRect()
      const scrollTop = snapshot?.scrollTop ?? container.scrollTop
      const scrollLeft = snapshot?.scrollLeft ?? container.scrollLeft
      const segments: PageSelectionSegment[] = []
      const pageKeys = Object.keys(pageRefs.current)
        .map((key) => Number(key))
        .sort((a, b) => a - b)

      for (const page of pageKeys) {
        let pageRect: DOMRect | null = null
        let imgRect: DOMRect | null = null
        if (snapshot && snapshot.pages[page]) {
          pageRect = snapshot.pages[page].pageRect
          imgRect = snapshot.pages[page].imgRect
        } else {
          const pageEl = pageRefs.current[page]
          const imgEl = imageRefs.current[page]
          if (!pageEl || !imgEl) continue
          pageRect = pageEl.getBoundingClientRect()
          imgRect = imgEl.getBoundingClientRect()
        }
        if (!pageRect || !imgRect) continue
        const imgRelative = {
          x: imgRect.left - containerRect.left + scrollLeft,
          y: imgRect.top - containerRect.top + scrollTop,
          width: imgRect.width,
          height: imgRect.height,
        }
        const overlap = intersectRect(rect, imgRelative)
        if (!overlap) continue
        const pageRelative = {
          x: pageRect.left - containerRect.left + scrollLeft,
          y: pageRect.top - containerRect.top + scrollTop,
        }
        segments.push({
          page,
          x: overlap.x - pageRelative.x,
          y: overlap.y - pageRelative.y,
          width: overlap.width,
          height: overlap.height,
        })
      }
      return segments
    },
    [imageRefs, pageRefs, previewScrollRef],
  )

  const computeExclusionSegments = useCallback(
    (rect: Rect) => {
      if (!selection) return []
      const rawSegments = computeSegmentsForRect(rect)
      if (!rawSegments.length) return []
      const result: PageSelectionSegment[] = []

      for (const segment of rawSegments) {
        const baseSegments = selection.segments.filter((base) => base.page === segment.page)
        if (baseSegments.length === 0) continue
        for (const base of baseSegments) {
          const overlap = intersectRect(
            { x: segment.x, y: segment.y, width: segment.width, height: segment.height },
            { x: base.x, y: base.y, width: base.width, height: base.height },
          )
          if (!overlap) continue
          result.push({
            page: segment.page,
            ...overlap,
          })
        }
      }

      return result
    },
    [computeSegmentsForRect, selection],
  )

  const resetSelection = useCallback(() => {
    setSelection(null)
    setInteractionMode('main')
    setPendingExclusions([])
    setPendingLegends([])
    setDragKind(null)
    setDragStart(null)
    lastRectRef.current = null
    geometrySnapshotRef.current = null
    lastPointerEventRef.current = null
    frameRequestedRef.current = false
    lastProcessedPointRef.current = null
  }, [])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 鼠标仅响应左键，触摸/笔则不限制 button
      if (event.pointerType === 'mouse' && event.button !== 0) return
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-selection-control="true"]')) return
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // 某些浏览器可能不支持 pointer capture，忽略即可
      }
      const startPoint = getContainerPoint(event.clientX, event.clientY)
      if (!startPoint) return

      captureGeometrySnapshot()

      if (interactionMode === 'exclude') {
        if (!selection) return
        event.preventDefault()
        setDragKind('exclude')
        setDragStart(startPoint)
        setPendingExclusions([])
        lastRectRef.current = null
        isDraggingRef.current = true
        return
      }

      if (interactionMode === 'legend') {
        if (!selection) return
        event.preventDefault()
        setDragKind('legend')
        setDragStart(startPoint)
        setPendingLegends([])
        lastRectRef.current = null
        isDraggingRef.current = true
        return
      }

      event.preventDefault()
      setDragKind('main')
      setDragStart(startPoint)
      setSelection({
        x: startPoint.x,
        y: startPoint.y,
        width: 0,
        height: 0,
        segments: [],
        exclusions: [],
      })
      setPendingExclusions([])
      lastRectRef.current = null
      isDraggingRef.current = true
    },
    [captureGeometrySnapshot, getContainerPoint, interactionMode, selection],
  )

  useEffect(() => {
    if (!dragKind || !dragStart) return

    const processFrame = () => {
      frameRequestedRef.current = false
      const last = lastPointerEventRef.current
      if (!last) return
      const current = getContainerPoint(last.clientX, last.clientY)
      if (!current) return

      if (needsSnapshotRefreshRef.current) {
        captureGeometrySnapshot()
        needsSnapshotRefreshRef.current = false
      }

      const lastProcessed = lastProcessedPointRef.current
      if (
        lastProcessed &&
        Math.abs(current.x - lastProcessed.x) < 2 &&
        Math.abs(current.y - lastProcessed.y) < 2
      ) {
        return
      }
      lastProcessedPointRef.current = current

      const rect: Rect = {
        x: Math.min(dragStart.x, current.x),
        y: Math.min(dragStart.y, current.y),
        width: Math.abs(current.x - dragStart.x),
        height: Math.abs(current.y - dragStart.y),
      }
      lastRectRef.current = rect

      if (dragKind === 'main') {
        const segments = computeSegmentsForRect(rect)
        setSelection((prev) =>
          prev
            ? {
                ...prev,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                segments,
              }
            : prev,
        )
      } else if (dragKind === 'exclude') {
        const segments = computeExclusionSegments(rect)
        setPendingExclusions(segments)
      } else if (dragKind === 'legend') {
        const segments = computeExclusionSegments(rect)
        setPendingLegends(segments)
      }
    }

    const handleMove = (event: PointerEvent) => {
      lastPointerEventRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
      }
      if (!frameRequestedRef.current) {
        frameRequestedRef.current = true
        window.requestAnimationFrame(processFrame)
      }
    }

    const handleUp = () => {
      if (dragKind === 'exclude' && selection && lastRectRef.current) {
        const segments = computeExclusionSegments(lastRectRef.current)
        if (segments.length > 0) {
          setSelection((prev) =>
            prev
              ? {
                  ...prev,
                  exclusions: [
                    ...prev.exclusions,
                    ...segments.map<SelectionExclusion>((segment) => ({
                      ...segment,
                      id: generateId(),
                    })),
                  ],
                }
              : prev,
          )
        }
      }

      if (dragKind === 'legend' && selection && lastRectRef.current) {
        const segments = computeExclusionSegments(lastRectRef.current)
        if (segments.length > 0) {
          setSelection((prev) =>
            prev
              ? {
                  ...prev,
                  legends: [
                    ...(prev.legends ?? []),
                    ...segments.map<SelectionLegend>((segment) => ({
                      ...segment,
                      id: generateId(),
                    })),
                  ],
                }
              : prev,
          )
        }
      }

      setPendingExclusions([])
      setPendingLegends([])
      setDragKind(null)
      setDragStart(null)
      lastRectRef.current = null
      geometrySnapshotRef.current = null
      lastPointerEventRef.current = null
      frameRequestedRef.current = false
      lastProcessedPointRef.current = null
      isDraggingRef.current = false
      needsSnapshotRefreshRef.current = false
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [
    captureGeometrySnapshot,
    computeExclusionSegments,
    computeSegmentsForRect,
    dragKind,
    dragStart,
    getContainerPoint,
    selection,
  ])

  useEffect(() => {
    const container = previewScrollRef.current
    if (!container) return
    const handleScroll = () => {
      if (!isDraggingRef.current) return
      needsSnapshotRefreshRef.current = true
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [previewScrollRef])

  const toggleExclusionMode = useCallback(() => {
    setInteractionMode((prev) => (prev === 'exclude' ? 'main' : 'exclude'))
  }, [])

  const toggleLegendMode = useCallback(() => {
    setInteractionMode((prev) => (prev === 'legend' ? 'main' : 'legend'))
  }, [])

  const removeExclusion = useCallback((id: string) => {
    setSelection((prev) =>
      prev
        ? {
            ...prev,
            exclusions: prev.exclusions.filter((item) => item.id !== id),
          }
        : prev,
    )
  }, [])

  const removeLegend = useCallback((id: string) => {
    setSelection((prev) =>
      prev
        ? {
            ...prev,
            legends: (prev.legends ?? []).filter((item) => item.id !== id),
          }
        : prev,
    )
  }, [])

  const buildRegionsPayload = useCallback(() => {
    if (!selection) return null
    const segments = selection.segments.filter(
      (item) => item.width > MIN_SEGMENT_SIZE && item.height > MIN_SEGMENT_SIZE,
    )
    if (segments.length === 0) return []

    const exclusionsByPage = selection.exclusions.reduce<Record<number, SelectionExclusion[]>>((acc, item) => {
      acc[item.page] = acc[item.page] ? [...acc[item.page], item] : [item]
      return acc
    }, {})
    const regions: RegionPayload[] = []

    // 每页合并为一个大区域，附带 holes
    const segmentsByPage = segments.reduce<Record<number, PageSelectionSegment[]>>((acc, seg) => {
      acc[seg.page] = acc[seg.page] ? [...acc[seg.page], seg] : [seg]
      return acc
    }, {})

    for (const [pageStr, segs] of Object.entries(segmentsByPage)) {
      const page = Number(pageStr)
      const metrics = getPageMetrics(page)
      if (!metrics) continue
      const { containerRect, imageRect } = metrics
      if (imageRect.width <= 0 || imageRect.height <= 0) continue

      // 求该页主选区的包围盒
      const minX = Math.min(...segs.map((s) => s.x))
      const minY = Math.min(...segs.map((s) => s.y))
      const maxX = Math.max(...segs.map((s) => s.x + s.width))
      const maxY = Math.max(...segs.map((s) => s.y + s.height))

      const offsetX = imageRect.left - containerRect.left
      const offsetY = imageRect.top - containerRect.top
      const segImgX = minX - offsetX
      const segImgY = minY - offsetY
      const segImgW = maxX - minX
      const segImgH = maxY - minY

      const normX = clamp01(segImgX / imageRect.width)
      const normY = clamp01(segImgY / imageRect.height)
      const normW = clamp01(segImgW / imageRect.width)
      const normH = clamp01(segImgH / imageRect.height)
      if (normW <= 0 || normH <= 0) continue

      const holes = (exclusionsByPage[page] ?? []).map((hole) => {
        const hx = clamp01((hole.x - offsetX) / imageRect.width)
        const hy = clamp01((hole.y - offsetY) / imageRect.height)
        const hw = clamp01(hole.width / imageRect.width)
        const hh = clamp01(hole.height / imageRect.height)
        return { x: hx, y: hy, width: hw, height: hh }
      })

      regions.push({
        page,
        x: normX,
        y: normY,
        width: normW,
        height: normH,
        exclusions: holes,
      })
    }

    return regions
  }, [getPageMetrics, selection])

  const buildLegendsPayload = useCallback(() => {
    if (!selection || !selection.legends || selection.legends.length === 0) return []

    const legends: LegendRegionPayload[] = []
    for (const legend of selection.legends) {
      const metrics = getPageMetrics(legend.page)
      if (!metrics) continue
      const { containerRect, imageRect } = metrics
      if (imageRect.width <= 0 || imageRect.height <= 0) continue

      const offsetX = imageRect.left - containerRect.left
      const offsetY = imageRect.top - containerRect.top
      const segImgX = legend.x - offsetX
      const segImgY = legend.y - offsetY
      const normX = clamp01(segImgX / imageRect.width)
      const normY = clamp01(segImgY / imageRect.height)
      const normW = clamp01(legend.width / imageRect.width)
      const normH = clamp01(legend.height / imageRect.height)
      if (normW <= 0 || normH <= 0) continue
      legends.push({
        page: legend.page,
        x: normX,
        y: normY,
        width: normW,
        height: normH,
      })
    }

    return legends
  }, [getPageMetrics, selection])

  const isExclusionMode = interactionMode === 'exclude'
  const isLegendMode = interactionMode === 'legend'

  return {
    selection,
    pendingExclusions,
    pendingLegends,
    isExclusionMode,
    isLegendMode,
    handlePointerDown,
    toggleExclusionMode,
    toggleLegendMode,
    clearSelection: resetSelection,
    removeExclusion,
    removeLegend,
    buildRegionsPayload,
    buildLegendsPayload,
  }
}
