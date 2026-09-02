/** Dependency-free fixed/variable-height virtual list range for the review diff.
 *  Row heights are deterministic (hunk vs content lines / uniform tree rows), so
 *  the visible window can be derived exactly from a scroll offset without a DOM
 *  measurement pass. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface VirtualRange {
  start: number
  end: number
  totalHeight: number
  offsets: number[]
  scrollTop: number
}

/** Track a scroll container and report the visible row interval for a row list. */
export function useVirtualRange(heights: readonly number[], scrollRef: RefObject<HTMLElement>): VirtualRange {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const offsets = useMemo(() => {
    const rows = new Array<number>((heights.length + 1) | 0)
    rows[0] = 0
    for (let index = 0; index < heights.length; index += 1) rows[index + 1] = rows[index]! + (heights[index] ?? 0)
    return rows
  }, [heights])
  const totalHeight = offsets[heights.length] ?? 0

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const onScroll = (): void => { setScrollTop(element.scrollTop) }
    const measure = (): void => { setViewport(element.clientHeight) }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    element.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      observer?.disconnect()
      element.removeEventListener('scroll', onScroll)
    }
  }, [scrollRef])

  const bottom = scrollTop + viewport
  const start = clamp(firstIndexAtOrBefore(offsets, scrollTop), 0, Math.max(0, heights.length - 1))
  const end = Math.min(heights.length, clamp(firstIndexAtOrBefore(offsets, bottom) + 1, start, heights.length))
  return { start, end, totalHeight, offsets, scrollTop }
}

/** Largest index i with offsets[i] <= position (the row containing `position`). */
function firstIndexAtOrBefore(offsets: readonly number[], position: number): number {
  if (offsets.length <= 1) return 0
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if ((offsets[middle] ?? 0) <= position) low = middle
    else high = middle - 1
  }
  return low
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** React ref that stays live to a scroll container sized later in the tree. */
export function useStableRef<T>(): RefObject<T> {
  const ref = useRef<T>(null)
  return ref
}
