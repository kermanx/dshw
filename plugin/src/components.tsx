/*
 * UI reference skill: vscode-ui
 * Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
 * Reference components: Hover, Tooltip.
 * Adaptation: Delayed workflow details with pointer transit, keyboard closing,
 * and cleanup when scrolling, resizing, or hiding the sidebar anchor.
 * Copyright (c) Microsoft Corporation. MIT; see ../LICENSE.vscode-ui.txt.
 */
/** Shared presentational primitives. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { GCaretDown, GCaretRight, GGithub } from './icons.tsx'
import { popoverStyle, popoverTriggerStyle, repoGroupCellStyle, repoGroupRowStyle, repoGroupTitleStyle, repoGroupTitleTextStyle } from './styles.ts'
import { C_MUTED, C_SECONDARY } from './theme.ts'

/* ── tiny primitives ── */

/** Repo group header row inside a shared table: click to collapse/expand.
 *  The GitHub mark links to the repo (target=_blank) without toggling. */
export function RepoGroupRow({ repoSlug, collapsed, onToggle, colSpan, children }: {
  repoSlug: string
  collapsed: boolean
  onToggle: (repoSlug: string) => void
  colSpan: number
  children: ReactNode
}): ReactNode {
  return (
    <>
      <tr data-dshw-kanban="repogroup" style={repoGroupRowStyle} onClick={() => { onToggle(repoSlug) }}>
        <td colSpan={colSpan} style={repoGroupCellStyle}>
          <span style={repoGroupTitleStyle}>
            <a
              href={`https://github.com/${repoSlug}`}
              target="_blank"
              rel="noreferrer"
              title={`在 GitHub 打开 ${repoSlug}`}
              style={{ display: 'inline-flex', flex: 'none', color: C_SECONDARY, textDecoration: 'none' }}
              onClick={event => { event.stopPropagation() }}
            >
              <GGithub size={12} />
            </a>
            <span style={repoGroupTitleTextStyle}>{repoSlug}</span>
            <span style={{ display: 'inline-flex', flex: 'none', color: C_MUTED }}>
              {collapsed ? <GCaretRight size={14} /> : <GCaretDown size={14} />}
            </span>
          </span>
        </td>
      </tr>
      {!collapsed && children}
    </>
  )
}

/* ── tiny primitives ── */

/** Hover popover anchored near the trigger (Teleport port of the Vue popovers). */
export function HoverPopover({ label, width, children, render, maxHeight, hoverClass = 'dshw-trigger' }: {
  label: string
  width: number
  children: (open: boolean, setOpen: (v: boolean) => void) => ReactNode
  render: (close: () => void) => ReactNode
  maxHeight: number
  /** Hover-state class applied to the trigger (default: underline + darken). */
  hoverClass?: string
}): ReactNode {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const closeTimer = useRef<number | undefined>(undefined)
  const openTimer = useRef<number | undefined>(undefined)
  /** 以触发器为锚点计算浮窗位置：默认放在触发器下方；下方空间不够时翻到上方，
   *  并用实际渲染高度（而非 maxHeight）判断，避免靠底部的行弹窗被顶到很上面。 */
  const place = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const popWidth = Math.min(width, window.innerWidth - 16)
    const popHeight = popoverRef.current?.offsetHeight ?? maxHeight
    let top = rect.bottom + 6
    if (top + popHeight > window.innerHeight - 8) {
      top = rect.top - popHeight - 6
    }
    setPosition({
      top: Math.max(8, top),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - popWidth - 8)),
    })
  }
  const show = (): void => {
    window.clearTimeout(openTimer.current)
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
    if ((triggerRef.current?.getBoundingClientRect().width ?? 0) === 0) return
    setOpen(true)
  }
  const showSoon = (): void => {
    window.clearTimeout(closeTimer.current)
    window.clearTimeout(openTimer.current)
    openTimer.current = window.setTimeout(show, 300)
  }
  const hideSoon = (): void => {
    window.clearTimeout(openTimer.current)
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => { setOpen(false) }, 200)
  }
  // 打开且浮窗渲染后，按实际高度重新定位；之后鼠标移入浮窗也沿用同一位置。
  useLayoutEffect(() => {
    if (open) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, width])
  useEffect(() => () => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (): void => { setOpen(false) }
    const contains = (target: EventTarget | null): boolean => target instanceof Node
      && (triggerRef.current?.contains(target) === true || popoverRef.current?.contains(target) === true)
    const pointer = (event: PointerEvent): void => { if (!contains(event.target)) close() }
    const scroll = (event: Event): void => {
      if (!(event.target instanceof Node) || !popoverRef.current?.contains(event.target)) close()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (contains(event.target)) {
        event.preventDefault()
        event.stopPropagation()
        if (popoverRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
      }
      close()
    }
    const observer = new ResizeObserver(() => {
      if ((triggerRef.current?.getBoundingClientRect().width ?? 0) === 0) close()
      else place()
    })
    if (triggerRef.current !== null) observer.observe(triggerRef.current)
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('scroll', scroll, true)
    document.addEventListener('keydown', key)
    window.addEventListener('resize', close)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('keydown', key)
      window.removeEventListener('resize', close)
    }
  }, [open])
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={hoverClass}
        aria-expanded={open}
        aria-label={label}
        style={popoverTriggerStyle}
        onMouseEnter={showSoon}
        onMouseLeave={hideSoon}
        onFocus={show}
        onClick={show}
        onKeyDown={event => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          show()
          requestAnimationFrame(() => { popoverRef.current?.querySelector<HTMLElement>('a[href], button:not(:disabled)')?.focus() })
        }}
        onBlur={event => { if (!popoverRef.current?.contains(event.relatedTarget)) hideSoon() }}
      >
        {children(open, setOpen)}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          data-dshw-kanban="root"
          data-dshw-popover=""
          style={{ ...popoverStyle, top: position.top, left: position.left, width: Math.min(width, window.innerWidth - 16), maxHeight }}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
          onFocusCapture={show}
          onBlurCapture={event => {
            if (!popoverRef.current?.contains(event.relatedTarget) && !triggerRef.current?.contains(event.relatedTarget)) hideSoon()
          }}
        >
          {render(() => { setOpen(false) })}
        </div>,
        document.body,
      )}
    </>
  )
}
