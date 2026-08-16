/** Shared presentational primitives. */
import { useEffect, useRef, useState } from 'react'
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
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const closeTimer = useRef<number | undefined>(undefined)
  const show = (): void => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect !== undefined) {
      const popWidth = Math.min(width, window.innerWidth - 16)
      setPosition({
        top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - maxHeight - 40)),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popWidth - 8)),
      })
    }
    setOpen(true)
  }
  const hideSoon = (): void => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => { setOpen(false) }, 100)
  }
  useEffect(() => () => { if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current) }, [])
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={hoverClass}
        aria-expanded={open}
        aria-label={label}
        style={popoverTriggerStyle}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hideSoon}
      >
        {children(open, setOpen)}
      </button>
      {open && createPortal(
        <div
          data-dshw-kanban="root"
          style={{ ...popoverStyle, top: position.top, left: position.left, width: Math.min(width, window.innerWidth - 16), maxHeight }}
          onMouseEnter={show}
          onMouseLeave={hideSoon}
        >
          {render(() => { setOpen(false) })}
        </div>,
        document.body,
      )}
    </>
  )
}