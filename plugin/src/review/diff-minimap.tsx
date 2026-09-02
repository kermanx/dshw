/** Canvas overview and navigation for one changed-file diff (angry-turtle port). */
import { useEffect, useId, useMemo, useRef } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { ReviewDiffFile, ReviewDiffRow } from '../../../src/types.ts'

const DIFF_ROW_HEIGHT = 23
const DIFF_HUNK_HEIGHT = 26
const MAX_MINIMAP_TEXT_CHARS = 120
const MIN_VIEWPORT_PIXELS = 12

interface DiffMinimapComment {
  path: string
  line: number
  side: 'old' | 'new'
}

interface DiffMinimapRaster {
  context: Uint8Array
  added: Uint8Array
  removed: Uint8Array
  hunk: Uint8Array
  comment: Uint8Array
}

interface DiffMinimapScale {
  offsets: Uint32Array
  totalHeight: number
}

interface DiffMinimapViewport {
  startIndex: number
  endIndex: number
}

const minimapSlotStyle: CSSProperties = {
  flex: 'none',
  width: 16,
  alignSelf: 'stretch',
  borderLeft: '1px solid rgba(127, 127, 127, .18)',
  background: 'rgba(0, 0, 0, .02)',
}

const minimapCanvasStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  cursor: 'pointer',
  outline: 'none',
}

/** Build the compact row coordinate system used by the minimap. */
export function createDiffMinimapScale(rows: readonly ReviewDiffRow[]): DiffMinimapScale {
  const offsets = new Uint32Array(rows.length + 1)
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index + 1] = (offsets[index] ?? 0) + rowHeight(rows[index] as ReviewDiffRow)
  }
  return { offsets, totalHeight: offsets[rows.length] ?? 0 }
}

/** Resolve a normalized minimap position to its source diff row. */
export function minimapRowAtRatio(scale: DiffMinimapScale, ratio: number): number {
  if (scale.offsets.length <= 1 || scale.totalHeight === 0) return 0
  const boundedRatio = Math.min(1, Math.max(0, ratio))
  const target = Math.min(scale.totalHeight - 1, Math.floor(boundedRatio * scale.totalHeight))
  let low = 0
  let high = scale.offsets.length - 2
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((scale.offsets[middle] ?? 0) <= target) low = middle
    else high = middle - 1
  }
  return low
}

function createDiffMinimapRaster(
  rows: readonly ReviewDiffRow[],
  file: ReviewDiffFile,
  comments: readonly DiffMinimapComment[],
  pixelHeight: number,
): DiffMinimapRaster {
  const height = Math.max(0, Math.floor(pixelHeight))
  const raster: DiffMinimapRaster = {
    context: new Uint8Array(height),
    added: new Uint8Array(height),
    removed: new Uint8Array(height),
    hunk: new Uint8Array(height),
    comment: new Uint8Array(height),
  }
  if (height === 0 || rows.length === 0) return raster
  const scale = createDiffMinimapScale(rows)
  const commentKeys = new Set(comments.map(comment => commentKey(comment.side, comment.path, comment.line)))
  const oldPath = file.oldPath ?? file.path
  for (const [index, row] of rows.entries()) {
    const offset = scale.offsets[index] ?? 0
    const nextOffset = scale.offsets[index + 1] ?? offset
    const firstPixel = Math.min(height - 1, Math.floor(offset / scale.totalHeight * height))
    const lastPixel = Math.min(height, Math.max(firstPixel + 1, Math.ceil(nextOffset / scale.totalHeight * height)))
    const lineWidth = minimapLineWidth(row)
    const target = row.kind === 'hunk' ? raster.hunk : raster[row.kind]
    const commented = row.kind !== 'hunk' && (
      (row.oldLine !== undefined && commentKeys.has(commentKey('old', oldPath, row.oldLine)))
      || (row.newLine !== undefined && commentKeys.has(commentKey('new', file.path, row.newLine)))
    )
    for (let pixel = firstPixel; pixel < lastPixel; pixel += 1) {
      target[pixel] = Math.max(target[pixel] ?? 0, lineWidth)
      if (commented) raster.comment[pixel] = 255
    }
  }
  return raster
}

export function DiffMinimap({
  rows,
  file,
  comments,
  scrollRef,
  scrollId,
  onNavigate,
  viewport,
  label,
  hint,
  description,
  positionLabel,
}: {
  rows: readonly ReviewDiffRow[]
  file: ReviewDiffFile
  comments: readonly DiffMinimapComment[]
  scrollRef: RefObject<HTMLDivElement>
  scrollId: string
  onNavigate: (rowIndex: number) => void
  viewport: DiffMinimapViewport
  label: string
  hint: string
  description: string
  positionLabel: (percent: number) => string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const draggingPointer = useRef<number>()
  const scheduleDrawRef = useRef<() => void>(() => {})
  const viewportRef = useRef(viewport)
  const descriptionId = useId()
  const scale = useMemo(() => createDiffMinimapScale(rows), [rows])
  const maximumRow = Math.max(0, rows.length - 1)
  const viewportStart = Math.min(maximumRow, Math.max(0, viewport.startIndex))
  const viewportEnd = Math.min(maximumRow, Math.max(viewportStart, viewport.endIndex))
  const maximumViewportStart = Math.max(0, rows.length - (viewportEnd - viewportStart + 1))
  const viewportValue = Math.min(viewportStart, maximumViewportStart)
  const percent = minimapViewportPercent(rows.length, { startIndex: viewportStart, endIndex: viewportEnd })
  const navigationRow = Math.round((viewportStart + viewportEnd) / 2)
  viewportRef.current = viewport

  useEffect(() => {
    const canvas = canvasRef.current
    const scroll = scrollRef.current
    if (canvas === null || scroll === null) return
    let frame = 0
    let rasterHeight = -1
    let raster = createDiffMinimapRaster(rows, file, comments, 0)
    const draw = (): void => {
      frame = 0
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const context = canvas.getContext('2d')
      if (context === null) return
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      const backingWidth = Math.round(width * pixelRatio)
      const backingHeight = Math.round(height * pixelRatio)
      if (canvas.width !== backingWidth) canvas.width = backingWidth
      if (canvas.height !== backingHeight) canvas.height = backingHeight
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      if (rasterHeight !== height) {
        raster = createDiffMinimapRaster(rows, file, comments, height)
        rasterHeight = height
      }
      paintMinimap(context, raster, width, height, scale, viewportRef.current)
    }
    const scheduleDraw = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(draw)
    }
    scheduleDrawRef.current = scheduleDraw
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleDraw)
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || (event.deltaX === 0 && event.deltaY === 0)) return
      event.preventDefault()
      const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? DIFF_ROW_HEIGHT
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroll.clientHeight : 1
      scroll.scrollLeft += event.deltaX * multiplier
      scroll.scrollTop += event.deltaY * multiplier
    }
    observer?.observe(canvas)
    observer?.observe(scroll)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    scroll.addEventListener('scroll', scheduleDraw, { passive: true })
    window.addEventListener('resize', scheduleDraw)
    scheduleDraw()
    return () => {
      scheduleDrawRef.current = () => {}
      if (frame !== 0) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      scroll.removeEventListener('scroll', scheduleDraw)
      window.removeEventListener('resize', scheduleDraw)
    }
  }, [comments, file, rows, scale, scrollRef])

  useEffect(() => { scheduleDrawRef.current() }, [viewport.endIndex, viewport.startIndex])

  const navigate = (clientY: number): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const rect = canvas.getBoundingClientRect()
    if (rect.height <= 0) return
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    onNavigate(minimapRowAtRatio(scale, ratio))
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingPointer.current !== undefined && draggingPointer.current !== event.pointerId) return
    event.preventDefault()
    event.currentTarget.focus()
    draggingPointer.current = event.pointerId
    event.currentTarget.setPointerCapture?.(event.pointerId)
    navigate(event.clientY)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingPointer.current !== event.pointerId) return
    navigate(event.clientY)
  }
  const stopDragging = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingPointer.current !== event.pointerId) return
    draggingPointer.current = undefined
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
  }
  const onLostPointerCapture = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingPointer.current === event.pointerId) draggingPointer.current = undefined
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>): void => {
    const scroll = scrollRef.current
    const pageRows = Math.max(1, Math.round((scroll?.clientHeight ?? DIFF_ROW_HEIGHT) / DIFF_ROW_HEIGHT))
    const next = event.key === 'ArrowUp' ? navigationRow - 1
      : event.key === 'ArrowDown' ? navigationRow + 1
        : event.key === 'PageUp' ? navigationRow - pageRows
          : event.key === 'PageDown' ? navigationRow + pageRows
            : event.key === 'Home' ? 0
              : event.key === 'End' ? maximumRow
                : undefined
    if (next === undefined) return
    event.preventDefault()
    onNavigate(Math.min(maximumRow, Math.max(0, next)))
  }
  return (
    <div style={minimapSlotStyle}>
      <span id={descriptionId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{description}</span>
      <canvas
        ref={canvasRef}
        style={minimapCanvasStyle}
        role="scrollbar"
        tabIndex={0}
        aria-controls={scrollId}
        aria-describedby={descriptionId}
        aria-label={label}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={maximumViewportStart}
        aria-valuenow={viewportValue}
        aria-valuetext={positionLabel(percent)}
        title={hint}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onLostPointerCapture={onLostPointerCapture}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}

export function minimapViewportPercent(rowCount: number, viewport: DiffMinimapViewport): number {
  if (rowCount <= 1) return 0
  const startIndex = Math.min(rowCount - 1, Math.max(0, viewport.startIndex))
  const endIndex = Math.min(rowCount - 1, Math.max(startIndex, viewport.endIndex))
  const maximumStart = Math.max(0, rowCount - (endIndex - startIndex + 1))
  return maximumStart === 0 ? 0 : Math.round(Math.min(startIndex, maximumStart) / maximumStart * 100)
}

function paintMinimap(context: CanvasRenderingContext2D, raster: DiffMinimapRaster, width: number, height: number, scale: DiffMinimapScale, viewport: DiffMinimapViewport): void {
  context.clearRect(0, 0, width, height)
  context.fillStyle = 'rgba(127, 127, 127, 0.045)'
  context.fillRect(0, 0, width, height)
  for (let pixel = 0; pixel < height; pixel += 1) {
    drawRasterLine(context, raster.context[pixel] ?? 0, 3, width - 8, pixel, 1, 'rgba(127, 127, 127, 0.32)')
    const removed = raster.removed[pixel] ?? 0
    const added = raster.added[pixel] ?? 0
    const laneWidth = (width - 8) / 2
    drawRasterLine(context, removed, 3, laneWidth, pixel, 1, 'rgba(226, 78, 78, 0.88)')
    drawRasterLine(context, added, 5 + laneWidth, laneWidth, pixel, 1, 'rgba(46, 160, 96, 0.88)')
    drawRasterLine(context, raster.hunk[pixel] ?? 0, 3, width - 8, pixel, 1, 'rgba(80, 120, 230, 0.75)')
    if ((raster.comment[pixel] ?? 0) > 0) {
      context.fillStyle = 'rgba(230, 166, 45, 0.98)'
      context.fillRect(width - 3, pixel, 3, 2)
    }
  }
  const startIndex = Math.min(Math.max(0, viewport.startIndex), scale.offsets.length - 2)
  const endIndex = Math.min(Math.max(startIndex, viewport.endIndex), scale.offsets.length - 2)
  const viewportTop = (scale.offsets[startIndex] ?? 0) / scale.totalHeight * height
  const viewportBottom = (scale.offsets[endIndex + 1] ?? scale.totalHeight) / scale.totalHeight * height
  const viewportHeight = Math.min(height, Math.max(MIN_VIEWPORT_PIXELS, viewportBottom - viewportTop))
  const boundedTop = Math.min(height - viewportHeight, Math.max(0, viewportTop))
  context.fillStyle = 'rgba(80, 120, 230, 0.12)'
  context.fillRect(0, boundedTop, width, viewportHeight)
  context.strokeStyle = 'rgba(80, 120, 230, 0.82)'
  context.lineWidth = 1
  context.strokeRect(0.5, boundedTop + 0.5, width - 1, Math.max(1, viewportHeight - 1))
}

function drawRasterLine(context: CanvasRenderingContext2D, amount: number, x: number, laneWidth: number, y: number, height: number, color: string): void {
  if (amount === 0) return
  context.fillStyle = color
  context.fillRect(x, y, Math.max(2, amount / 255 * laneWidth), height)
}

function rowHeight(row: ReviewDiffRow): number {
  return row.kind === 'hunk' ? DIFF_HUNK_HEIGHT : DIFF_ROW_HEIGHT
}

function minimapLineWidth(row: ReviewDiffRow): number {
  if (row.kind === 'hunk') return 255
  const length = row.text.trimEnd().length
  return Math.round(Math.min(1, Math.max(0.12, length / MAX_MINIMAP_TEXT_CHARS)) * 255)
}

function commentKey(side: DiffMinimapComment['side'], path: string, line: number): string {
  return `${side}\u0000${path}\u0000${String(line)}`
}
