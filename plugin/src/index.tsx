/*
 * UI reference skill: vscode-ui
 * Reference revision: 4378eb0b965339a354d357fcb5ae33d2e10bf20e
 * Reference components: SidebarTitle, ActionBar.
 * Adaptation: Compact dashboard actions and an optional expanded workspace.
 * Copyright (c) Microsoft Corporation. MIT; see ../LICENSE.vscode-ui.txt.
 */
/**
 * dshw kanban — browser half.
 *
 * Registers a standard `sidebar.panellist` entry and its `main` panel. The
 * shell owns navigation, selection and geometry; the dashboard talks to the
 * local dshw daemon API (CORS-enabled) over fetch + SSE.
 *
 * The daemon origin defaults to the dshw loopback port (7849) and can be
 * overridden per browser via localStorage (set in the panel's unreachable
 * state). Reachability is probed with a no-cors fetch, which rejects on
 * network failure without needing CORS headers from the daemon.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconCloseOutlineRegular, IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { GVsCode } from './icons.tsx'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { en, zh } from './locales.ts'
import { KanbanWorkspace } from './workspace.tsx'
import { RESPONSIVE_STYLES } from './responsive.ts'

/** Locale namespace owned by this plugin. */
const NS = 'kanban'
/** Shared identity of the sidebar entry and its main panel. */
const PANEL_ID = 'dshw-kanban'

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
[data-dshw-kanban="icon"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
[data-dshw-kanban="input"]:focus { border-color: var(--dsw-alias-state-business-primary); }
/* CommitGraph internals (Git view): keep only the graph surface, sized
   absolute at the host's origin. */
[data-dshw-kanban="gitgraph"] > div { position: relative; }
[data-dshw-kanban="gitgraph"] > div > div:first-child { overflow: visible; }
[data-dshw-kanban="gitgraph"] > div > div:nth-child(n + 2) { display: none !important; }
[data-dshw-kanban="gitgraph"] svg { position: absolute; inset: 0 auto auto 0; }
[data-dshw-kanban="gitgraph"] g[filter*="_curved_path_"] { filter: none; }
/* dshw view chrome (VS Code Light palette; style.css shortcuts) */
@keyframes dshw-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
[data-dshw-kanban="pulse"] { animation: dshw-dot-pulse 1.2s ease-in-out infinite; }
[data-dshw-kanban="row"]:hover td { background: #f0f0f0; }
/* Row hover tints every cell, the review-entry column included; the icon
   button's own hover then steps one shade darker (same step as repo-header
   hover) so it stays visible on the tinted row. */
[data-dshw-kanban="row"]:hover td[data-dshw-kanban="reviewentrycell"] .dshw-icon:hover { background: #e3e3e3; }
[data-dshw-kanban="repogroup"]:hover { background: #e3e3e3; }
[data-dshw-kanban="repogroup"] a:hover { color: #006ab1; }
[data-dshw-kanban="gitrow"]:hover { background: #f0f0f0; }
[data-dshw-kanban="gitbranch"]:hover { background: #f0f0f0; }
[data-dshw-kanban="gitbranch"][aria-pressed="true"] { background: rgba(0, 122, 204, .12); }
[data-dshw-kanban="gitchip"]:hover { background: rgba(191, 136, 3, .12); }
[data-dshw-kanban="githash"]:hover { color: #006ab1; text-decoration: underline; }
[data-dshw-kanban="gitpr"]:hover { color: #006ab1; text-decoration: underline; }
.dshw-link:hover { text-decoration: underline; }
[data-dshw-kanban="root"] .dshw-trigger { color: #616161; }
[data-dshw-kanban="root"] .dshw-trigger:hover { color: #333333; text-decoration: underline; }
[data-dshw-kanban="root"] .dshw-chip { background: transparent; }
[data-dshw-kanban="root"] .dshw-chip:hover { background: rgba(191, 136, 3, .12); }
.dshw-nav:hover { background: #f0f0f0; }
.dshw-poprow:hover { background: #f0f0f0; }
[data-dshw-kanban="loadmore"]:hover { background: #f0f0f0; }
[data-dshw-kanban="titlelink"]:hover { text-decoration: underline; }
.dshw-icon:hover { background: #f0f0f0; color: #333333; }
.dshw-danger:hover { background: rgba(161, 38, 13, .1); }
.dshw-btn-default:hover { background: #f3f3f3; }
.dshw-btn-ghost:hover { background: #f0f0f0; }
/* job-dialog composer buttons: secondary (pause/stop) outlined + hover,
   primary (send) accent + darker hover. Inline styles can't do :hover, so
   the base look lives here and the inline style keeps only non-hover props. */
[data-dshw-kanban="root"] .dshw-jobbtn { background: transparent; border: 1px solid rgba(128, 128, 128, .35); }
[data-dshw-kanban="root"] .dshw-jobbtn:hover { background: #f0f0f0; }
[data-dshw-kanban="root"] .dshw-jobbtn:disabled { opacity: .45; cursor: default; }
[data-dshw-kanban="root"] .dshw-send { background: #007acc; color: #ffffff; border: 1px solid transparent; }
[data-dshw-kanban="root"] .dshw-send:hover { background: #0069ac; }
[data-dshw-kanban="root"] .dshw-send:disabled { opacity: .45; cursor: default; }
[data-dshw-kanban="root"] .dshw-wprow:hover { background: #f0f0f0; }
[data-dshw-kanban="root"] .dshw-wpta:focus { border-color: #007acc; }
[data-dshw-kanban="row"] { transition: background-color 100ms; }
/* Review detail workspace: file tree hover/selection and diff-row focus outline. */
[data-dshw-kanban="reviewtree"]:hover { background: #f0f0f0; }
[data-dshw-kanban="reviewtree"][data-selected] { background: rgba(0, 122, 204, .16); box-shadow: inset 2px 0 0 #007acc; }
[data-dshw-kanban="modebtn"]:not([data-selected]):hover { background: #f0f0f0; }
${RESPONSIVE_STYLES}
`

/** The framework-injected locale seat type (entry `locale` option). */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** Main-panel props supplied by the locale seat and registration inject. */
interface KanbanPanelProps {
  /** Standard locale seat bound by the entry's `locale` option. */
  t: Translate
  /** Return to the current conversation through the layout service. */
  onClose: () => void
}

/** Services required before the entry activates. */
export const inject = ['slots', 'locale', 'layout']

/** Register the dashboard and let the sidebar render its standard button. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshw-kanban: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ onClose: () => { ctx.layout.selectPanel(null) } }),
  }, KanbanPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => t('action.label'),
  }, KanbanPanelIcon))
}

/** The shell supplies icon size and owns the surrounding button. */
function KanbanPanelIcon({ size }: { size: number }): ReactNode {
  return <IconBranchOutlineRegular size={size} />
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

/** Panel state: probing the daemon, embedded dashboard, or an unreachable form. */
type PanelStatus = 'checking' | 'ready' | 'down'

/** Panel: header chrome plus the native PR kanban (no iframe). */
function KanbanPanel({ t, onClose }: KanbanPanelProps): ReactNode {
  useKanbanStyles()
  const [baseUrl, setBaseUrl] = useState(readBaseUrl)
  const [draft, setDraft] = useState(baseUrl)
  const [status, setStatus] = useState<PanelStatus>('checking')
  const [refreshKey, setRefreshKey] = useState(0)
  const [codeNotice, setCodeNotice] = useState<string>()
  const codeNoticeTimer = useRef<number | undefined>(undefined)
  const panelRef = useRef<HTMLElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const scrollPositions = useRef<Array<{ node: HTMLElement; top: number; left: number }>>([])
  const expand = (): void => {
    scrollPositions.current = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('*') ?? [])
      .filter(node => node.scrollTop !== 0 || node.scrollLeft !== 0)
      .map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }))
    setExpanded(true)
  }
  const expandForDetail = (): boolean => {
    if (expanded || (panelRef.current?.clientWidth ?? 0) > 600) return false
    expand()
    return true
  }
  const collapse = (): void => {
    setExpanded(false)
    expandButton.current?.focus()
  }
  useLayoutEffect(() => {
    if (expanded) return
    // Wide tables can become shorter than their viewport and clamp scrollTop
    // to zero. Restore only surviving lists, after a diff has closed as well.
    const frame = requestAnimationFrame(() => {
      for (const { node, top, left } of scrollPositions.current) {
        if (node.isConnected) node.scrollTo({ top, left })
      }
      scrollPositions.current = []
    })
    return () => { cancelAnimationFrame(frame) }
  }, [expanded])

  const openCodeWorkspace = (): void => {
    fetch(`${baseUrl}/api/open-code`, { method: 'POST' })
      .then(async (response) => {
        const value = await response.json() as { error?: string }
        if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
        setCodeNotice(undefined)
      })
      .catch((error: unknown) => {
        setCodeNotice(`打开 VS Code 失败：${error instanceof Error ? error.message : String(error)}`)
        if (codeNoticeTimer.current !== undefined) window.clearTimeout(codeNoticeTimer.current)
        codeNoticeTimer.current = window.setTimeout(() => { setCodeNotice(undefined) }, 4_000)
      })
  }
  useEffect(() => () => { if (codeNoticeTimer.current !== undefined) window.clearTimeout(codeNoticeTimer.current) }, [])

  // Probe the daemon whenever the target changes: reachable → native kanban,
  // unreachable → the URL editor.
  useEffect(() => {
    let cancelled = false
    setStatus('checking')
    fetch(`${baseUrl}/api/state`, { mode: 'no-cors', signal: AbortSignal.timeout(8000) })
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

  return (
    <section ref={panelRef} className="dshw-panel" data-expanded={expanded || undefined} style={panelStyle} aria-label={t('panel.title')} data-dshw-kanban="root">
      <header className="dshw-panel-header" style={headerStyle}>
        <span className="dshw-title-group" style={titleGroupStyle}>
          <span className="dshw-logo" style={logoStyle}>dw</span>
          <span style={titleStyle}>dshw</span>
          <span className="dshw-subtitle" style={subtitleStyle}>DeepSeek Harness workflow</span>
        </span>
        <span style={actionsStyle}>
          <button
            ref={expandButton}
            type="button"
            className="dshw-icon dshw-expand-control"
            aria-label={t(expanded ? 'panel.collapse' : 'panel.expand')}
            title={t(expanded ? 'panel.collapse' : 'panel.expand')}
            aria-pressed={expanded}
            onClick={() => { if (expanded) collapse(); else expand() }}
            style={iconButtonStyle}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
              <path d={expanded ? 'M2 6h4V2m8 8h-4v4M6 6 1 1m9 9 5 5' : 'M1 6V1h5m9 9v5h-5M1 1l5 5m9 9-5-5'} />
            </svg>
          </button>
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label={t('panel.code')}
            title={t('panel.code')}
            onClick={openCodeWorkspace}
            style={iconButtonStyle}
          >
            <GVsCode size={17.5} />
          </button>
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label={t('panel.refresh')}
            onClick={refresh}
            style={iconButtonStyle}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label={t('panel.close')}
            data-panel-action="close"
            onClick={onClose}
            style={iconButtonStyle}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </span>
      </header>
      {codeNotice !== undefined && <div role="status" style={codeNoticeStyle}>{codeNotice}</div>}
      {status === 'checking' && <div style={loadingStyle}>{t('panel.loading')}</div>}
      {status === 'ready' && (
        <KanbanWorkspace
          baseUrl={baseUrl}
          refreshKey={refreshKey}
          t={t}
            onRefresh={refresh}
            expanded={expanded}
            expandForDetail={expandForDetail}
            onCollapse={collapse}
        />
      )}
      {status === 'down' && (
        <div style={unreachableStyle}>
          <p style={unreachableTitleStyle}>{t('panel.unreachable.title')}</p>
          <p style={unreachableDetailStyle}>{t('panel.unreachable.detail', { url: baseUrl })}</p>
          <label className="dshw-url-field" style={urlFieldStyle}>
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
  )
}

/* ── inline styles (tokens from the harness ui-theme variables) ─────────── */

/** Fill the shell-owned main column. */
const panelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: '#ffffff',
}

const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minHeight: 36,
  padding: '0 8px 0 max(12px, var(--dsh-frame-leading-clearance, 0px))',
  boxSizing: 'border-box',
  borderBottom: '1px solid #e7e7e7',
  background: '#dddddd',
}

const titleGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const logoStyle: CSSProperties = {
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  width: 18,
  height: 18,
  borderRadius: 4,
  background: '#007acc',
  color: '#ffffff',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '-0.02em',
}

const titleStyle: CSSProperties = {
  flex: 'none',
  fontSize: 13,
  fontWeight: 600,
  lineHeight: '20px',
  color: '#333333',
}

const subtitleStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
  color: '#616161',
}

const codeNoticeStyle: CSSProperties = {
  minWidth: 0,
  padding: '6px 12px',
  overflowWrap: 'anywhere',
  fontSize: 11.5,
  color: '#a1260d',
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
  color: '#616161',
}

const loadingStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  color: '#717171',
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
  color: '#333333',
}

const unreachableDetailStyle: CSSProperties = {
  margin: 0,
  maxWidth: 520,
  textAlign: 'center',
  fontSize: 12,
  lineHeight: '18px',
  color: '#616161',
}

const urlFieldStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 8,
}

const urlLabelStyle: CSSProperties = {
  fontSize: 12,
  color: '#616161',
}

const urlInputStyle: CSSProperties = {
  width: 320,
  height: 34,
  padding: '0 12px',
  boxSizing: 'border-box',
  border: '1px solid #e7e7e7',
  borderRadius: 4,
  outline: 'none',
  background: '#ffffff',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: '#333333',
}

const saveButtonStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: '#007acc',
  color: '#fff',
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
