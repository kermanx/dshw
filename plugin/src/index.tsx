/**
 * dshw kanban — browser half.
 *
 * Registers the kanban dashboard as a `sidebar.footer.action` entry (the
 * sidebar foot, above Settings) and opens it in a panel spanning everything
 * right of the sidebar. The Pull requests view renders natively (no iframe),
 * talking to the local dshw daemon API (CORS-enabled) over fetch + SSE; the
 * remaining dshw views stay reachable via the panel's open-in-browser action.
 *
 * The daemon origin defaults to the dshw loopback port (7849) and can be
 * overridden per browser via localStorage (set in the panel's unreachable
 * state). Reachability is probed with a no-cors fetch, which rejects on
 * network failure without needing CORS headers from the daemon.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBranchOutline16, IconCloseOutline16, IconRefreshOutline16, IconRightUpOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { en, zh } from './locales.ts'
import { PrDashboard } from './pr-dashboard.tsx'

/** Locale namespace owned by this plugin. */
const NS = 'kanban'

/** dshw daemon default origin (src/config.ts PORT default 7849, loopback). */
const DEFAULT_BASE_URL = 'http://127.0.0.1:7849'
/** localStorage key holding a user-supplied dshw origin override. */
const URL_STORAGE_KEY = 'dshw.kanban.baseUrl'
/** Unique style-tag id so repeated mounts (HMR) never duplicate rules. */
const STYLE_ID = 'dshw-kanban-styles'

/** Static rules for hover/selected states and the scoped isolation reset.
 *  The harness page has no global box-sizing reset and its plugin sheets can
 *  leak into this panel, so every dshw surface (dashboard root, hover
 *  popovers, dialogs — all marked `data-dshw-kanban="root"`) re-establishes a
 *  baseline: border-box sizing, zeroed margins, neutral table/link/button
 *  defaults. Inline styles on the elements themselves still win where they
 *  differ; the tokens (--dsw-*) are inherited, not reset. */
const STYLE_TEXT = `
[data-dshw-kanban="root"] *,
[data-dshw-kanban="root"] *::before,
[data-dshw-kanban="root"] *::after { box-sizing: border-box; margin: 0; padding: 0; }
[data-dshw-kanban="root"] { font-family: var(--dsw-font-family); font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
[data-dshw-kanban="root"] table { border-collapse: collapse; border-spacing: 0; }
[data-dshw-kanban="root"] td,
[data-dshw-kanban="root"] th { text-align: left; vertical-align: middle; }
[data-dshw-kanban="root"] a { color: inherit; text-decoration: none; }
[data-dshw-kanban="root"] button { font-family: inherit; font-size: inherit; line-height: inherit; appearance: none; -webkit-appearance: none; background: none; border: none; color: inherit; cursor: pointer; }
[data-dshw-kanban="root"] input { font-family: inherit; }
[data-dshw-kanban="root"] p { margin: 0; }
[data-dshw-kanban="root"] img { border: 0; }
[data-dshw-kanban="trigger"],
[data-dshw-kanban="icon"] { background: transparent; }
[data-dshw-kanban="trigger"]:hover,
[data-dshw-kanban="trigger"][data-selected],
[data-dshw-kanban="icon"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
[data-dshw-kanban="input"]:focus { border-color: var(--dsw-alias-state-business-primary); }
`

/** The framework-injected locale seat type (entry `locale` option). */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** Composed props of the footer action entry (owner share + locale seat). */
export interface KanbanFooterActionProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
  /** Standard locale seat bound by the entry's `locale` option. */
  t: Translate
}

/** Services required before the entry activates. */
export const inject = ['slots', 'locale']

/** Register the footer action once its slot declaration is on the ledger. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshw-kanban: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dshw-kanban',
    order: 0,
    locale: NS,
  }, KanbanFooterAction))
}

/** Read the daemon origin override, falling back to the default. */
function readBaseUrl(): string {
  try {
    return localStorage.getItem(URL_STORAGE_KEY) ?? DEFAULT_BASE_URL
  } catch {
    return DEFAULT_BASE_URL
  }
}

/** Inject the shared style tag once (lazy — runs when the entry mounts). */
function useKanbanStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE_TEXT
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])
}

/** The sidebar-foot trigger (wide row / rail icon) plus the fullscreen panel.
 *  Geometry and chrome mirror the settings trigger row (ui-settings-general
 *  SettingsRoot.module.css .trigger) so both footer entries look identical. */
export function KanbanFooterAction({ wide, t }: KanbanFooterActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  useKanbanStyles()
  return (
    <>
      <Tooltip label={t('action.aria')} side="top" delayMs={500}>
        <button
          type="button"
          data-dshw-kanban="trigger"
          data-selected={open || undefined}
          aria-label={t('action.aria')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
          style={triggerStyle(wide)}
        >
          <IconBranchOutline16 size={wide ? 16 : 18} />
          {wide && <span style={labelStyle}>{t('action.label')}</span>}
        </button>
      </Tooltip>
      {open && <KanbanPanel t={t} onClose={() => { setOpen(false) }} />}
    </>
  )
}

/** Panel state: probing the daemon, embedded dashboard, or an unreachable form. */
type PanelStatus = 'checking' | 'ready' | 'down'

/**
 * Right edge of the left sidebar column: the AppFrame grid's first track
 * (the `sidebarCol` element, identified through the frame's shell-overlay
 * seat). The kanban panel spans everything to the right of it, leaving the
 * sidebar visible and interactive.
 */
function measureSidebarRight(): number {
  const frame = document.querySelector('[data-shell-overlay]')?.parentElement
  const column = frame?.firstElementChild
  return column instanceof HTMLElement ? column.getBoundingClientRect().right : 0
}

/** Panel: header chrome plus the native PR kanban (no iframe). */
function KanbanPanel({ t, onClose }: { t: Translate; onClose: () => void }): ReactNode {
  const [baseUrl, setBaseUrl] = useState(readBaseUrl)
  const [draft, setDraft] = useState(baseUrl)
  const [status, setStatus] = useState<PanelStatus>('checking')
  const [refreshKey, setRefreshKey] = useState(0)
  const [left, setLeft] = useState(measureSidebarRight)

  // Follow the sidebar's right edge while open (drag-resize, collapse, narrow
  // auto-collapse) so the panel always fills exactly the space beside it.
  useEffect(() => {
    const frame = document.querySelector('[data-shell-overlay]')?.parentElement
    const column = frame?.firstElementChild
    if (!(column instanceof HTMLElement)) return
    const update = (): void => { setLeft(measureSidebarRight()) }
    const observer = new ResizeObserver(update)
    observer.observe(column)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  // Close on Escape while the panel is mounted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Probe the daemon whenever the target changes: reachable → native kanban,
  // unreachable → the URL editor.
  useEffect(() => {
    let cancelled = false
    setStatus('checking')
    fetch(`${baseUrl}/api/state`, { mode: 'no-cors', signal: AbortSignal.timeout(3000) })
      .then(() => { if (!cancelled) setStatus('ready') })
      .catch(() => { if (!cancelled) setStatus('down') })
    return () => { cancelled = true }
  }, [baseUrl])

  const refresh = (): void => {
    setRefreshKey(value => value + 1)
    // Ask the daemon to re-sync PRs; the snapshot then arrives over SSE.
    void fetch(`${baseUrl}/api/prs/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {})
  }

  const save = (): void => {
    const next = draft.trim().replace(/\/+$/, '')
    if (next === '') return
    try {
      localStorage.setItem(URL_STORAGE_KEY, next)
    } catch {
      // Storage unavailable (private mode): keep the in-session override.
    }
    setBaseUrl(next)
  }

  return createPortal(
    <div style={overlayStyle(left)} role="presentation">
      <section style={panelStyle} role="dialog" aria-modal="true" aria-label={t('panel.title')} data-dshw-kanban="root">
        <header style={headerStyle}>
          <span style={titleStyle}>{t('panel.title')}</span>
          <span style={actionsStyle}>
            <button
              type="button"
              data-dshw-kanban="icon"
              aria-label={t('panel.refresh')}
              onClick={refresh}
              style={iconButtonStyle}
            >
              <IconRefreshOutline16 size={14} />
            </button>
            <button
              type="button"
              data-dshw-kanban="icon"
              aria-label={t('panel.openBrowser')}
              onClick={() => { window.open(baseUrl, '_blank') }}
              style={iconButtonStyle}
            >
              <IconRightUpOutline16 size={14} />
            </button>
            <button
              type="button"
              data-dshw-kanban="icon"
              aria-label={t('panel.close')}
              onClick={onClose}
              style={iconButtonStyle}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </span>
        </header>
        {status === 'checking' && <div style={loadingStyle}>{t('panel.loading')}</div>}
        {status === 'ready' && (
          <PrDashboard
            baseUrl={baseUrl}
            refreshKey={refreshKey}
            t={t}
            onRefresh={refresh}
          />
        )}
        {status === 'down' && (
          <div style={unreachableStyle}>
            <p style={unreachableTitleStyle}>{t('panel.unreachable.title')}</p>
            <p style={unreachableDetailStyle}>{t('panel.unreachable.detail', { url: baseUrl })}</p>
            <label style={urlFieldStyle}>
              <span style={urlLabelStyle}>{t('panel.url.label')}</span>
              <input
                data-dshw-kanban="input"
                style={urlInputStyle}
                value={draft}
                onChange={(event) => { setDraft(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') save() }}
              />
            </label>
            <button type="button" data-dshw-kanban="trigger" style={saveButtonStyle} onClick={save}>
              {t('panel.url.save')}
            </button>
          </div>
        )}
      </section>
    </div>,
    document.body,
  )
}

/* ── inline styles (tokens from the harness ui-theme variables) ─────────── */

/* The trigger mirrors the settings row exactly (ui-settings-general
   SettingsRoot.module.css .trigger): same geometry, radius, inset, hover and
   rail variants, so the two footer entries look identical. The base
   transparent background lives in the stylesheet (not inline) so the
   :hover/[data-selected] rules can paint over it. */
const triggerStyle = (wide: boolean): CSSProperties => ({
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: wide ? 'flex-start' : 'center',
  gap: wide ? 8 : 0,
  width: wide ? 'calc(100% + 4px)' : 36,
  height: wide ? 42 : 36,
  margin: wide ? '4px -2px' : '8px 0 10px',
  padding: wide ? '0 10px 0 8px' : 0,
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: wide ? 12 : '50%',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  cursor: 'pointer',
  overflow: 'hidden',
})

const labelStyle: CSSProperties = {
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}

/** Fixed overlay spanning everything to the right of the sidebar column. */
const overlayStyle = (left: number): CSSProperties => ({
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left,
  zIndex: 100,
  display: 'flex',
})

/** The panel fills the overlay edge to edge; the frame's own sidebar seam separates it. */
const panelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-base)',
  boxShadow: 'var(--dsw-shadow-lv2)',
}

const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  minHeight: 46,
  padding: '0 8px 0 16px',
  boxSizing: 'border-box',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
}

const titleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary)',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
}

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  border: 'none',
  borderRadius: 8,
  padding: 0,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-secondary)',
}

const loadingStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  color: 'var(--dsw-alias-label-tertiary)',
}

const unreachableStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 24,
  boxSizing: 'border-box',
}

const unreachableTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}

const unreachableDetailStyle: CSSProperties = {
  margin: 0,
  maxWidth: 520,
  textAlign: 'center',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}

const urlFieldStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 8,
}

const urlLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
}

const urlInputStyle: CSSProperties = {
  width: 320,
  height: 34,
  padding: '0 12px',
  boxSizing: 'border-box',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  outline: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
}

const saveButtonStyle: CSSProperties = {
  height: 34,
  padding: '0 16px',
  border: 'none',
  borderRadius: 10,
  background: 'var(--dsw-alias-state-business-primary)',
  color: '#fff',
  fontFamily: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
}
