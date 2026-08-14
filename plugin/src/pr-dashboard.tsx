/**
 * Native PR kanban — the dshw dashboard's Pull requests view rendered
 * directly in the harness shell (no iframe). Talks to the local dshw daemon
 * API (CORS-enabled) over fetch + SSE, and drives the same PR actions the
 * standalone UI exposes. Other dshw views (Reviews / Git / Jobs / Logs /
 * Settings) remain reachable via the panel's "open in browser" action until
 * they are ported.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBranchOutline16, IconInspectOutline12,
  IconListPenOutline16, IconSettingsOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CommitGraph } from '@dreamcatcher-tech/commit-graph'
import type {
  CiCheck, CloneGitStatus, CloneRecord, DshWorkerProgress, EventRecord, GitGraphBranch,
  GitGraphSnapshot, HarnessRepositoryStatus, DshwRepositoryStatus, JobPage, JobRecord, LogPage,
  PrDashboardRecord, PrDashboardStatus, PullRequestReview, ReviewRequestRecord, ServiceState,
  WorkerConfig, WorkerConfigInput, WorkerModelCatalog, WorkerReasoningEffort,
  WorkerTypeAvailability, WorktreeCleanupCandidate, WorktreeCleanupPreview,
} from '../../src/types.ts'

/** Status accent (ui/src/types.ts Tone). */
type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'

/** Snapshot shape served by GET /api/state (mirrors ui/src/types.ts). */
export interface KanbanSnapshot extends Omit<ServiceState, 'prDashboardCache'> {
  service: {
    startedAt?: string
    draining: boolean
    activeJobs: number
    port: number
    devMode: boolean
    updatingDshw: boolean
    rateLimited: boolean
    rateLimitResetAt?: string
  }
  clones: CloneRecord[]
  worktreeCleanupCount?: number
  prs: PrDashboardRecord[]
  prDashboard: PrDashboardStatus
  reviewRequests: ReviewRequestRecord[]
  reviewRequestsStatus: PrDashboardStatus
  jobProgress: Record<string, DshWorkerProgress>
  workers: WorkerConfig[]
  workerTypes: WorkerTypeAvailability[]
  harnessRepository: HarnessRepositoryStatus
  dshwRepository: DshwRepositoryStatus
}

/** One PR action the kanban can dispatch. */
export type PrAction = 'merge-base' | 'merge-base-direct' | 'fix-ci' | 'resolve-comments'

/** Local git maintenance action (LocalGitStatus port). */
type GitAction = 'discard-unstaged' | 'discard-staged' | 'abort-merge' | 'discard-unpushed' | 'pull'

/* ── labels / small derivations (ports of ui/src/format.ts + pr-job-state.ts) ── */

const ciLabel = (value: string): string => ({ passed: '通过', failed: '失败', pending: '运行中', none: '无检查' })[value] ?? value
const reviewLabel = (value: string): string => ({ APPROVED: '已批准', CHANGES_REQUESTED: '需修改', REVIEW_REQUIRED: '待 review' })[value] ?? '无要求'
const mergeLabel = (value: string): string => ({ MERGEABLE: '可合并', CONFLICTING: '冲突', UNKNOWN: '计算中' })[value] ?? value

/* ── dshw design tokens (ui/src/style.css — VS Code Light Modern palette) ── */

const C_SURFACE = '#ffffff'
const C_TEXT = '#333333'
const C_SECONDARY = '#616161'
const C_MUTED = '#717171'
const C_FAINT = '#9a9a9a'
const C_LINK = '#006ab1'
const C_ACCENT = '#007acc'
const C_ACCENT_SOFT = 'rgba(0, 122, 204, .12)'
const C_SUCCESS = '#388a34'
const C_WARNING = '#bf8803'
const C_DANGER = '#a1260d'
const C_HOVER = '#f0f0f0'
const C_WIDGET = '#f3f3f3'
const C_BORDER = '#e7e7e7'
const C_BADGE = '#c4c4c4'
const C_BADGE_FG = '#333333'
const C_WARN_SOFT = 'rgba(191, 136, 3, .12)'
const C_OVERLAY = 'rgba(0, 0, 0, .32)'
const C_SHADOW_POP = '0 4px 16px rgba(0, 0, 0, .16), 0 0 2px rgba(0, 0, 0, .08)'
const FONT_MONO = 'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace'

/* Semantic status colors (uno.config.ts st-*): text uses muted for neutral. */
const ok = C_SUCCESS
const warn = C_WARNING
const bad = C_DANGER

const toneColor = (tone: Tone): string => tone === 'ok' ? C_SUCCESS : tone === 'warn' ? C_WARNING : tone === 'bad' ? C_DANGER : tone === 'accent' ? C_ACCENT : C_MUTED

/** Lucide stroke-icon base (24px grid, currentColor; Icon.vue presetIcons). */
function Lucide({ size = 15, children }: { size?: number; children: ReactNode }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Status glyph (StatusIcon.vue port): circle-check / circle-x / circle-dashed / circle-dot. */
function StatusIcon({ tone, size = 13 }: { tone: Tone; size?: number }): ReactNode {
  const color = tone === 'ok' ? C_SUCCESS : tone === 'bad' ? C_DANGER : tone === 'warn' ? C_WARNING : C_FAINT
  return (
    <span style={{ display: 'inline-flex', flex: 'none', color }} aria-hidden="true">
      <Lucide size={size}>
        {tone === 'ok' && (<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>)}
        {tone === 'bad' && (<><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>)}
        {tone === 'warn' && (
          <>
            <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
            <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
            <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
            <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
            <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
            <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
            <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
            <path d="M6.391 3.721a10 10 0 0 1 2.69 2.7" />
          </>
        )}
        {tone === 'neutral' && (<><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1" /></>)}
        {tone === 'accent' && (<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>)}
      </Lucide>
    </span>
  )
}

/** Colored status dot (StatusDot.vue port; jobs / busy / loading states). */
function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }): ReactNode {
  const color = tone === 'ok' ? C_SUCCESS : tone === 'warn' ? C_WARNING : tone === 'bad' ? C_DANGER : tone === 'accent' ? C_ACCENT : C_FAINT
  return (
    <span
      data-dshw-kanban={pulse === true ? 'pulse' : undefined}
      aria-hidden="true"
      style={{ display: 'inline-block', flex: 'none', width: 8, height: 8, borderRadius: '50%', background: color }}
    />
  )
}

/** Common lucide glyphs used across the views (Icon.vue names). */
const GPlus = ({ size = 12 }: { size?: number }): ReactNode => <Lucide size={size}><path d="M5 12h14" /><path d="M12 5v14" /></Lucide>
const GPencil = ({ size = 12 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </Lucide>
)
const GTrash = ({ size = 12 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </Lucide>
)
const GKey = ({ size = 11 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
    <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
  </Lucide>
)
const GGrip = ({ size = 13 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="9" cy="12" r="1" />
    <circle cx="9" cy="5" r="1" />
    <circle cx="9" cy="19" r="1" />
    <circle cx="15" cy="12" r="1" />
    <circle cx="15" cy="5" r="1" />
    <circle cx="15" cy="19" r="1" />
  </Lucide>
)
const GDownload = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </Lucide>
)
const GSync = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </Lucide>
)
const GReset = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </Lucide>
)
const GWorktree = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
    <path d="M12 12v3" />
  </Lucide>
)
const GRepository = ({ size = 14 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-9a2 2 0 0 0-2 2Z" />
    <circle cx="13" cy="12" r="2" />
  </Lucide>
)
const GAlert = ({ size = 13 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="8" y2="12" />
    <line x1="12" x2="12.01" y1="16" y2="16" />
  </Lucide>
)
const GClose = ({ size = 15 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Lucide>
)
const GGitGraph = ({ size = 15 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <circle cx="5" cy="6" r="3" />
    <path d="M5 9v6" />
    <circle cx="5" cy="18" r="3" />
    <path d="M12 3v18" />
    <circle cx="19" cy="6" r="3" />
    <path d="M16 15.7A9 9 0 0 0 19 9" />
  </Lucide>
)
const GSettings = ({ size = 15 }: { size?: number }): ReactNode => (
  <Lucide size={size}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Lucide>
)

const ciTone = (value: string): Tone => value === 'passed' ? 'ok' : value === 'failed' ? 'bad' : value === 'pending' ? 'warn' : 'neutral'
const reviewTone = (value: string): Tone => value === 'APPROVED' ? 'ok' : value === 'CHANGES_REQUESTED' ? 'bad' : 'neutral'
const mergeTone = (value: string): Tone => value === 'MERGEABLE' ? 'ok' : value === 'CONFLICTING' ? 'bad' : 'neutral'

/** conflict → agent merge; mergeable but behind base → direct merge+push. */
function mergeAction(pr: PrDashboardRecord): PrAction | undefined {
  if (pr.mergeable === 'CONFLICTING') return 'merge-base'
  if (pr.mergeable === 'MERGEABLE' && pr.baseBehind === true) return 'merge-base-direct'
  return undefined
}

/** 冲突但处于 base push 后的静默期：到点会自动开始合并。 */
function autoMergeAt(pr: PrDashboardRecord): string | undefined {
  if (pr.mergeable !== 'CONFLICTING' || pr.syncEnabled !== true || pr.pendingBaseCheckAt === undefined) return undefined
  return Date.parse(pr.pendingBaseCheckAt) > Date.now() ? pr.pendingBaseCheckAt : undefined
}

function autoMergeMinutes(pr: PrDashboardRecord): number {
  const at = autoMergeAt(pr)
  return at === undefined ? 0 : Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 60_000))
}

function belongsToPr(job: JobRecord, pr: PrDashboardRecord): boolean {
  return (pr.syncId !== undefined && job.syncId === pr.syncId)
    || job.summary.startsWith(`${pr.cloneName} / PR #${pr.number}`)
}

function findBusyJob(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  const running = jobs.filter(job => job.status === 'running' && belongsToPr(job, pr))
  return running.find(job => job.type === 'fix-ci' || job.type === 'merge-base') ?? running[0]
}

function findWorkingAgent(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  return jobs.find(job => job.status === 'running' && job.dshWorker !== undefined && belongsToPr(job, pr))
}

function busyLabel(job?: JobRecord): string {
  return job?.type === 'fix-ci' ? '修复 CI' : job?.type === 'merge-base' ? '合并 base' : job?.type === 'resolve-comments' ? '解决评论' : '检查状态'
}

function lastFailedMerge(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  const failed = jobs.filter(job => (
    job.syncId === pr.syncId
    && job.type === 'merge-base'
    && (job.status === 'failed' || job.status === 'blocked')
  ))
  return failed.at(-1)
}

function hasLocalGitStatus(pr: PrDashboardRecord): boolean {
  const status = pr.localGitStatus
  return status !== undefined && (status.unstaged || status.staged || status.merging || status.ahead > 0 || status.behind > 0)
}

/* ── data channel: /api/state poll + /api/events SSE (use-workflow port) ── */

function useKanbanData(baseUrl: string, refreshKey: number): { snapshot?: KanbanSnapshot; connection: 'connecting' | 'live' | 'reconnecting' } {
  const [snapshot, setSnapshot] = useState<KanbanSnapshot>()
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  useEffect(() => {
    let cancelled = false
    setConnection('connecting')
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`${baseUrl}/api/state`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const value = await response.json() as KanbanSnapshot
        if (!cancelled) setSnapshot(value)
      } catch {
        if (!cancelled) setConnection('reconnecting')
      }
    }
    void load()
    const poll = window.setInterval(() => { void load() }, 30_000)
    const events = new EventSource(`${baseUrl}/api/events`)
    events.onopen = () => { if (!cancelled) setConnection('live') }
    events.onmessage = (event) => {
      if (cancelled) return
      try { setSnapshot(JSON.parse((event as MessageEvent<string>).data) as KanbanSnapshot) } catch { /* malformed frame: keep last snapshot */ }
    }
    events.addEventListener('progress', (event) => {
      if (cancelled) return
      try {
        const progress = JSON.parse((event as MessageEvent<string>).data) as Record<string, DshWorkerProgress>
        setSnapshot(previous => previous === undefined ? previous : { ...previous, jobProgress: progress })
      } catch { /* malformed frame */ }
    })
    events.onerror = () => { if (!cancelled) setConnection('reconnecting') }
    return () => {
      cancelled = true
      window.clearInterval(poll)
      events.close()
    }
  }, [baseUrl, refreshKey])
  return { snapshot, connection }
}

/* ── tiny primitives ── */

/** Hover popover anchored near the trigger (Teleport port of the Vue popovers). */
function HoverPopover({ label, width, children, render, maxHeight }: {
  label: string
  width: number
  children: (open: boolean, setOpen: (v: boolean) => void) => ReactNode
  render: (close: () => void) => ReactNode
  maxHeight: number
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

/* ── shared view props + the tabbed workspace ── */

/** Props shared by every kanban view (data + verbs owned by the workspace). */
interface ViewProps {
  baseUrl: string
  snapshot?: KanbanSnapshot
  connection: 'connecting' | 'live' | 'reconnecting'
  pending: ReadonlySet<string>
  showToast: (message: string, bad?: boolean) => void
  post: (path: string, body: object, key: string) => Promise<void>
  refresh: () => void
  /** Open the worker picker for a PR action (right-click / unavailable default). */
  openWorkerPicker: (cloneName: string, action: PrAction) => void
}

type ViewId = 'prs' | 'reviews' | 'git' | 'jobs' | 'logs' | 'settings'

const VIEW_TABS: ReadonlyArray<{ id: ViewId; icon: (p: { size?: number }) => ReactNode; label: string; count: (s: KanbanSnapshot) => number }> = [
  { id: 'prs', icon: IconBranchOutline16, label: 'Pull requests', count: s => s.prs.length },
  { id: 'reviews', icon: IconUserOutline16, label: 'Reviews', count: s => s.reviewRequests.length },
  { id: 'git', icon: GGitGraph, label: 'Git', count: () => 0 },
  { id: 'jobs', icon: IconListPenOutline16, label: 'Jobs', count: s => s.service.activeJobs },
  { id: 'logs', icon: IconInspectOutline12, label: 'Logs', count: () => 0 },
  { id: 'settings', icon: IconSettingsOutline16, label: 'Settings', count: () => 0 },
]

/** Tabbed workspace: owns the data channel, action plumbing and the tab bar;
 *  every view is presentational over {@link ViewProps}. */
export function KanbanWorkspace({ baseUrl, refreshKey, t, onRefresh }: {
  baseUrl: string
  refreshKey: number
  t: (key: string, params?: Record<string, string | number>) => string
  onRefresh?: () => void
}): ReactNode {
  const { snapshot, connection } = useKanbanData(baseUrl, refreshKey)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<{ message: string; bad: boolean } | null>(null)
  const [workerPick, setWorkerPick] = useState<{ cloneName: string; action: PrAction } | null>(null)
  const [view, setView] = useState<ViewId>('prs')
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = (message: string, bad = false): void => {
    setToast({ message, bad })
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { setToast(null) }, 2_600)
  }
  useEffect(() => () => { if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current) }, [])

  const post = async (path: string, body: object, key: string): Promise<void> => {
    if (pending.has(key)) return
    setPending(previous => new Set(previous).add(key))
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? '请求失败')
      showToast('操作已提交')
    } catch (error) {
      showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setPending(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  const refresh = (): void => {
    onRefresh?.()
    void post('/api/prs/refresh', {}, 'prs-refresh')
  }

  const openWorkerPicker = (cloneName: string, action: PrAction): void => {
    const usable = snapshot?.workers.some(worker => worker.enabled
      && snapshot.workerTypes.find(status => status.type === worker.type)?.available === true) === true
    if (!usable) {
      showToast('请先添加可用的 Worker', true)
      return
    }
    setWorkerPick({ cloneName, action })
  }

  const startWithWorker = (workerConfigId: string, additionalInstruction: string): void => {
    const launch = workerPick
    if (launch === null) return
    setWorkerPick(null)
    void post('/api/pr-action', {
      name: launch.cloneName,
      action: launch.action,
      workerConfigId,
      additionalInstruction: additionalInstruction.trim(),
    }, `${launch.action}:${launch.cloneName}`)
  }

  const viewProps: ViewProps = {
    baseUrl,
    snapshot,
    connection,
    pending,
    showToast,
    post,
    refresh,
    openWorkerPicker,
  }

  return (
    <div style={rootStyle} data-dshw-kanban="root">
      <div style={tabbarStyle} role="tablist" aria-label="dshw views">
        {VIEW_TABS.map(tab => {
          const active = view === tab.id
          const count = snapshot === undefined ? 0 : tab.count(snapshot)
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-selected={active || undefined}
              onClick={() => { setView(tab.id) }}
              style={tabStyle(active)}
            >
              <Icon size={14} />
              <span>{tab.label}</span>
              {count > 0 && <span style={tabCountStyle}>{count}</span>}
            </button>
          )
        })}
      </div>
      <div style={viewAreaStyle}>
        {view === 'prs' && <PrsView {...viewProps} />}
        {view === 'reviews' && <ReviewsView {...viewProps} />}
        {view === 'jobs' && <JobsView {...viewProps} />}
        {view === 'logs' && <LogsView {...viewProps} />}
        {view === 'git' && <GitView baseUrl={baseUrl} refreshKey={refreshKey} />}
        {view === 'settings' && <SettingsView {...viewProps} />}
      </div>
      {workerPick !== null && snapshot !== undefined && (
        <WorkerPicker
          workers={snapshot.workers}
          workerTypes={snapshot.workerTypes}
          onClose={() => { setWorkerPick(null) }}
          onPick={startWithWorker}
        />
      )}
      {toast !== null && <div style={toastStyle} role="status">{toast.message}</div>}
    </div>
  )
}

/* ── Pull requests view ── */

function PrsView({ snapshot, connection, pending, showToast, post, refresh, openWorkerPicker }: ViewProps): ReactNode {
  const busyByPr = new Map(snapshot?.prs.map(pr => [pr, findBusyJob(pr, snapshot.jobs)]) ?? [])
  const workingAgentByPr = new Map(snapshot?.prs.map(pr => [pr, findWorkingAgent(pr, snapshot.jobs)]) ?? [])
  const prs = snapshot?.prs ?? []
  const status = snapshot?.prDashboard

  const runPrAction = (cloneName: string, action: PrAction): void => {
    if (action === 'merge-base-direct') {
      void post('/api/pr-action', { name: cloneName, action }, `merge-base-direct:${cloneName}`)
      return
    }
    const defaultWorker = snapshot?.workers.find(worker => worker.enabled)
    if (defaultWorker === undefined) {
      showToast('请先添加可用的 Worker', true)
      return
    }
    const available = snapshot?.workerTypes.find(status => status.type === defaultWorker.type)?.available === true
    if (available !== true) {
      openWorkerPicker(cloneName, action)
      return
    }
    void post('/api/pr-action', { name: cloneName, action }, `${action}:${cloneName}`)
  }

  return (
    <>
      {status !== undefined && status.state === 'error' && (
        <div style={errorStripStyle}>
          <span style={{ display: 'inline-flex', flex: 'none', color: warn }}><GAlert size={13} /></span>
          <span style={errorStripTextStyle}>PR 状态刷新失败，正在显示上次可用数据</span>
        </div>
      )}
      {status !== undefined && status.state === 'loading' && prs.length > 0 && (
        <div style={loadingStripStyle}>
          <StatusDot tone="accent" pulse />
          <span>正在刷新上次保存的 PR 状态</span>
        </div>
      )}
      <div style={tableScrollStyle}>
        {snapshot === undefined && (
          <div style={emptyStateStyle}>
            <span style={emptyStateLineStyle}>
              <StatusDot tone="accent" pulse />
              <span>{connection === 'reconnecting' ? '正在重新连接 dshw daemon…' : '正在加载追踪中的 PR…'}</span>
            </span>
          </div>
        )}
        {snapshot !== undefined && prs.length === 0 && (
          <div style={emptyStateStyle}>
            <p style={emptyStateTitleStyle}>暂无追踪中的 PR</p>
            <p style={emptyStateSubStyle}>GitHub 上你创建的 open PR 会被自动克隆并显示在这里</p>
          </div>
        )}
        {snapshot !== undefined && prs.length > 0 && (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Pull request</th>
                <th style={{ ...thStyle, width: 210 }}>CI</th>
                <th style={{ ...thStyle, width: 210 }}>Review</th>
                <th style={{ ...thStyle, width: 210 }}>Merge</th>
                <th style={{ ...thStyle, width: 210 }}>Sync</th>
              </tr>
            </thead>
            <tbody>
              {prs.map(pr => (
                <PrRow
                  key={`${pr.repoSlug}-${pr.number}-${pr.cloneName}`}
                  pr={pr}
                  jobs={snapshot.jobs}
                  busy={busyByPr.get(pr)}
                  workingAgent={workingAgentByPr.get(pr)}
                  pending={pending}
                  onAction={runPrAction}
                  onChooseWorker={openWorkerPicker}
                  onToggleSync={(name, enabled) => { void post('/api/sync/toggle', { name, enabled }, `sync-toggle:${name}`) }}
                  onGitAction={(name, action) => { void post('/api/clone/maintenance', { name, action }, `git-maintenance:${name}`) }}
                  onRefresh={refresh}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/* ── Reviews view (ReviewRequests.vue port) ── */

function ReviewsView({ snapshot, connection }: ViewProps): ReactNode {
  const requests = [...(snapshot?.reviewRequests ?? [])]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const status = snapshot?.reviewRequestsStatus
  return (
    <>
      {status !== undefined && status.state === 'error' && (
        <div style={errorStripStyle}>
          <span style={{ display: 'inline-flex', flex: 'none', color: warn }}><GAlert size={13} /></span>
          <span style={errorStripTextStyle}>Reviews 刷新失败，正在显示上次可用数据</span>
        </div>
      )}
      {status !== undefined && status.state === 'loading' && requests.length > 0 && (
        <div style={loadingStripStyle}>
          <StatusDot tone="accent" pulse />
          <span>正在刷新上次保存的 Reviews</span>
        </div>
      )}
      <div style={tableScrollStyle}>
        {snapshot === undefined && (
          <div style={emptyStateStyle}>
            <span style={emptyStateLineStyle}>
              <StatusDot tone="accent" pulse />
              <span>{connection === 'reconnecting' ? '正在重新连接 dshw daemon…' : '正在加载待 review 的 PR…'}</span>
            </span>
          </div>
        )}
        {snapshot !== undefined && requests.length === 0 && (
          <div style={emptyStateStyle}>
            <p style={emptyStateTitleStyle}>没有待你 review 的 PR</p>
            <p style={emptyStateSubStyle}>GitHub 上 request 你 review 的 open PR 会显示在这里</p>
          </div>
        )}
        {snapshot !== undefined && requests.length > 0 && (
          <table style={{ ...tableStyle, minWidth: 600 }}>
            <thead>
              <tr>
                <th style={thStyle}>Pull request</th>
                <th style={{ ...thStyle, width: 160 }}>作者</th>
                <th style={{ ...thStyle, width: 110 }}>更新于</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(pr => (
                <tr key={pr.number}>
                  <td style={tdStyle}>
                    <div style={cellMainStyle}>
                      <a style={titleLinkStyle} data-dshw-kanban="titlelink" href={pr.url} title={pr.title} target="_blank" rel="noreferrer">
                        <span style={numberStyle}>#{pr.number}</span>
                        <span style={{ ...titleStyle, ...(pr.isDraft ? { color: C_SECONDARY } : {}) }}>{pr.title}</span>
                      </a>
                      {pr.isDraft && <span style={draftBadgeStyle}>草稿</span>}
                    </div>
                    <div style={cellSubStyle} title={pr.headRefName}>{pr.headRefName} → {pr.baseRefName}</div>
                  </td>
                  <td style={tdStyle}><span style={authorStyle}>@{pr.author}</span></td>
                  <td style={tdStyle}><span style={timeStyle}>{relativeTimeLabel(pr.updatedAt)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/* ── Jobs view (JobsTable.vue port) ── */

function JobsView({ baseUrl, snapshot, pending, post }: ViewProps): ReactNode {
  const [records, setRecords] = useState<JobRecord[]>(() =>
    sortJobs((snapshot?.jobs ?? []).filter(job => job.type !== 'sync-check')))
  const [cursor, setCursor] = useState<string>()
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<JobRecord>()
  const scroller = useRef<HTMLDivElement>(null)

  // Live merge: snapshot.jobs is the authoritative running/current set.
  useEffect(() => {
    if (snapshot === undefined) return
    setRecords(previous => mergeJobs(previous, snapshot.jobs.filter(job => job.type !== 'sync-check')))
  }, [snapshot])

  const fetchPage = async (before?: string): Promise<JobPage> => {
    const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
    const response = await fetch(`${baseUrl}/api/jobs${query}`)
    const value = await response.json() as JobPage & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }

  const loadMore = async (): Promise<void> => {
    if (loading || !hasMore) return
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(cursor)
      setRecords(previous => mergeJobs(previous, page.records))
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const loadInitial = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage()
      setRecords(previous => mergeJobs(previous, page.records))
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadInitial() }, [baseUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = (): void => {
    const element = scroller.current
    if (element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 48) void loadMore()
  }

  return (
    <>
      {records.length === 0 && !loading && (
        <div style={emptyStateStyle}>
          <span>{error ? `任务加载失败：${error}` : '暂无任务'}</span>
          {error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadInitial}>重试</button>}
        </div>
      )}
      {records.length > 0 && (
        <div ref={scroller} style={jobsScrollStyle} onScroll={onScroll}>
          <table style={{ ...tableStyle, minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 110 }}>状态</th>
                <th style={{ ...thStyle, width: 100 }}>目标</th>
                <th style={{ ...thStyle, width: 120 }}>执行者</th>
                <th style={thStyle}>任务</th>
                <th style={{ ...thStyle, width: 100 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {records.map(job => {
                const sync = job.dshWorker?.sync ?? snapshot?.syncs.find(candidate => candidate.id === job.syncId)
                const target = sync === undefined ? '全局' : `#${sync.prNumber}`
                const targetTitle = sync === undefined ? '不针对特定 PR' : `${sync.repoSlug}#${sync.prNumber}\n${sync.branch} → ${sync.baseRefName}`
                return (
                  <tr
                    key={job.id}
                    data-dshw-kanban="row"
                    tabIndex={0}
                    onClick={() => { setSelected(job) }}
                    onKeyDown={event => { if (event.key === 'Enter') setSelected(job) }}
                  >
                    <td style={tdCompactStyle}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap', color: toneColor(jobTone(job.status)) }}>
                        <StatusDot tone={jobTone(job.status)} pulse={job.status === 'running'} />
                        {jobLabel(job.status)}
                      </span>
                    </td>
                    <td style={tdCompactStyle}>
                      <span style={cellBlockStyle} title={targetTitle}>{target}</span>
                    </td>
                    <td style={tdCompactStyle}>
                      <span style={cellBlockStyle} title={jobExecutor(job)}>{jobExecutor(job)}</span>
                    </td>
                    <td style={tdCompactStyle}>
                      <div style={cellNoteRowStyle}>
                        <span style={jobSummaryStyle} title={job.summary}>{kindLabel(job.type)}</span>
                        {job.status === 'running' && (
                          <button
                            type="button"
                            style={dangerButtonStyle}
                            disabled={job.cancelRequestedAt !== undefined || pending.has(`cancel:${job.id}`)}
                            onClick={(event) => { event.stopPropagation(); void post('/api/jobs/cancel', { jobId: job.id }, `cancel:${job.id}`) }}
                          >{job.cancelRequestedAt !== undefined ? '终止中' : '终止'}</button>
                        )}
                      </div>
                    </td>
                    <td style={tdCompactStyle}>
                      <time style={timeStyle}>{shortTimeLabel(job.finishedAt ?? job.startedAt ?? job.createdAt)}</time>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={jobsFooterStyle}>
            {loading && <span>正在加载更多任务…</span>}
            {!loading && error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载失败，重试</button>}
            {!loading && error === '' && !hasMore && <span>已显示全部任务</span>}
            {!loading && error === '' && hasMore && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载更多任务</button>}
          </div>
        </div>
      )}
      {selected !== undefined && (
        <JobDialog
          job={selected}
          baseUrl={baseUrl}
          pending={pending}
          post={post}
          onClose={() => { setSelected(undefined) }}
        />
      )}
    </>
  )
}

/** Simplified job detail: status, summary, output tail, cancel/pause/steer. */
function JobDialog({ job, baseUrl, pending, post, onClose }: {
  job: JobRecord
  baseUrl: string
  pending: ReadonlySet<string>
  post: (path: string, body: object, key: string) => Promise<void>
  onClose: () => void
}): ReactNode {
  const [output, setOutput] = useState<string>()
  const [steerDraft, setSteerDraft] = useState('')
  useEffect(() => {
    let cancelled = false
    fetch(`${baseUrl}/api/jobs/output?jobId=${encodeURIComponent(job.id)}`)
      .then(response => response.json() as Promise<{ output?: string }>)
      .then(value => { if (!cancelled) setOutput(value.output ?? '') })
      .catch(() => { if (!cancelled) setOutput('') })
    return () => { cancelled = true }
  }, [baseUrl, job.id])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  const steer = (): void => {
    if (steerDraft.trim() === '') return
    void post('/api/jobs/steer', { jobId: job.id, prompt: steerDraft.trim() }, `steer:${job.id}`)
    setSteerDraft('')
  }
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <section style={jobDialogStyle} role="dialog" aria-modal="true" aria-label={kindLabel(job.type)}>
        <header style={dialogHeaderStyle}>
          <span style={jobDialogTitleStyle}>{kindLabel(job.type)}</span>
          <span style={{ ...jobDialogStatusStyle, color: toneColor(jobTone(job.status)) }}>
            <StatusDot tone={jobTone(job.status)} pulse={job.status === 'running'} />
            {jobLabel(job.status)}
          </span>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}><GClose size={15} /></button>
        </header>
        <div style={jobDialogMetaStyle} title={job.summary}>{job.summary}</div>
        <div style={jobOutputStyle}>
          <pre style={jobOutputPreStyle}>{output ?? '正在读取输出…'}</pre>
        </div>
        <footer style={jobDialogFooterStyle}>
          {job.status === 'running' && (
            <>
              <button
                type="button"
                className="dshw-btn-ghost"
                style={dialogActionButtonStyle}
                disabled={pending.has(`pause:${job.id}`)}
                onClick={() => { void post('/api/jobs/pause', { jobId: job.id }, `pause:${job.id}`) }}
              >暂停</button>
              <button
                type="button"
                style={dangerButtonStyle}
                disabled={job.cancelRequestedAt !== undefined || pending.has(`cancel:${job.id}`)}
                onClick={() => { void post('/api/jobs/cancel', { jobId: job.id }, `cancel:${job.id}`) }}
              >{job.cancelRequestedAt !== undefined ? '终止中' : '终止'}</button>
              <input
                style={steerInputStyle}
                placeholder="发送指令（Steer）"
                value={steerDraft}
                onChange={event => { setSteerDraft(event.target.value) }}
                onKeyDown={event => { if (event.key === 'Enter') steer() }}
              />
              <button type="button" style={dialogActionButtonStyle} disabled={steerDraft.trim() === ''} onClick={steer}>发送</button>
            </>
          )}
          <button type="button" className="dshw-btn-ghost" style={dialogCancelStyle} onClick={onClose}>关闭</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

/* ── Logs view (LogPanel.vue port) ── */

function LogsView({ baseUrl, snapshot, connection }: ViewProps): ReactNode {
  const [records, setRecords] = useState<EventRecord[]>([])
  const [cursor, setCursor] = useState<string>()
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<EventRecord>()
  const scroller = useRef<HTMLDivElement>(null)

  // Merge only records newer than the newest known (LogPanel.vue mergeLive).
  useEffect(() => {
    if (snapshot === undefined) return
    setRecords(previous => {
      const newest = previous[0]
      if (newest === undefined) return previous
      const incoming = snapshot.events
      const newestIndex = incoming.findIndex(record => record.id === newest.id)
      const fresh = newestIndex >= 0
        ? incoming.slice(newestIndex + 1)
        : incoming.filter(record => Date.parse(record.time) > Date.parse(newest.time))
      return fresh.length > 0 ? mergeRecords(previous, fresh) : previous
    })
  }, [snapshot])

  const fetchPage = async (before?: string): Promise<LogPage> => {
    const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
    const response = await fetch(`${baseUrl}/api/logs${query}`)
    const value = await response.json() as LogPage & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }

  const loadMore = async (): Promise<void> => {
    if (loading || !hasMore) return
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(cursor)
      setRecords(previous => mergeRecords(previous, page.records))
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const loadInitial = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage()
      setRecords(sortRecords(page.records))
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadInitial() }, [baseUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = (): void => {
    const element = scroller.current
    if (element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 48) void loadMore()
  }

  return (
    <>
      {records.length === 0 && !loading && (
        <div style={emptyStateStyle}>
          <span>{error ? `日志加载失败：${error}` : '暂无日志'}</span>
          {error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadInitial}>重试</button>}
        </div>
      )}
      {records.length > 0 && (
        <div ref={scroller} style={jobsScrollStyle} onScroll={onScroll}>
          <table style={{ ...tableStyle, minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 110 }}>级别</th>
                <th style={{ ...thStyle, width: 130 }}>来源</th>
                <th style={thStyle}>日志</th>
                <th style={{ ...thStyle, width: 100 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {records.map(record => (
                <tr
                  key={record.id}
                  data-dshw-kanban="row"
                  tabIndex={0}
                  role="button"
                  aria-label={`查看日志详情：${record.message}`}
                  onClick={() => { setSelected(record) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(record) }
                  }}
                >
                  <td style={tdCompactStyle}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap', color: toneColor(levelTone(record.level)) }}>
                      <StatusDot tone={levelTone(record.level)} />
                      {levelLabel(record.level)}
                    </span>
                  </td>
                  <td style={tdCompactStyle}>
                    <span style={cellBlockStyle} title={record.kind}>{record.kind}</span>
                  </td>
                  <td style={tdCompactStyle}>
                    <span style={logMessageStyle} title={record.message}>{record.message}</span>
                  </td>
                  <td style={tdCompactStyle}>
                    <time style={timeStyle}>{shortTimeLabel(record.time)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={jobsFooterStyle}>
            {loading && <span>正在加载更多日志…</span>}
            {!loading && error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载失败，重试</button>}
            {!loading && error === '' && !hasMore && <span>已显示全部日志</span>}
            {!loading && error === '' && hasMore && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载更多日志</button>}
          </div>
        </div>
      )}
      {selected !== undefined && <LogDialog record={selected} onClose={() => { setSelected(undefined) }} />}
    </>
  )
}

/** Log detail dialog (LogDetailsDialog.vue port). */
function LogDialog({ record, onClose }: { record: EventRecord; onClose: () => void }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    }
  }, [onClose])
  const copy = (): void => {
    void navigator.clipboard.writeText(record.message)
    setCopied(true)
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => { setCopied(false) }, 1_500)
  }
  const fullTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(record.time))
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <section style={logDialogStyle} role="dialog" aria-modal="true" aria-label="日志详情">
        <header style={dialogHeaderStyle}>
          <span style={jobDialogTitleStyle}>日志详情</span>
          <span style={logIdStyle} title={record.id}>{record.id}</span>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}><GClose size={15} /></button>
        </header>
        <div style={logMetaStyle}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: toneColor(levelTone(record.level)) }}>
            <StatusDot tone={levelTone(record.level)} />{levelLabel(record.level)}
          </span>
          <span style={logMetaItemStyle}><span style={logMetaKeyStyle}>来源</span><code>{record.kind}</code></span>
          <span style={logMetaItemStyle}><span style={logMetaKeyStyle}>时间</span><time>{fullTime}</time></span>
        </div>
        <div style={logBodyStyle}>
          <pre style={logBodyPreStyle}>{record.message}</pre>
        </div>
        <footer style={dialogFooterStyle}>
          <button type="button" style={dialogActionButtonStyle} onClick={copy}>{copied ? '已复制' : '复制完整日志'}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

/* ── shared list helpers ── */

function sortJobs(jobs: readonly JobRecord[]): JobRecord[] {
  return [...jobs].sort((left, right) => (
    Number(right.status === 'running') - Number(left.status === 'running')
    || Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || right.id.localeCompare(left.id)
  ))
}

function mergeJobs(previous: readonly JobRecord[], incoming: readonly JobRecord[]): JobRecord[] {
  const byId = new Map(previous.map(job => [job.id, job]))
  for (const job of incoming) byId.set(job.id, job)
  return sortJobs([...byId.values()])
}

function sortRecords(incoming: readonly EventRecord[]): EventRecord[] {
  return [...incoming].sort((left, right) => (
    Date.parse(right.time) - Date.parse(left.time) || right.id.localeCompare(left.id)
  ))
}

function mergeRecords(previous: readonly EventRecord[], incoming: readonly EventRecord[]): EventRecord[] {
  const byId = new Map(previous.map(record => [record.id, record]))
  for (const record of incoming) byId.set(record.id, record)
  return sortRecords([...byId.values()])
}

const jobLabel = (value: string): string =>
  ({ running: '运行中', succeeded: '已完成', blocked: '无法完成', failed: '失败', cancelled: '已终止', queued: '等待中' })[value] ?? value
const jobTone = (value: string): Tone =>
  value === 'succeeded' ? 'ok' : value === 'failed' || value === 'blocked' ? 'bad' : value === 'running' ? 'warn' : 'neutral'
const kindLabel = (value: string): string =>
  ({ 'merge-base': '合并 base', 'fix-ci': '修 CI', 'resolve-comments': '解决评论', 'update-dshw': '更新 dshw', 'update-harness': '更新 Harness', 'reconfigure-harness': '从头配置 Harness', 'sync-check': '状态检查' })[value] ?? value

function jobExecutor(job: JobRecord): string {
  if (job.executor !== undefined) return job.executor
  if (job.dshWorker === undefined) return '内置'
  const type = job.dshWorker.handle.workerType
  return type === 'codex' ? 'Codex' : type === 'claude-code' ? 'Claude Code' : 'dsh'
}

function relativeTimeLabel(value?: string, now = Date.now()): string {
  if (value === undefined) return '—'
  const time = Date.parse(value)
  if (Number.isNaN(time)) return '—'
  const seconds = Math.max(0, Math.floor((now - time) / 1000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3600)} 小时前`
}

function shortTimeLabel(value?: string): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

const levelTone = (level: EventRecord['level']): Tone => level === 'error' ? 'bad' : level === 'warning' ? 'warn' : 'neutral'
const levelLabel = (level: EventRecord['level']): string => level === 'error' ? '错误' : level === 'warning' ? '警告' : '信息'

/* ── one PR row ── */

function PrRow({ pr, jobs, busy, workingAgent, pending, onAction, onChooseWorker, onToggleSync, onGitAction, onRefresh }: {
  pr: PrDashboardRecord
  jobs: readonly JobRecord[]
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
  onToggleSync: (cloneName: string, enabled: boolean) => void
  onGitAction: (cloneName: string, action: GitAction) => void
  onRefresh: () => void
}): ReactNode {
  // One <tr> per row — no <tbody> wrapper per row: nested tbodys are invalid
  // markup and the engine drops the row from the fixed column model, which
  // drifts the header/body columns apart. Draft dimming rides the row itself.
  return (
    <tr data-dshw-kanban="row" style={pr.isDraft ? draftRowStyle : trStyle}>
      <td style={tdStyle}>
        <div style={cellMainStyle}>
          <a style={titleLinkStyle} data-dshw-kanban="titlelink" href={pr.url} title={pr.title} target="_blank" rel="noreferrer">
            <span style={numberStyle}>#{pr.number}</span>
            <span style={{ ...titleStyle, ...(pr.isDraft ? { color: C_SECONDARY } : {}) }}>{pr.title}</span>
          </a>
          {pr.isDraft && <span style={draftBadgeStyle}>草稿</span>}
        </div>
        <div style={cellSubStyle}>
          {hasLocalGitStatus(pr) && pr.localGitStatus !== undefined && (
            <LocalGitChip status={pr.localGitStatus} pending={pending.has(`git-maintenance:${pr.cloneName}`)} onAction={action => onGitAction(pr.cloneName, action)} />
          )}
          <span style={subTextStyle} title={pr.branch}>{pr.branch} → {pr.baseRefName}</span>
        </div>
      </td>

      <td style={tdStyle}>
        <CiCell pr={pr} busy={busy} workingAgent={workingAgent} pending={pending} onAction={onAction} onChooseWorker={onChooseWorker} />
      </td>

      <td style={tdStyle}>
        <ReviewCell pr={pr} busy={busy} workingAgent={workingAgent} pending={pending} onAction={onAction} onChooseWorker={onChooseWorker} />
      </td>

      <td style={tdStyle}>
        <MergeCell pr={pr} busy={busy} workingAgent={workingAgent} pending={pending} jobs={jobs} onAction={onAction} onChooseWorker={onChooseWorker} onRefresh={onRefresh} />
      </td>

      <td style={tdStyle}>
        <div style={syncCellStyle}>
          <span style={syncSwitchRowStyle}>
            <button
              type="button"
              role="switch"
              aria-checked={pr.syncEnabled === true}
              aria-label={`PR #${pr.number} 自动 sync`}
              disabled={pending.has(`sync-toggle:${pr.cloneName}`)}
              onClick={() => { onToggleSync(pr.cloneName, pr.syncEnabled !== true) }}
              style={syncSwitchStyle(pr.syncEnabled === true)}
            >
              <span style={syncKnobStyle(pr.syncEnabled === true)} />
            </button>
            <span style={{ ...syncLabelStyle, ...(pr.syncEnabled === true ? { color: ok } : {}) }}>
              {pr.syncEnabled === true ? '已开启' : '已关闭'}
            </span>
          </span>
          {pr.agentPausedReason !== undefined && (
            <button type="button" className="dshw-link" style={pausedButtonStyle} title={pr.agentPausedReason} onClick={onRefresh}>
              自动任务已暂停 · 查看原因
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

/* ── column cells ── */

function CiCell({ pr, busy, workingAgent, pending, onAction, onChooseWorker }: {
  pr: PrDashboardRecord
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
}): ReactNode {
  const ordered = [...pr.checks].sort((a, b) => rank(a) - rank(b))
  const passed = pr.checks.filter(check => check.bucket === 'pass').length
  const failed = pr.checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel').length
  const pendingCount = pr.checks.filter(check => check.bucket === 'pending').length
  const note = failed > 0 ? `${failed} 个失败` : pendingCount > 0 ? `${pendingCount} 个运行中` : pr.checks.length > 0 ? '' : '尚无 checks'
  if (busy?.type === 'fix-ci') {
    return (
      <div style={cellColumnStyle}>
        <span className="dshw-link" style={busyRowStyle}><StatusDot tone="accent" pulse />修复中 · 查看</span>
      </div>
    )
  }
  return (
    <div style={cellColumnStyle}>
      <HoverPopover label={`PR #${pr.number} CI checks`} width={360} maxHeight={300} render={close => (
        <div>
          {ordered.length === 0 && <div style={popoverEmptyStyle}>尚无 checks</div>}
          {ordered.map(check => (
            <a key={`${check.name}-${check.link}`} style={popoverRowStyle} href={check.link || pr.url} target="_blank" rel="noreferrer" title={check.workflow}>
              <StatusIcon tone={checkTone(check)} size={12} />
              <span style={popoverRowTextStyle}>{check.name}</span>
              <span style={{ ...popoverRowBadgeStyle, color: toneColor(checkTone(check)) }}>{checkLabel(check)}</span>
            </a>
          ))}
        </div>
      )}>
        {(_, setOpen) => (
          <>
            <span style={statusGlyphStyle}><StatusIcon tone={ciTone(pr.ciStatus)} /></span>
            <span style={statusTextStyle}>{ciLabel(pr.ciStatus)}</span>
            {pr.checks.length > 0 && <span style={countStyle}>{passed}/{pr.checks.length}</span>}
            <span style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); setOpen(true) }} />
          </>
        )}
      </HoverPopover>
      <div style={cellNoteRowStyle}>
        {note !== '' && <span style={cellNoteStyle}>{note}</span>}
        {(pr.ciStatus === 'failed' || pr.checks.some(check => check.bucket === 'fail' || check.bucket === 'cancel')) && (
          <>
            {note !== '' && <span style={noteSeparatorStyle}>·</span>}
            <button
              type="button"
              className="dshw-link" style={actionLinkStyle}
              disabled={workingAgent !== undefined || pending.has(`fix-ci:${pr.cloneName}`)}
              title={workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : '单击使用默认 Worker · 右键选择 Worker'}
              onClick={() => { onAction(pr.cloneName, 'fix-ci') }}
              onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, 'fix-ci') }}
            >修 CI</button>
          </>
        )}
      </div>
    </div>
  )
}

function ReviewCell({ pr, busy, workingAgent, pending, onAction, onChooseWorker }: {
  pr: PrDashboardRecord
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
}): ReactNode {
  const requested = [...new Set(pr.reviewRequests ?? [])]
  const byLogin = new Map<string, PullRequestReview>()
  for (const review of pr.reviews ?? []) {
    const login = review.author?.login
    if (login !== undefined) byLogin.set(login, review)
  }
  const reviewed = [...byLogin.entries()].map(([login, review]) => ({ login, review }))
  const people = [...new Set([...requested, ...reviewed.map(item => item.login)])]
  const summary = requested.length > 0
    ? `${requested.length} 人等待`
    : reviewed.length > 0
      ? `${reviewed.length} 人已 review`
      : '尚未 request review'
  const avatar = (login: string): string => `https://github.com/${encodeURIComponent(login)}.png?size=64`
  if (busy?.type === 'resolve-comments') {
    return (
      <div style={cellColumnStyle}>
        <span className="dshw-link" style={busyRowStyle}><StatusDot tone="accent" pulse />解决评论中 · 查看</span>
      </div>
    )
  }
  return (
    <div style={cellColumnStyle}>
      <HoverPopover label={`PR #${pr.number} reviews`} width={380} maxHeight={340} render={close => (
        <div>
          {requested.length === 0 && reviewed.length === 0 && <div style={popoverEmptyStyle}>尚未 request review</div>}
          {requested.length > 0 && (
            <div style={popoverSectionStyle}>
              <div style={popoverSectionTitleStyle}>等待 Review</div>
              {requested.map(login => (
                <a key={`requested-${login}`} className="dshw-poprow" style={popoverPersonRowStyle} href={`https://github.com/${login}`} target="_blank" rel="noreferrer">
                  <img style={avatarStyle} src={avatar(login)} alt={login} />
                  <span style={popoverRowTextStyle}>@{login}</span>
                  <span style={{ ...popoverRowBadgeStyle, color: warn }}><StatusIcon tone="warn" size={11} />等待 review</span>
                </a>
              ))}
            </div>
          )}
          {reviewed.length > 0 && (
            <div style={{ ...popoverSectionStyle, ...(requested.length > 0 ? popoverSectionSpacedStyle : {}) }}>
              <div style={popoverSectionTitleStyle}>已 Review</div>
              {reviewed.map(item => (
                <a key={`reviewed-${item.login}`} className="dshw-poprow" style={popoverPersonRowStyle} href={`${pr.url}/files`} target="_blank" rel="noreferrer">
                  <img style={avatarStyle} src={avatar(item.login)} alt={item.login} />
                  <span style={popoverRowTextStyle}>@{item.login}</span>
                  <span style={{ ...popoverRowBadgeStyle, color: toneColor(reviewStateTone(item.review, pr)) }}>
                    <StatusIcon tone={reviewStateTone(item.review, pr)} size={11} />
                    {reviewState(item.review, pr)}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}>
        {(_, setOpen) => (
          <>
            <span style={statusGlyphStyle}><StatusIcon tone={reviewTone(pr.reviewDecision)} /></span>
            <span style={statusTextStyle}>{reviewLabel(pr.reviewDecision)}</span>
            {people.length > 0 && (
              <span style={avatarStackStyle} aria-hidden="true">
                {people.slice(0, 3).map(login => <img key={login} style={stackAvatarStyle} src={avatar(login)} alt="" />)}
                {people.length > 3 && <span style={stackMoreStyle}>+{people.length - 3}</span>}
              </span>
            )}
            <span style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); setOpen(true) }} />
          </>
        )}
      </HoverPopover>
      <div style={cellNoteRowStyle}>
        <span style={cellNoteStyle} title={summary}>{summary}</span>
        {pr.unresolvedComments !== undefined && pr.unresolvedComments > 0 && (
          <>
            <span style={noteSeparatorStyle}>·</span>
            <button
              type="button"
              className="dshw-link" style={actionLinkStyle}
              disabled={workingAgent !== undefined || pending.has(`resolve-comments:${pr.cloneName}`)}
              title={workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : '单击使用默认 Worker · 右键选择 Worker'}
              onClick={() => { onAction(pr.cloneName, 'resolve-comments') }}
              onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, 'resolve-comments') }}
            >解决 {pr.unresolvedComments} 条评论</button>
          </>
        )}
      </div>
    </div>
  )
}

function MergeCell({ pr, busy, workingAgent, pending, jobs, onAction, onChooseWorker, onRefresh }: {
  pr: PrDashboardRecord
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  jobs: readonly JobRecord[]
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
  onRefresh: () => void
}): ReactNode {
  const action = mergeAction(pr)
  const busyHere = busy !== undefined && busy.type !== 'fix-ci' && busy.type !== 'resolve-comments'
  const autoAt = autoMergeAt(pr)
  const failedMerge = lastFailedMerge(pr, jobs)
  return (
    <div style={cellColumnStyle}>
      {pr.mergeable === 'CONFLICTING'
        ? (
          <HoverPopover label={`PR #${pr.number} 冲突文件`} width={420} maxHeight={280} render={close => (
            <div>
              <div style={popoverSectionTitleStyle}>冲突文件</div>
              {pr.conflictPaths === undefined && <div style={popoverEmptyStyle}>暂时无法读取冲突文件</div>}
              {pr.conflictPaths !== undefined && pr.conflictPaths.length === 0 && <div style={popoverEmptyStyle}>本地未检测到冲突文件</div>}
              {pr.conflictPaths !== undefined && pr.conflictPaths.map(path => (
                <div key={path} style={conflictPathStyle}>{path}</div>
              ))}
            </div>
          )}>
            {(_, setOpen) => (
              <>
                <span style={statusGlyphStyle}><StatusIcon tone="bad" /></span>
                <span style={statusTextStyle}>冲突</span>
                <span style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); setOpen(true) }} />
              </>
            )}
          </HoverPopover>
        )
        : (
          <span style={{ ...mergeableLabelStyle, color: toneColor(mergeTone(pr.mergeable)) }}>
            <StatusIcon tone={mergeTone(pr.mergeable)} />
            {mergeLabel(pr.mergeable)}
          </span>
        )}
      {busyHere && (
        <span className="dshw-link" style={busyRowStyle}><StatusDot tone="accent" pulse />{busyLabel(busy)} · 查看</span>
      )}
      {!busyHere && autoAt !== undefined && (
        <div style={cellNoteRowStyle}>
          <span style={cellNoteStyle}>约 {autoMergeMinutes(pr)} 分钟</span>
          <span style={noteSeparatorStyle}>·</span>
          <button
            type="button"
            className="dshw-link" style={actionLinkStyle}
            disabled={workingAgent !== undefined || pending.has(`merge-base:${pr.cloneName}`)}
            title={workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : '单击使用默认 Worker · 右键选择 Worker'}
            onClick={() => { onAction(pr.cloneName, 'merge-base') }}
            onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, 'merge-base') }}
          >立即合并</button>
        </div>
      )}
      {!busyHere && autoAt === undefined && action !== undefined && (
        <div style={cellNoteRowStyle}>
          {pr.autoMergeSkippedReason !== undefined && (
            <span style={cellNoteStyle} title={pr.autoMergeSkippedReason}>{pr.autoMergeSkippedReason}</span>
          )}
          {pr.autoMergeSkippedReason === undefined && failedMerge !== undefined && (
            <span style={{ ...cellNoteStyle, color: warn }} title={failedMerge.summary}>上次合并失败</span>
          )}
          {(pr.autoMergeSkippedReason !== undefined || failedMerge !== undefined) && <span style={noteSeparatorStyle}>·</span>}
          <button
            type="button"
            className="dshw-link" style={actionLinkStyle}
            disabled={(action === 'merge-base' && workingAgent !== undefined)
              || pending.has(`merge-base:${pr.cloneName}`)
              || pending.has(`merge-base-direct:${pr.cloneName}`)}
            title={action === 'merge-base' && workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : undefined}
            onClick={() => { onAction(pr.cloneName, action) }}
            onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, action) }}
          >合并 {pr.baseRefName}</button>
        </div>
      )}
    </div>
  )
}

/* ── local git status chip + maintenance popover ── */

function LocalGitChip({ status, pending, onAction }: {
  status: CloneGitStatus
  pending: boolean
  onAction: (action: GitAction) => void
}): ReactNode {
  const dirty = status.unstaged || status.staged || status.merging
  const label = [
    status.unstaged ? '*' : '',
    status.staged ? '+' : '',
    status.merging ? '!' : '',
    status.ahead > 0 ? `↑${status.ahead}` : '',
    status.behind > 0 ? `↓${status.behind}` : '',
  ].join('')
  const run = (action: GitAction): void => {
    const confirmed = action === 'discard-unstaged'
      ? window.confirm('撤销所有未暂存更改？\n\n未暂存和未跟踪的内容都将永久删除，已暂存内容会保留。')
      : action === 'discard-staged'
        ? window.confirm('撤销所有未提交更改？\n\n已暂存的内容将永久删除。')
        : action === 'abort-merge'
          ? window.confirm('终止当前 merge？')
          : action === 'discard-unpushed'
            ? window.confirm(`丢弃 ${status.ahead} 个未推送提交？\n\n本地分支将重置到远端，无法从此菜单撤销。`)
            : true
    if (confirmed) onAction(action)
  }
  return (
    <HoverPopover label="本地 Git 状态与操作" width={240} maxHeight={300} render={close => (
      <div>
        {status.unstaged && <PopoverAction label="撤销未暂存" badge="*" disabled={pending || status.merging} title={status.merging ? '请先终止 merge' : ''} onClick={() => run('discard-unstaged')} />}
        {status.staged && <PopoverAction label="撤销未提交" badge="+" disabled={pending || status.unstaged || status.merging} title={status.merging ? '请先终止 merge' : status.unstaged ? '请先撤销未暂存' : ''} onClick={() => run('discard-staged')} />}
        {status.merging && <PopoverAction label="终止 merge" badge="!" disabled={pending} onClick={() => run('abort-merge')} />}
        {status.ahead > 0 && !dirty && <PopoverAction label="丢弃未推送提交" badge={`↑${status.ahead}`} disabled={pending} onClick={() => run('discard-unpushed')} />}
        {status.behind > 0 && <PopoverAction label="拉取远端提交" badge={`↓${status.behind}`} disabled={pending || status.ahead > 0} title={status.ahead > 0 ? '请先处理未推送提交' : ''} onClick={() => run('pull')} />}
        {pending && <div style={popoverEmptyStyle}>正在更新…</div>}
      </div>
    )}>
      {(_, setOpen) => (
        <span data-dshw-kanban="gitchip" style={gitChipStyle}>{label}</span>
      )}
    </HoverPopover>
  )
}

function PopoverAction({ label, badge, disabled, title, onClick }: {
  label: string
  badge: string
  disabled?: boolean
  title?: string
  onClick: () => void
}): ReactNode {
  return (
    <button type="button" style={popoverActionStyle} disabled={disabled} title={title} onClick={onClick}>
      <span>{label}</span>
      <span style={{ marginLeft: 'auto', color: warn, fontSize: 11.5, fontWeight: 600 }}>{badge}</span>
    </button>
  )
}

/* ── worker picker dialog ── */

function WorkerPicker({ workers, workerTypes, onClose, onPick }: {
  workers: readonly WorkerConfig[]
  workerTypes: readonly WorkerTypeAvailability[]
  onClose: () => void
  onPick: (workerConfigId: string, additionalInstruction: string) => void
}): ReactNode {
  const [instruction, setInstruction] = useState('')
  const usable = workers.filter(worker => worker.enabled
    && workerTypes.find(status => status.type === worker.type)?.available === true)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label="选择 Worker">
        <div style={dialogTitleStyle}>选择 Worker 执行任务</div>
        <div style={dialogListStyle}>
          {usable.map(worker => (
            <button
              key={worker.id}
              type="button"
              style={dialogWorkerRowStyle}
              onClick={() => { onPick(worker.id, instruction) }}
            >
              <span style={dialogWorkerNameStyle}>{worker.name}</span>
              <span style={dialogWorkerTypeStyle}>{worker.type}{worker.model !== undefined ? ` · ${worker.model}` : ''}</span>
            </button>
          ))}
          {usable.length === 0 && <div style={popoverEmptyStyle}>没有可用的 Worker</div>}
        </div>
        <input
          style={dialogInputStyle}
          placeholder="附加指令（可选）"
          value={instruction}
          onChange={event => { setInstruction(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter' && usable.length > 0) onPick(usable[0]!.id, instruction) }}
        />
        <div style={dialogCloseRowStyle}>
          <button type="button" style={dialogCancelStyle} onClick={onClose}>取消</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── shared helpers ── */

function rank(check: CiCheck): number { return check.bucket === 'fail' || check.bucket === 'cancel' ? 0 : check.bucket === 'pending' ? 1 : 2 }
function checkLabel(check: CiCheck): string { return check.bucket === 'pass' ? '通过' : check.bucket === 'pending' ? '运行中' : '失败' }
function checkTone(check: CiCheck): Tone { return check.bucket === 'pass' ? 'ok' : check.bucket === 'pending' ? 'warn' : 'bad' }

function reviewState(review: PullRequestReview, pr: PrDashboardRecord): string {
  const login = review.author?.login
  const progress = login === undefined ? undefined : pr.reviewerComments?.[login]
  if (progress !== undefined && progress.total > 0) return `${progress.resolved}/${progress.total}`
  return review.state === 'APPROVED' ? '已批准' : review.state === 'CHANGES_REQUESTED' ? '要求修改' : '已 review'
}

function reviewStateTone(review: PullRequestReview, pr: PrDashboardRecord): Tone {
  const login = review.author?.login
  const progress = login === undefined ? undefined : pr.reviewerComments?.[login]
  if (progress !== undefined && progress.total > 0) return progress.resolved === progress.total ? 'ok' : 'warn'
  return review.state === 'APPROVED' ? 'ok' : review.state === 'CHANGES_REQUESTED' ? 'bad' : 'neutral'
}

/* ── styles ── */

const rootStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: C_SURFACE,
}

const errorStripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 32,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  color: C_SECONDARY,
  background: C_WARN_SOFT,
}

const errorStripTextStyle: CSSProperties = { color: C_SECONDARY }

const loadingStripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 32,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  color: C_SECONDARY,
  background: C_HOVER,
}

const tableScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  /* no horizontal inset: the PR / Reviews tables span the panel edge to edge
     (cells carry their own 12px padding); bottom padding only for scroll end. */
  paddingBottom: 16,
}

const tableStyle: CSSProperties = {
  width: '100%',
  minWidth: 900,
  /* separate + spacing 0 (not collapse): with collapse, a sticky th breaks
     the table-layout:fixed column model in Chromium and the body cells fall
     back to content sizing — the header/body columns drift apart. */
  borderCollapse: 'separate',
  borderSpacing: 0,
  tableLayout: 'fixed',
}

const thStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: C_SECONDARY,
  position: 'sticky',
  top: 0,
  zIndex: 1,
  background: C_SURFACE,
}

const trStyle: CSSProperties = { }

const tdStyle: CSSProperties = {
  height: 54,
  padding: '5px 12px',
  verticalAlign: 'middle',
  borderBottom: `1px solid ${C_BORDER}`,
}

const draftRowStyle: CSSProperties = { opacity: 0.7, filter: 'saturate(0.5)' }

const cellMainStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }

const titleLinkStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  overflow: 'hidden',
  color: 'inherit',
}

const numberStyle: CSSProperties = { flex: 'none', fontFamily: 'monospace', fontSize: 12, color: C_MUTED }

const titleStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  fontSize: 13,
  color: C_TEXT,
}

const draftBadgeStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: C_BADGE,
  color: C_BADGE_FG,
}

const cellSubStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  height: 16,
  marginTop: 1,
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  color: C_MUTED,
}

const subTextStyle: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const gitChipStyle: CSSProperties = {
  flex: 'none',
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  fontWeight: 600,
  color: warn,
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  lineHeight: '18px',
}

const cellColumnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, minWidth: 0 }

const popoverTriggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  minWidth: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: C_SECONDARY,
  fontFamily: 'inherit',
  fontSize: 12.5,
  textAlign: 'left',
}

const statusGlyphStyle: CSSProperties = { display: 'inline-flex', flex: 'none' }

const statusTextStyle: CSSProperties = { whiteSpace: 'nowrap', color: 'inherit' }

const countStyle: CSSProperties = { flex: 'none', fontFamily: 'monospace', fontSize: 11, color: C_MUTED }

const cellNoteRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }

const cellNoteStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  color: C_MUTED,
}

const noteSeparatorStyle: CSSProperties = { flex: 'none', fontSize: 11.5, color: C_MUTED }

const actionLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  flex: 'none',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  color: C_LINK,
  fontFamily: 'inherit',
}

const busyRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  fontSize: 11.5,
  color: C_LINK,
}

const mergeableLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  height: 20,
  fontSize: 12.5,
  whiteSpace: 'nowrap',
}

const syncCellStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }

const syncSwitchRowStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, height: 20 }

const syncSwitchStyle = (on: boolean): CSSProperties => ({
  position: 'relative',
  flex: 'none',
  width: 26,
  height: 14,
  borderRadius: 7,
  border: 'none',
  cursor: 'pointer',
  transition: 'background-color 150ms',
  background: on ? C_ACCENT : C_BADGE,
})

const syncKnobStyle = (on: boolean): CSSProperties => ({
  position: 'absolute',
  top: 2,
  left: 2,
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
  transition: 'transform 150ms',
  transform: on ? 'translateX(12px)' : 'none',
})

const syncLabelStyle: CSSProperties = { fontSize: 12.5, whiteSpace: 'nowrap', color: C_MUTED }

const pausedButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  padding: 0,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  color: warn,
  fontFamily: 'inherit',
}

const popoverStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 120,
  overflow: 'auto',
  padding: 4,
  border: `1px solid ${C_BORDER}`,
  borderRadius: 8,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
  boxSizing: 'border-box',
}

const popoverEmptyStyle: CSSProperties = { padding: '8px 10px', fontSize: 12, color: C_MUTED }

const popoverRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 26,
  padding: '0 8px',
  borderRadius: 6,
  fontSize: 12,
  color: C_SECONDARY,
  textDecoration: 'none',
}

const popoverRowTextStyle: CSSProperties = { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const popoverRowBadgeStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', fontSize: 11.5, whiteSpace: 'nowrap' }

const popoverSectionStyle: CSSProperties = { paddingBottom: 4 }

const popoverSectionSpacedStyle: CSSProperties = { marginTop: 3, paddingTop: 4, borderTop: `1px solid ${C_BORDER}` }

const popoverSectionTitleStyle: CSSProperties = { padding: '4px 7px', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: C_MUTED }

const popoverPersonRowStyle: CSSProperties = { ...popoverRowStyle, minHeight: 32 }

const avatarStyle: CSSProperties = { width: 20, height: 20, borderRadius: '50%', flex: 'none', objectFit: 'cover', background: C_HOVER }

const avatarStackStyle: CSSProperties = { display: 'inline-flex', flex: 'none', alignItems: 'center', paddingLeft: 3 }

const stackAvatarStyle: CSSProperties = { width: 16, height: 16, marginLeft: -3, borderRadius: '50%', flex: 'none', objectFit: 'cover', border: `1px solid ${C_SURFACE}` }

const stackMoreStyle: CSSProperties = { marginLeft: 3, fontSize: 10.5, color: C_MUTED }

const conflictPathStyle: CSSProperties = { padding: '2px 0', fontFamily: 'monospace', fontSize: 11.5, lineHeight: 1.45, overflowWrap: 'anywhere', color: C_SECONDARY }

const popoverActionStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  minHeight: 28,
  padding: '0 7px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 12,
  color: C_SECONDARY,
  fontFamily: 'inherit',
}

const dialogOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 130,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const dialogMaskStyle: CSSProperties = { position: 'absolute', inset: 0, background: C_OVERLAY }

const dialogStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: 380,
  maxWidth: 'calc(100vw - 32px)',
  padding: 16,
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 12,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
}

const dialogTitleStyle: CSSProperties = { marginBottom: 10, fontSize: 13, fontWeight: 500, color: C_TEXT }

const dialogListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflow: 'auto' }

const dialogWorkerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minHeight: 34,
  padding: '0 10px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
}

const dialogWorkerNameStyle: CSSProperties = { fontSize: 13, color: C_TEXT }

const dialogWorkerTypeStyle: CSSProperties = { fontSize: 11.5, color: C_MUTED }

const dialogInputStyle: CSSProperties = {
  marginTop: 10,
  height: 34,
  padding: '0 10px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 8,
  outline: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: C_TEXT,
}

const dialogCloseRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginTop: 12 }

const dialogCancelStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  color: C_SECONDARY,
}

const emptyStateStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  height: '100%',
  minHeight: 200,
  fontSize: 12.5,
  color: C_MUTED,
}

const emptyStateLineStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: C_SECONDARY }

const emptyStateTitleStyle: CSSProperties = { margin: 0, fontSize: 13, color: C_SECONDARY }

const emptyStateSubStyle: CSSProperties = { margin: 0, fontSize: 12, color: C_MUTED }

const toastStyle: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 140,
  maxWidth: 420,
  padding: '8px 14px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 8,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
  fontSize: 12.5,
  color: C_TEXT,
}

/* ── tab bar + view area ── */

const tabbarStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'stretch',
  height: 35,
  overflowX: 'auto',
  borderBottom: `1px solid ${C_BORDER}`,
  background: C_WIDGET,
}

const tabStyle = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 12px',
  border: 'none',
  background: active ? C_SURFACE : '#ececec',
  color: active ? C_TEXT : 'rgba(51, 51, 51, .7)',
  fontFamily: 'inherit',
  fontSize: 12.5,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
})

const tabCountStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: C_BADGE,
  color: C_BADGE_FG,
}

const viewAreaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
}

/* ── reviews / jobs / logs shared cell styles ── */

const authorStyle: CSSProperties = { fontSize: 12.5, color: C_SECONDARY }

const timeStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 11, whiteSpace: 'nowrap', color: C_FAINT }

const tdCompactStyle: CSSProperties = {
  height: 32,
  padding: '0 12px',
  verticalAlign: 'middle',
  borderBottom: `1px solid ${C_BORDER}`,
}

const cellBlockStyle: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  color: C_SECONDARY,
}

const jobSummaryStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12.5,
  color: C_TEXT,
}

const logMessageStyle: CSSProperties = {
  display: 'block',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12.5,
  color: C_SECONDARY,
}

const dangerButtonStyle: CSSProperties = {
  flex: 'none',
  marginLeft: 'auto',
  height: 22,
  padding: '0 8px',
  border: `1px solid ${C_DANGER}`,
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: C_DANGER,
}

const jobsScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' }

const jobsFooterStyle: CSSProperties = {
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  fontSize: 11.5,
  color: C_MUTED,
}

/* ── job dialog ── */

const jobDialogStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: 'min(760px, calc(100vw - 48px))',
  height: 'min(620px, calc(100vh - 48px))',
  overflow: 'hidden',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 12,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
}

const dialogHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 46,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

const jobDialogTitleStyle: CSSProperties = { fontSize: 13.5, fontWeight: 600, color: C_TEXT }

const jobDialogStatusStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap' }

const dialogCloseButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  color: C_SECONDARY,
  fontFamily: 'inherit',
  fontSize: 13,
}

const jobDialogMetaStyle: CSSProperties = {
  flex: 'none',
  minHeight: 34,
  padding: '6px 14px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 11.5,
  color: C_SECONDARY,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const jobOutputStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  background: C_SURFACE,
}

const jobOutputPreStyle: CSSProperties = {
  minHeight: '100%',
  margin: 0,
  padding: 14,
  boxSizing: 'border-box',
  fontFamily: FONT_MONO,
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: C_TEXT,
}

const jobDialogFooterStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 48,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${C_BORDER}`,
}

const dialogActionButtonStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  color: C_SECONDARY,
}

const steerInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 28,
  padding: '0 10px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 7,
  outline: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 12,
  color: C_TEXT,
}

/* ── log dialog ── */

const logDialogStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: 'min(760px, calc(100vw - 48px))',
  height: 'min(620px, calc(100vh - 48px))',
  overflow: 'hidden',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 12,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
}

const logIdStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_MUTED,
}

const logMetaStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '5px 18px',
  minHeight: 42,
  padding: '8px 14px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 11.5,
  color: C_SECONDARY,
}

const logMetaItemStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }

const logMetaKeyStyle: CSSProperties = { color: C_MUTED }

const logBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  background: C_SURFACE,
}

const logBodyPreStyle: CSSProperties = {
  minHeight: '100%',
  margin: 0,
  padding: 16,
  boxSizing: 'border-box',
  fontFamily: FONT_MONO,
  fontSize: 12.5,
  lineHeight: 1.65,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: C_TEXT,
}

const dialogFooterStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  minHeight: 48,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${C_BORDER}`,
}

/* ── Git view (GitTree.vue port, reusing @dreamcatcher-tech/commit-graph) ── */

const ROW_HEIGHT = 32
const PAGE_SIZE = 100
const GRAPH_NODE_RADIUS = 2
const GRAPH_TOP = ROW_HEIGHT / 2 - GRAPH_NODE_RADIUS * 4
const GRAPH_LEFT_PADDING = 12
const GRAPH_TEXT_GAP = 12
const GRAPH_PALETTE = ['#007acc', '#388a34', '#bf8803', '#a1260d', '#7b61a8', '#00838f', '#ad4e00', '#5b7c19', '#6c5ce7', '#c44569']

function GitView({ baseUrl, refreshKey }: { baseUrl: string; refreshKey: number }): ReactNode {
  const [graph, setGraph] = useState<GitGraphSnapshot>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [focusedBranchOid, setFocusedBranchOid] = useState<string>()
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [graphWidth, setGraphWidth] = useState(72)
  const [graphCanvasWidth, setGraphCanvasWidth] = useState(72)
  const [colors, setColors] = useState<Record<string, string>>({})
  const graphHostRef = useRef<HTMLDivElement>(null)
  const graphScrollRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<AbortController | undefined>(undefined)

  const commits = graph?.commits ?? []
  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const children = new Map<string, string[]>()
  for (const commit of commits) {
    for (const parent of commit.parents) {
      children.set(parent, [...(children.get(parent) ?? []), commit.hash])
    }
  }

  const ancestorsOf = (tip: string): Set<string> => {
    const ancestors = new Set<string>()
    const pending = [tip]
    while (pending.length > 0) {
      const hash = pending.pop()!
      if (ancestors.has(hash)) continue
      ancestors.add(hash)
      const commit = byHash.get(hash)
      if (commit !== undefined) pending.push(...commit.parents)
    }
    return ancestors
  }

  const masterOid = graph?.branches.find(branch => branch.kind === 'master')?.oid
  const visibleBranches = graph?.branches.filter(branch => (
    focusedBranchOid === undefined || branch.oid === focusedBranchOid || branch.kind === 'master'
  )) ?? []
  const focusedCommits = commits.filter(commit => {
    if (focusedBranchOid === undefined || masterOid === undefined) return true
    const branchAncestors = ancestorsOf(focusedBranchOid)
    const masterAncestors = ancestorsOf(masterOid)
    return branchAncestors.has(commit.hash) || masterAncestors.has(commit.hash)
  })
  const allOrderedCommits = ((): typeof commits => {
    const readyOrder = [...focusedCommits].sort((left, right) => {
      if (left.hash === masterOid) return -1
      if (right.hash === masterOid) return 1
      return right.author.timestamp - left.author.timestamp || left.hash.localeCompare(right.hash)
    })
    const seen = new Set<string>()
    const result: typeof commits = []
    const visit = (hash: string): void => {
      if (seen.has(hash)) return
      const commit = byHash.get(hash)
      if (commit === undefined) return
      seen.add(hash)
      for (const child of children.get(hash) ?? []) visit(child)
      result.push(commit)
    }
    for (const commit of readyOrder) visit(commit.hash)
    return result
  })()
  const orderedCommits = allOrderedCommits.slice(0, visibleCount)
  const hasMore = orderedCommits.length < allOrderedCommits.length
  const graphHeight = orderedCommits.length * ROW_HEIGHT
  const graphContentHeight = graphHeight + (hasMore ? ROW_HEIGHT : 0)
  const branchesByOid = new Map<string, GitGraphBranch[]>()
  for (const branch of visibleBranches) {
    branchesByOid.set(branch.oid, [...(branchesByOid.get(branch.oid) ?? []), branch])
  }

  const load = async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${baseUrl}/api/git-graph`, { cache: 'no-store', signal: controller.signal })
      const value = await response.json() as GitGraphSnapshot & { error?: string }
      if (!response.ok) throw new Error(value.error ?? 'Git tree 加载失败')
      setColors({})
      setVisibleCount(PAGE_SIZE)
      setGraph(value)
      if (focusedBranchOid !== undefined && !value.branches.some(branch => branch.oid === focusedBranchOid)) {
        setFocusedBranchOid(undefined)
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    return () => { controllerRef.current?.abort() }
  }, [baseUrl, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Measure the rendered CommitGraph: canvas width + per-branch colors.
  useEffect(() => {
    const host = graphHostRef.current
    if (host === null) return
    const frame = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(() => {
        const svg = host.querySelector('svg')
        const width = svg?.width.baseVal.value
        if (width !== undefined && Number.isFinite(width)) setGraphCanvasWidth(Math.max(44, Math.min(220, width)))
        const nodes = [...host.querySelectorAll<SVGGElement>('svg g[filter^="url(#filter_"]')]
        const next: Record<string, string> = {}
        let rightmostNode = 0
        for (const node of nodes) {
          const match = node.getAttribute('filter')?.match(/^url\(#filter_(.+)_node\)$/u)
          if (match?.[1] === undefined) continue
          const circle = node.querySelector('circle')
          const color = node.getAttribute('fill') ?? circle?.getAttribute('fill')
          if (color !== null && color !== undefined) next[match[1]] = color
          const x = Number(circle?.getAttribute('cx'))
          if (Number.isFinite(x)) rightmostNode = Math.max(rightmostNode, x)
        }
        setColors(next)
        setGraphWidth(Math.max(44, Math.min(220, GRAPH_LEFT_PADDING + rightmostNode + GRAPH_NODE_RADIUS + GRAPH_TEXT_GAP)))
      })
      return () => { cancelAnimationFrame(inner) }
    })
    return () => { cancelAnimationFrame(frame) }
  }, [orderedCommits, graph])

  const focusBranch = (branch: GitGraphBranch): void => {
    setColors({})
    setVisibleCount(PAGE_SIZE)
    setFocusedBranchOid(current => current === branch.oid ? undefined : branch.oid)
  }

  const loadMore = (): void => {
    if (!hasMore) return
    setVisibleCount(Math.min(visibleCount + PAGE_SIZE, allOrderedCommits.length))
  }

  const onGraphScroll = (): void => {
    const element = graphScrollRef.current
    if (element === null || !hasMore) return
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= ROW_HEIGHT * 12) loadMore()
  }

  const branchColor = (oid: string, fallbackIndex: number): string => colors[oid] ?? GRAPH_PALETTE[fallbackIndex % GRAPH_PALETTE.length]!
  const commitUrl = (hash: string): string => `https://github.com/${graph?.repoSlug ?? 'deepseek-harness/deepseek-harness'}/commit/${hash}`
  const commitTime = (timestamp: number): string => shortTimeLabel(new Date(timestamp).toISOString())

  const visible = new Set(orderedCommits.map(commit => commit.hash))
  const graphCommits = orderedCommits.map(commit => ({
    sha: commit.hash,
    commit: {
      author: {
        name: commit.author.name,
        email: commit.author.email,
        date: commit.hash === masterOid
          ? new Date(8_639_999_999_999_999)
          : new Date(commit.author.timestamp),
      },
      message: commit.subject,
    },
    parents: commit.parents.filter(parent => visible.has(parent)).map(sha => ({ sha })),
  }))
  const branchHeads = visibleBranches
    .filter(branch => visible.has(branch.oid))
    .map(branch => ({ name: branch.label, commit: { sha: branch.oid }, link: branch.url }))

  return (
    <div style={gitLayoutStyle}>
      <aside style={gitSidebarStyle}>
        <div style={gitSidebarHeaderStyle}>
          <div style={gitSidebarTitleStyle}>
            <span style={{ display: 'inline-flex', flex: 'none', color: C_ACCENT }}><GGitGraph size={14} /></span>
            <span style={gitSidebarTitleTextStyle}>{graph?.repoSlug ?? 'Git tree'}</span>
          </div>
          <div style={gitSidebarSubStyle}>
            {graph !== undefined
              ? `${graph.commits.length} 个提交 · ${graph.branches.length} 个分支`
              : '正在读取 Git 历史…'}
          </div>
        </div>
        {graph !== undefined && (
          <div style={gitSidebarListStyle}>
            {graph.branches.map((branch, index) => {
              const active = focusedBranchOid === branch.oid
              return (
                <div
                  key={`${branch.kind}:${branch.name}:${branch.number ?? ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  data-dshw-kanban="gitbranch"
                  onClick={() => { focusBranch(branch) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusBranch(branch) }
                  }}
                  style={active ? gitBranchItemActiveStyle : gitBranchItemStyle}
                >
                  <span style={{ ...gitBranchDotStyle, background: branchColor(branch.oid, index) }} />
                  <span style={gitBranchTextStyle}>
                    <span style={gitBranchLineStyle}>
                      {branch.kind === 'pr' && branch.url !== undefined ? (
                        <>
                          <a style={gitPrLinkStyle} data-dshw-kanban="gitpr" href={branch.url} target="_blank" rel="noreferrer" onClick={event => { event.stopPropagation() }}>
                            PR #{branch.number}
                          </a>
                          <span style={gitBranchSeparatorStyle}>·</span>
                          <span style={gitBranchNameStyle}>{branch.name}</span>
                        </>
                      ) : (
                        <span style={gitBranchNameStyle}>{branch.name}</span>
                      )}
                      {branch.isDraft === true && <span style={draftBadgeStyle}>draft</span>}
                    </span>
                    {branch.title !== undefined && <span style={gitBranchTitleStyle} title={branch.title}>{branch.title}</span>}
                    <span style={gitBranchOidStyle}>{branch.oid.slice(0, 8)}</span>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </aside>

      <section style={gitMainStyle}>
        <div style={gitToolbarStyle}>
          <span style={gitToolbarTitleStyle}>Commit history</span>
          {graph !== undefined && (
            <>
              <span style={{ marginLeft: 'auto' }}>{shortTimeLabel(graph.generatedAt)} 更新</span>
              {graph.truncated === true && <span style={{ color: warn }}>仅显示相关历史</span>}
              {loading && (
                <span style={gitRefreshRowStyle}><StatusDot tone="accent" pulse />刷新中</span>
              )}
            </>
          )}
        </div>

        {loading && graph === undefined && (
          <div style={emptyStateStyle}>
            <span style={emptyStateLineStyle}><StatusDot tone="accent" pulse />正在读取 Git 历史…</span>
          </div>
        )}
        {error !== '' && (
          <div style={emptyStateStyle}>
            <span style={{ ...emptyStateTitleStyle, color: bad }}>Git tree 加载失败</span>
            <span style={emptyStateSubStyle}>{error}</span>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={load}>重试</button>
          </div>
        )}
        {graph !== undefined && (
          <div ref={graphScrollRef} style={gitScrollStyle} onScroll={onGraphScroll}>
            <div style={{ position: 'relative', minWidth: 760, height: graphContentHeight }}>
              <div
                ref={graphHostRef}
                data-dshw-kanban="gitgraph"
                aria-hidden="true"
                style={{ position: 'absolute', zIndex: 2, pointerEvents: 'none', overflow: 'hidden', left: GRAPH_LEFT_PADDING, top: GRAPH_TOP, width: graphCanvasWidth, height: Math.max(0, graphHeight - GRAPH_TOP) }}
              >
                <CommitGraph
                  commits={graphCommits}
                  branchHeads={branchHeads}
                  graphStyle={{ commitSpacing: ROW_HEIGHT, branchSpacing: 13, branchColors: GRAPH_PALETTE, nodeRadius: GRAPH_NODE_RADIUS }}
                  currentBranch="master"
                />
              </div>
              {orderedCommits.map(commit => (
                <div
                  key={commit.hash}
                  data-dshw-kanban="gitrow"
                  style={{ ...gitCommitRowStyle, paddingLeft: graphWidth }}
                  title={`${commit.hash}\n${commit.subject}\n${commit.author.name} <${commit.author.email}>`}
                >
                  <a
                    style={gitHashStyle}
                    data-dshw-kanban="githash"
                    href={commitUrl(commit.hash)}
                    target="_blank"
                    rel="noreferrer"
                    title={`在 GitHub 查看 ${commit.hash}`}
                  >{commit.hash.slice(0, 7)}</a>
                  {(branchesByOid.get(commit.hash) ?? []).map(branch => {
                    const color = branchColor(commit.hash, 0)
                    const chip = { ...refChipStyle(color), maxWidth: 240 }
                    return branch.url !== undefined ? (
                      <a key={`${branch.kind}:${branch.name}`} style={chip} href={branch.url} target="_blank" rel="noreferrer" title={branch.title}>
                        <span style={{ fontWeight: 600 }}>#{branch.number}</span>
                        <span style={gitChipTextStyle}>{branch.name}</span>
                        {branch.isDraft === true && <span style={{ opacity: 0.7 }}>draft</span>}
                      </a>
                    ) : (
                      <span key={`${branch.kind}:${branch.name}`} style={chip}>{branch.name}</span>
                    )
                  })}
                  <span style={gitSubjectStyle}>{commit.subject}</span>
                  <span style={gitAuthorStyle}>{commit.author.name}</span>
                  <time style={gitTimeStyle}>{commitTime(commit.author.timestamp)}</time>
                </div>
              ))}
              {hasMore && (
                <button type="button" data-dshw-kanban="loadmore" style={{ ...gitLoadMoreStyle, top: graphHeight }} onClick={loadMore}>
                  加载更多（剩余 {allOrderedCommits.length - orderedCommits.length} 条）
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

/* ── git view styles ── */

const gitLayoutStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '270px minmax(0, 1fr)',
  background: C_SURFACE,
}

const gitSidebarStyle: CSSProperties = {
  minHeight: 0,
  overflowY: 'auto',
  borderRight: `1px solid ${C_BORDER}`,
  background: C_SURFACE,
}

const gitSidebarHeaderStyle: CSSProperties = {
  padding: '10px 12px',
  borderBottom: `1px solid ${C_BORDER}`,
}

const gitSidebarTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  fontWeight: 600,
  color: C_TEXT,
}

const gitSidebarTitleTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const gitSidebarSubStyle: CSSProperties = { marginTop: 3, fontSize: 11.5, color: C_MUTED }

const gitSidebarListStyle: CSSProperties = { padding: '5px 0' }

const gitBranchItemStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '7px 12px',
  cursor: 'pointer',
}

const gitBranchItemActiveStyle: CSSProperties = {
  ...gitBranchItemStyle,
  background: C_ACCENT_SOFT,
}

const gitBranchDotStyle: CSSProperties = {
  flex: 'none',
  width: 7,
  height: 7,
  marginTop: 6,
  borderRadius: '50%',
}

const gitBranchTextStyle: CSSProperties = { minWidth: 0, flex: 1 }

const gitBranchLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  fontSize: 12,
  fontWeight: 500,
  color: C_TEXT,
}

const gitPrLinkStyle: CSSProperties = { flex: 'none', color: 'inherit' }

const gitBranchSeparatorStyle: CSSProperties = { color: C_MUTED }

const gitBranchNameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const gitBranchTitleStyle: CSSProperties = {
  display: 'block',
  marginTop: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: C_MUTED,
}

const gitBranchOidStyle: CSSProperties = {
  display: 'block',
  marginTop: 1,
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_FAINT,
}

const gitMainStyle: CSSProperties = {
  position: 'relative',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: C_SURFACE,
}

const gitToolbarStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 36,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 11.5,
  color: C_MUTED,
}

const gitToolbarTitleStyle: CSSProperties = { fontWeight: 600, color: C_TEXT }

const gitRefreshRowStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5 }

const gitScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' }

const gitCommitRowStyle: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: ROW_HEIGHT,
  paddingRight: 12,
  boxSizing: 'border-box',
  borderBottom: `1px solid color-mix(in srgb, ${C_BORDER} 55%, transparent)`,
}

const gitHashStyle: CSSProperties = {
  flex: 'none',
  width: 58,
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_FAINT,
}

const gitChipTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const gitSubjectStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
  color: C_TEXT,
}

const gitAuthorStyle: CSSProperties = {
  flex: 'none',
  maxWidth: 130,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: C_MUTED,
}

const gitTimeStyle: CSSProperties = {
  flex: 'none',
  width: 70,
  textAlign: 'right',
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_FAINT,
}

const gitLoadMoreStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: ROW_HEIGHT,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: C_MUTED,
}

const refChipStyle = (color: string): CSSProperties => ({
  display: 'inline-flex',
  flex: 'none',
  alignItems: 'center',
  gap: 3,
  height: 20,
  border: `1px solid color-mix(in srgb, ${color} 38%, white)`,
  borderRadius: 3,
  padding: '0 4px',
  boxSizing: 'border-box',
  fontSize: 10.5,
  lineHeight: '18px',
  textDecoration: 'none',
  background: `color-mix(in srgb, ${color} 10%, white)`,
  color: `color-mix(in srgb, ${color} 82%, black)`,
})

/* ── Settings view (WorkerSettings.vue port) ── */

type WorkerForm = WorkerConfigInput

function emptyWorkerForm(): WorkerForm {
  return {
    name: '', type: 'dsh', enabled: true,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: '',
    baseUrl: '', searchBaseUrl: '', apiKeyMode: 'value', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '',
  }
}

function SettingsView(props: ViewProps): ReactNode {
  const { baseUrl, snapshot, showToast, post } = props
  const [section, setSection] = useState<'repository' | 'workers'>('repository')
  const [editing, setEditing] = useState<WorkerConfig>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<WorkerForm>(emptyWorkerForm)
  const [modelCatalog, setModelCatalog] = useState<WorkerModelCatalog>()
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<string>()
  const [reordering, setReordering] = useState(false)
  const [draggedId, setDraggedId] = useState<string>()
  const [dragOverId, setDragOverId] = useState<string>()
  const [displayedWorkers, setDisplayedWorkers] = useState<WorkerConfig[]>(snapshot?.workers ?? [])
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupPreview, setCleanupPreview] = useState<WorktreeCleanupPreview>()
  const [cleanupDecisions, setCleanupDecisions] = useState<Record<string, 'keep' | 'delete'>>({})
  const [repositoryRefreshing, setRepositoryRefreshing] = useState(false)

  const workers = snapshot?.workers ?? []
  const workerTypes = snapshot?.workerTypes ?? []
  const repository = snapshot?.harnessRepository
  const dshwRepository = snapshot?.dshwRepository
  const devMode = snapshot?.service.devMode === true
  const worktreeCount = snapshot?.clones.length ?? 0
  const worktreeCleanupCount = snapshot?.worktreeCleanupCount

  useEffect(() => {
    if (snapshot === undefined) return
    if (draggedId === undefined) setDisplayedWorkers(snapshot.workers)
  }, [snapshot, draggedId])

  const typeLabel = (type: WorkerConfig['type']): string =>
    type === 'dsh' ? 'dsh' : type === 'codex' ? 'Codex' : 'Claude Code'
  const credentialLabel = (worker: WorkerConfig): string =>
    worker.type === 'codex' ? '本机配置'
      : worker.credentialSource === 'saved' ? '已保存'
        : worker.credentialSource === 'environment' ? '环境变量' : '未配置'
  const workerAvailable = (worker: WorkerConfig): boolean =>
    worker.enabled && workerTypes.find(status => status.type === worker.type)?.available === true
  const workerStatus = (worker: WorkerConfig): string =>
    !worker.enabled ? '未启用' : workerAvailable(worker) ? '可用' : '不可用'

  const repositoryLag = (): string => {
    if (repository?.state === 'error') return '暂时无法确认与上游的差异'
    const behind = repository?.behind ?? 0
    const lag = behind === 0 ? '当前已与上游一致' : `当前落后上游 ${behind} 个提交`
    return repository?.dirty === true ? `${lag} · 有本地内容待收起` : lag
  }
  const dshwRepositoryLag = (): string => {
    if (dshwRepository?.state === 'error') return '暂时无法确认与上游的差异'
    const behind = dshwRepository?.behind ?? 0
    const lag = behind === 0 ? '当前已与上游一致' : `当前落后上游 ${behind} 个提交`
    return dshwRepository?.dirty === true ? `${lag} · 有本地修改` : lag
  }
  const worktreeSummary = (): string => worktreeCleanupCount === undefined
    ? `当前 ${worktreeCount} 个，可清理数量待确认`
    : `当前 ${worktreeCount} 个，其中 ${worktreeCleanupCount} 个可清理`
  const dshwUpdateNoop = dshwRepository?.state === 'ready' && (dshwRepository.behind ?? 0) === 0
  const harnessSyncNoop = repository?.state === 'ready' && (repository.behind ?? 0) === 0 && repository.dirty === false
  const worktreeCleanupNoop = worktreeCleanupCount === 0
  const busy = repositoryRefreshing || cleanupLoading

  /* ── repository section ── */

  const refreshRepositoryState = async (): Promise<void> => {
    if (repositoryRefreshing) return
    setRepositoryRefreshing(true)
    try {
      const response = await fetch(`${baseUrl}/api/repository/refresh`, { method: 'POST' })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      showToast('仓库状态已刷新')
    } catch (error) {
      showToast(`刷新失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setRepositoryRefreshing(false)
    }
  }

  const confirmReconfigure = (): void => {
    const confirmed = window.confirm([
      '从头配置当前 dsh 主仓库？',
      '',
      '这会执行两次 git clean -fdx，删除所有未跟踪和 ignored 文件（包括 .env、node_modules 和构建产物），然后拉取 origin/master、重新安装依赖并运行 typecheck。',
      '',
      '若存在 tracked 或 staged 修改，后台会拒绝执行。',
    ].join('\n'))
    if (confirmed) void post('/api/reconfigure', {}, 'reconfigure-harness')
  }

  const inspectWorktreeCleanup = async (): Promise<void> => {
    if (cleanupLoading) return
    setCleanupLoading(true)
    try {
      const response = await fetch(`${baseUrl}/api/worktrees/cleanup/preview`, { method: 'POST' })
      const value = await response.json() as WorktreeCleanupPreview & { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setCleanupPreview(value)
      if (value.candidates.length === 0) {
        showToast(value.busy > 0 ? '没有可清理的 Worktree；有任务正在使用候选项' : '没有非 active PR 的 Worktree')
        return
      }
      const risky = value.candidates.filter(candidate => candidate.needsDecision)
      if (risky.length === 0) {
        if (window.confirm(`清理 ${value.candidates.length} 个不再对应 active PR 的 Worktree？\n\n这些 Worktree 没有本地改动或未推送提交，将被直接删除。`)) {
          await executeWorktreeCleanup([])
        }
        return
      }
      setCleanupDecisions(Object.fromEntries(risky.map(candidate => [candidate.name, 'keep' as const])))
      setCleanupDialogOpen(true)
    } catch (error) {
      showToast(`检查失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setCleanupLoading(false)
    }
  }

  const executeWorktreeCleanup = async (deleteDirty: string[]): Promise<void> => {
    if (cleanupLoading) return
    setCleanupLoading(true)
    try {
      const response = await fetch(`${baseUrl}/api/worktrees/cleanup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deleteDirty }),
      })
      const value = await response.json() as { deleted?: string[]; failed?: Array<{ name: string; error: string }>; error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setCleanupDialogOpen(false)
      setCleanupPreview(undefined)
      const deleted = value.deleted?.length ?? 0
      const failed = value.failed?.length ?? 0
      showToast(failed > 0 ? `已清理 ${deleted} 个，${failed} 个删除失败` : `已清理 ${deleted} 个 Worktree`, failed > 0)
    } catch (error) {
      showToast(`清理失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setCleanupLoading(false)
    }
  }

  /* ── workers section ── */

  const loadModelCatalog = async (): Promise<void> => {
    setModelLoading(true)
    setModelError('')
    try {
      const query = new URLSearchParams({ type: form.type })
      if (form.provider?.trim() !== undefined && form.provider.trim() !== '') query.set('provider', form.provider.trim())
      const response = await fetch(`${baseUrl}/api/worker-models?${query}`)
      const value = await response.json() as { catalog?: WorkerModelCatalog; error?: string }
      if (!response.ok || value.catalog === undefined) throw new Error(value.error ?? `HTTP ${response.status}`)
      setModelCatalog(value.catalog)
    } catch (error) {
      setModelCatalog(undefined)
      setModelError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelLoading(false)
    }
  }

  useEffect(() => {
    if (dialogOpen) void loadModelCatalog()
  }, [dialogOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = (): void => {
    setEditing(undefined)
    setForm(emptyWorkerForm())
    setDialogOpen(true)
  }

  const openEdit = (worker: WorkerConfig): void => {
    setEditing(worker)
    setForm({
      name: worker.name, type: worker.type, enabled: worker.enabled,
      provider: worker.provider, model: worker.model, reasoningEffort: worker.reasoningEffort ?? '',
      baseUrl: worker.baseUrl, searchBaseUrl: worker.searchBaseUrl, apiKeyMode: worker.apiKeyMode,
      apiKeyEnv: worker.apiKeyEnv, apiKey: '',
    })
    setDialogOpen(true)
  }

  const selectedType = workerTypes.find(status => status.type === form.type)
  const typeAvailable = selectedType?.available === true
  const codexStatus = workerTypes.find(status => status.type === 'codex')
  const hasSavedApiKey = editing?.apiKeyMode === 'value' && editing.credentialSource === 'saved'
  const formValid = form.name.trim() !== '' && typeAvailable === true
    && (form.type === 'codex'
      || (form.apiKeyMode === 'environment'
        ? (form.apiKeyEnv?.trim() ?? '') !== ''
        : (form.apiKey?.trim() ?? '') !== '' || hasSavedApiKey === true))

  const save = async (): Promise<void> => {
    if (saving || !formValid) return
    setSaving(true)
    try {
      const path = editing === undefined ? `${baseUrl}/api/workers` : `${baseUrl}/api/workers/${encodeURIComponent(editing.id)}`
      const response = await fetch(path, {
        method: editing === undefined ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setDialogOpen(false)
      showToast(editing === undefined ? 'Worker 已添加' : 'Worker 已更新')
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setSaving(false)
    }
  }

  const saveOrder = async (ids: string[]): Promise<void> => {
    if (reordering || ids.every((id, index) => workers[index]?.id === id)) return
    setReordering(true)
    try {
      const response = await fetch(`${baseUrl}/api/workers/order`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      showToast('Worker 顺序已保存')
    } catch (error) {
      setDisplayedWorkers([...workers])
      showToast(`排序失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setReordering(false)
    }
  }

  const remove = async (worker: WorkerConfig): Promise<void> => {
    if (removing !== undefined || !window.confirm(`删除 Worker「${worker.name}」？`)) return
    setRemoving(worker.id)
    try {
      const response = await fetch(`${baseUrl}/api/workers/${encodeURIComponent(worker.id)}`, { method: 'DELETE' })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      showToast('Worker 已删除')
    } catch (error) {
      showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setRemoving(undefined)
    }
  }

  const selectedModel = modelCatalog?.models.find(model => model.id === (form.model || modelCatalog.defaultModel))
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? (form.type === 'dsh' ? modelCatalog?.models[0]?.reasoningEfforts ?? [] : [])
  const effectiveDefaultEffort = modelCatalog?.defaultReasoningEffort ?? selectedModel?.defaultReasoningEffort
  const modelPlaceholder = form.type === 'codex'
    ? (modelCatalog?.defaultModel === undefined ? '使用本机默认模型' : `本机默认：${modelCatalog.defaultModel}`)
    : (modelCatalog?.defaultModel ?? '模型名称')

  const riskyWorktrees = cleanupPreview?.candidates.filter(candidate => candidate.needsDecision) ?? []
  const cleanWorktreeCount = cleanupPreview?.candidates.filter(candidate => !candidate.needsDecision).length ?? 0
  const cleanupDeleteCount = cleanWorktreeCount + riskyWorktrees.filter(candidate => cleanupDecisions[candidate.name] === 'delete').length

  /* ── render ── */

  return (
    <>
      <div style={settingsHeaderStyle}>设置</div>
      <div style={settingsLayoutStyle}>
        <aside style={settingsNavStyle}>
          <button type="button" className="dshw-nav" style={section === 'repository' ? settingsNavActiveStyle : settingsNavItemStyle} onClick={() => { setSection('repository') }}>
            <GRepository size={12} />仓库管理
          </button>
          <button type="button" className="dshw-nav" style={section === 'workers' ? settingsNavActiveStyle : settingsNavItemStyle} onClick={() => { setSection('workers') }}>
            <GSettings size={12} />Workers
          </button>
        </aside>

        {section === 'repository' && (
          <section style={settingsSectionStyle}>
            <div style={settingsSectionHeaderStyle}>
              <span style={settingsSectionTitleStyle}>仓库管理</span>
              <span style={settingsSectionSubStyle}>dshw、主仓库与 Worktree</span>
              <button
                type="button"
                className="dshw-icon"
                style={{ ...smallIconButtonStyle, marginLeft: 'auto' }}
                title="刷新仓库状态"
                aria-label="刷新仓库状态"
                disabled={busy}
                onClick={refreshRepositoryState}
              >
                <GSync size={13} />
              </button>
            </div>
            <div style={settingsBodyStyle}>
              <div style={settingsCardStyle}>
              <div style={repoCardStyle}>
                <RepoRow
                  first
                  icon={<GDownload size={14} />}
                  title="更新 dshw"
                  detail="拉取最新代码、安装依赖并重新构建，然后安全重启服务"
                  note={dshwRepositoryLag()}
                  warn={(dshwRepository?.behind ?? 0) > 0 || dshwRepository?.dirty === true}
                  buttonLabel="更新并重启"
                  disabled={devMode || dshwRepository?.state !== 'ready' || dshwRepository?.dirty === true || dshwUpdateNoop}
                  onClick={() => { void post('/api/dshw/update', {}, 'update-dshw') }}
                />
                <RepoRow
                  icon={<GSync size={14} />}
                  title="同步主仓库"
                  detail="更新 deepseek-harness 仓库到最新上游"
                  note={repositoryLag()}
                  warn={(repository?.behind ?? 0) > 0 || repository?.dirty === true}
                  buttonLabel="立即同步"
                  disabled={harnessSyncNoop}
                  onClick={() => { void post('/api/update', {}, 'update-harness') }}
                />
                <RepoRow
                  icon={<GWorktree size={14} />}
                  title="清理 Worktree"
                  detail="删除不再对应 active PR 的 Worktree；本地内容会逐项确认"
                  note={worktreeSummary()}
                  warn={false}
                  buttonLabel={cleanupLoading ? '检查中' : '检查并清理'}
                  disabled={worktreeCleanupNoop}
                  onClick={() => { void inspectWorktreeCleanup() }}
                />
                <RepoRow
                  icon={<GReset size={14} />}
                  title="重新初始化工作环境"
                  detail="清理生成文件，更新 master，重新安装依赖并运行 typecheck"
                  note=""
                  warn={false}
                  buttonLabel="从头配置"
                  disabled={false}
                  onClick={confirmReconfigure}
                />
              </div>
              </div>
            </div>
          </section>
        )}

        {section === 'workers' && (
          <section style={settingsSectionStyle}>
            <div style={settingsSectionHeaderStyle}>
              <span style={settingsSectionTitleStyle}>Workers</span>
              <span style={settingsSectionSubStyle}>拖动排序 · 第一项为默认</span>
              <button type="button" style={addButtonStyle} onClick={openCreate}><GPlus size={12} />添加</button>
            </div>
            {workers.length === 0 ? (
              <div style={emptyStateStyle}>
                <span>暂无 Worker</span>
                <button type="button" className="dshw-link" style={actionLinkStyle} onClick={openCreate}>添加配置</button>
              </div>
            ) : (
              <div style={jobsScrollStyle}>
                <table style={{ ...tableStyle, minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, width: 34 }} />
                      <th style={{ ...thStyle, width: 110 }}>状态</th>
                      <th style={{ ...thStyle, width: 220 }}>名称</th>
                      <th style={{ ...thStyle, width: 140 }}>类型</th>
                      <th style={thStyle}>模型</th>
                      <th style={{ ...thStyle, width: 110 }}>推理</th>
                      <th style={thStyle}>Base URL</th>
                      <th style={{ ...thStyle, width: 130 }}>凭据</th>
                      <th style={{ ...thStyle, width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {displayedWorkers.map((worker, index) => (
                      <tr
                        key={worker.id}
                        draggable={worker.enabled && !reordering}
                        style={{ opacity: draggedId === worker.id ? 0.45 : 1 }}
                        onDragStart={(event) => {
                          if (!worker.enabled || reordering) return
                          setDraggedId(worker.id)
                          setDragOverId(worker.id)
                          event.dataTransfer.setData('text/plain', worker.id)
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={(event) => {
                          if (draggedId === undefined || !worker.enabled) return
                          event.preventDefault()
                          if (worker.id === dragOverId) return
                          const from = displayedWorkers.findIndex(candidate => candidate.id === draggedId)
                          const to = displayedWorkers.findIndex(candidate => candidate.id === worker.id)
                          if (from < 0 || to < 0) return
                          const reordered = [...displayedWorkers]
                          const [dragged] = reordered.splice(from, 1)
                          if (dragged !== undefined) reordered.splice(to, 0, dragged)
                          setDisplayedWorkers(reordered)
                          setDragOverId(worker.id)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          setDraggedId(undefined)
                          setDragOverId(undefined)
                          void saveOrder(displayedWorkers.map(candidate => candidate.id))
                        }}
                        onDragEnd={() => {
                          setDraggedId(undefined)
                          setDragOverId(undefined)
                          setDisplayedWorkers([...workers])
                        }}
                      >
                        <td style={tdCompactStyle}><span style={{ display: 'inline-flex', color: worker.enabled ? C_MUTED : C_FAINT, cursor: worker.enabled ? 'grab' : 'default' }}><GGrip size={13} /></span></td>
                        <td style={tdCompactStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: workerAvailable(worker) ? ok : C_MUTED }}>
                            <StatusDot tone={workerAvailable(worker) ? 'ok' : 'neutral'} />{workerStatus(worker)}
                          </span>
                        </td>
                        <td style={tdCompactStyle}>
                          <span style={workerNameStyle}>{worker.name}</span>
                          {index === 0 && worker.enabled && <span style={defaultBadgeStyle}>默认</span>}
                        </td>
                        <td style={tdCompactStyle}>
                          <span style={{ fontSize: 12, color: C_SECONDARY }}>{typeLabel(worker.type)}</span>
                          {worker.type === 'claude-code' && <span style={{ fontSize: 10.5, color: C_MUTED }}>未支持</span>}
                        </td>
                        <td style={tdCompactStyle}><span style={cellBlockStyle} title={worker.model}>{worker.model || '—'}</span></td>
                        <td style={tdCompactStyle}><span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C_SECONDARY }}>{worker.reasoningEffort || '默认'}</span></td>
                        <td style={tdCompactStyle}><span style={cellBlockStyle} title={worker.baseUrl}>{worker.type === 'dsh' ? worker.baseUrl || '默认' : '—'}</span></td>
                        <td style={tdCompactStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: worker.hasApiKey ? C_SECONDARY : warn }}>
                            <GKey size={11} />{credentialLabel(worker)}
                          </span>
                        </td>
                        <td style={tdCompactStyle}>
                          <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                            <button type="button" className="dshw-icon" style={smallIconButtonStyle} aria-label="编辑" onClick={() => { openEdit(worker) }}><GPencil size={12} /></button>
                            <button type="button" className="dshw-icon dshw-danger" style={{ ...smallIconButtonStyle, color: C_DANGER }} aria-label="删除" disabled={removing === worker.id} onClick={() => { void remove(worker) }}><GTrash size={12} /></button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>

      {cleanupDialogOpen && cleanupPreview !== undefined && (
        <WorktreeCleanupDialog
          preview={cleanupPreview}
          decisions={cleanupDecisions}
          loading={cleanupLoading}
          deleteCount={cleanupDeleteCount}
          cleanCount={cleanWorktreeCount}
          onDecision={(name, decision) => { setCleanupDecisions(current => ({ ...current, [name]: decision })) }}
          onClose={() => { setCleanupDialogOpen(false) }}
          onExecute={() => {
            void executeWorktreeCleanup(riskyWorktrees
              .filter(candidate => cleanupDecisions[candidate.name] === 'delete')
              .map(candidate => candidate.name))
          }}
        />
      )}

      {dialogOpen && (
        <WorkerFormDialog
          form={form}
          editing={editing}
          typeAvailable={typeAvailable === true}
          codexReason={codexStatus?.reason}
          modelCatalog={modelCatalog}
          modelLoading={modelLoading}
          modelError={modelError}
          modelPlaceholder={modelPlaceholder}
          reasoningEfforts={reasoningEfforts}
          effectiveDefaultEffort={effectiveDefaultEffort}
          hasSavedApiKey={hasSavedApiKey === true}
          formValid={formValid}
          saving={saving}
          onForm={(next) => { setForm(next) }}
          onClose={() => { setDialogOpen(false) }}
          onSave={() => { void save() }}
        />
      )}
    </>
  )
}

/** One repository-management row. */
function RepoRow({ first = false, icon, title, detail, note, warn, buttonLabel, disabled, onClick }: {
  first?: boolean
  icon: ReactNode
  title: string
  detail: string
  note: string
  warn: boolean
  buttonLabel: string
  disabled: boolean
  onClick: () => void
}): ReactNode {
  return (
    <div style={first ? { ...repoRowStyle, borderTop: 'none' } : repoRowStyle}>
      <span style={repoIconStyle}>{icon}</span>
      <div style={repoTextStyle}>
        <div style={repoTitleStyle}>
          <span>{title}</span>
          {note !== '' && <span style={{ fontSize: 10.5, fontWeight: 400, color: warn ? C_WARNING : C_MUTED }}>{note}</span>}
        </div>
        <div style={repoDetailStyle}>{detail}</div>
      </div>
      <button type="button" className="dshw-btn-default" style={repoButtonStyle} disabled={disabled} onClick={onClick}>{buttonLabel}</button>
    </div>
  )
}

/** Worktree cleanup confirmation dialog. */
function WorktreeCleanupDialog({ preview, decisions, loading, deleteCount, cleanCount, onDecision, onClose, onExecute }: {
  preview: WorktreeCleanupPreview
  decisions: Record<string, 'keep' | 'delete'>
  loading: boolean
  deleteCount: number
  cleanCount: number
  onDecision: (name: string, decision: 'keep' | 'delete') => void
  onClose: () => void
  onExecute: () => void
}): ReactNode {
  const risky = preview.candidates.filter(candidate => candidate.needsDecision)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  const detail = (candidate: WorktreeCleanupCandidate): string => {
    const parts = [
      candidate.staged ? '有暂存改动' : '',
      candidate.unstaged ? '有未提交改动' : '',
      candidate.merging ? '正在合并' : '',
      candidate.ahead > 0 ? `领先上游 ${candidate.ahead} 个提交` : '',
      candidate.inspectionError ? '状态检查失败' : '',
    ].filter(Boolean)
    return parts.join(' · ') || '需要人工确认'
  }
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <section style={{ ...dialogStyle, width: 620, maxHeight: '80vh' }} role="dialog" aria-modal="true" aria-label="清理 Worktree">
        <header style={dialogHeaderStyle}>
          <span style={jobDialogTitleStyle}>清理 Worktree</span>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}><GClose size={15} /></button>
        </header>
        <div style={{ padding: 14, overflow: 'auto' }}>
          <p style={{ margin: 0, fontSize: 11.5, color: C_MUTED }}>
            只处理不再对应 active PR、且没有运行中任务占用的 Worktree。
            {cleanCount > 0 ? ` ${cleanCount} 个无本地内容的 Worktree 将直接删除。` : ''}
          </p>
          <div style={{ marginTop: 12, marginBottom: 5, fontSize: 10.5, fontWeight: 600, color: C_SECONDARY }}>需要确认的本地内容</div>
          <div style={{ border: `1px solid ${C_BORDER}`, borderRadius: 8, overflow: 'auto', maxHeight: 320 }}>
            {risky.map(candidate => (
              <div key={candidate.name} style={cleanupRowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={cleanupNameStyle}>{candidate.name}</span>
                    <span style={cleanupBranchStyle}>{candidate.branch}</span>
                  </div>
                  <div style={{ marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: warn }} title={candidate.inspectionError}>
                    {detail(candidate)}
                  </div>
                </div>
                <select
                  style={cleanupSelectStyle}
                  value={decisions[candidate.name] ?? 'keep'}
                  onChange={event => { onDecision(candidate.name, event.target.value as 'keep' | 'delete') }}
                >
                  <option value="keep">保留</option>
                  <option value="delete">删除并丢弃</option>
                </select>
              </div>
            ))}
          </div>
        </div>
        <footer style={dialogFooterStyle}>
          <span style={{ fontSize: 10.5, color: C_MUTED }}>选择删除后不会保留 stash 或本地分支</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="dshw-btn-ghost" style={dialogActionButtonStyle} disabled={loading} onClick={onClose}>取消</button>
            <button type="button" style={primaryButtonStyle} disabled={loading || deleteCount === 0} onClick={onExecute}>
              {loading ? '清理中' : `清理 ${deleteCount} 个`}
            </button>
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

/** Worker add/edit dialog. */
function WorkerFormDialog({ form, editing, typeAvailable, codexReason, modelCatalog, modelLoading, modelError, modelPlaceholder, reasoningEfforts, effectiveDefaultEffort, hasSavedApiKey, formValid, saving, onForm, onClose, onSave }: {
  form: WorkerForm
  editing?: WorkerConfig
  typeAvailable: boolean
  codexReason?: string
  modelCatalog?: WorkerModelCatalog
  modelLoading: boolean
  modelError: string
  modelPlaceholder: string
  reasoningEfforts: readonly WorkerReasoningEffort[]
  effectiveDefaultEffort?: string
  hasSavedApiKey: boolean
  formValid: boolean
  saving: boolean
  onForm: (next: WorkerForm) => void
  onClose: () => void
  onSave: () => void
}): ReactNode {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  const set = (patch: Partial<WorkerForm>): void => { onForm({ ...form, ...patch }) }
  const effortOptions = [...reasoningEfforts]
  const current = form.reasoningEffort?.trim()
  if (current !== undefined && current !== '' && !effortOptions.some(option => option.id === current)) effortOptions.push({ id: current, name: current })
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <section style={{ ...dialogStyle, width: 560, maxHeight: '85vh', overflow: 'auto' }} role="dialog" aria-modal="true" aria-label={editing === undefined ? '添加 Worker' : '编辑 Worker'}>
        <header style={dialogHeaderStyle}>
          <span style={jobDialogTitleStyle}>{editing === undefined ? '添加 Worker' : '编辑 Worker'}</span>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}><GClose size={15} /></button>
        </header>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 12px', padding: 14 }}>
          <div style={{ gridColumn: '1 / -1', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: C_MUTED }}>基本</div>
          <label style={formFieldStyle}>
            <span style={formLabelStyle}>名称</span>
            <input autoFocus style={formInputStyle} placeholder="例如：日常 dsh" value={form.name}
              onChange={event => { set({ name: event.target.value }) }} />
          </label>
          <label style={formFieldStyle}>
            <span style={formLabelStyle}>类型</span>
            <select style={formInputStyle} value={form.type}
              onChange={event => { set({ type: event.target.value as WorkerForm['type'] }) }}>
              <option value="dsh">dsh</option>
              <option value="codex" disabled={!typeAvailable}>Codex{typeAvailable ? '' : '（不可用）'}</option>
              <option value="claude-code" disabled>Claude Code（未支持）</option>
            </select>
          </label>
          <label style={{ ...formFieldStyle, display: 'flex', alignItems: 'flex-end', gap: 6, paddingBottom: 6 }}>
            <input type="checkbox" disabled={!typeAvailable} checked={form.enabled === true}
              onChange={event => { set({ enabled: event.target.checked }) }} />
            启用
          </label>
          {!typeAvailable && codexReason !== undefined && (
            <div style={{ gridColumn: '1 / -1', fontSize: 11, color: C_MUTED }}>{codexReason}</div>
          )}
          <div style={{ gridColumn: '1 / -1', marginTop: 2, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: C_MUTED }}>模型</div>
          {form.type === 'dsh' && (
            <label style={formFieldStyle}>
              <span style={formLabelStyle}>Provider</span>
              <input style={formInputStyle} placeholder="deepseek-official" value={form.provider ?? ''}
                onChange={event => { set({ provider: event.target.value }) }} />
            </label>
          )}
          <label style={{ ...formFieldStyle, ...(form.type === 'codex' ? { gridColumn: '1 / -1' } : {}) }}>
            <span style={formLabelStyle}>模型{form.type === 'codex' ? '（可选）' : ''}</span>
            <input style={formInputStyle} list="dshw-worker-model-options" placeholder={modelPlaceholder} value={form.model ?? ''}
              onChange={event => { set({ model: event.target.value }) }} />
            <datalist id="dshw-worker-model-options">
              {modelCatalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </datalist>
          </label>
          <label style={{ ...formFieldStyle, gridColumn: '1 / -1' }}>
            <span style={formLabelStyle}>推理强度</span>
            <select style={formInputStyle} value={form.reasoningEffort ?? ''}
              onChange={event => { set({ reasoningEffort: event.target.value }) }}>
              <option value="">{effectiveDefaultEffort === undefined ? '使用默认值' : `默认（${effectiveDefaultEffort}）`}</option>
              {effortOptions.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
            </select>
          </label>
          {modelLoading && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: C_MUTED }}>正在读取可用模型…</div>}
          {modelError !== '' && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: warn }}>模型列表读取失败：{modelError}</div>}
          {form.type === 'dsh' && (
            <>
              <div style={{ gridColumn: '1 / -1', marginTop: 2, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: C_MUTED }}>连接</div>
              <label style={{ ...formFieldStyle, gridColumn: '1 / -1' }}>
                <span style={formLabelStyle}>Base URL</span>
                <input style={formInputStyle} type="url" placeholder="留空则使用 DEEPSEEK_BASE_URL" value={form.baseUrl ?? ''}
                  onChange={event => { set({ baseUrl: event.target.value }) }} />
              </label>
              <label style={{ ...formFieldStyle, gridColumn: '1 / -1' }}>
                <span style={formLabelStyle}>Search Base URL</span>
                <input style={formInputStyle} type="url" placeholder="留空则使用 DEEPSEEK_SEARCH_BASE_URL" value={form.searchBaseUrl ?? ''}
                  onChange={event => { set({ searchBaseUrl: event.target.value }) }} />
              </label>
              <label style={formFieldStyle}>
                <span style={formLabelStyle}>API Key 来源</span>
                <select style={formInputStyle} value={form.apiKeyMode}
                  onChange={event => { set({ apiKeyMode: event.target.value as WorkerForm['apiKeyMode'] }) }}>
                  <option value="value">直接输入</option>
                  <option value="environment">环境变量</option>
                </select>
              </label>
              {form.apiKeyMode === 'value' ? (
                <label style={formFieldStyle}>
                  <span style={formLabelStyle}>API Key</span>
                  <input style={formInputStyle} type="password" autoComplete="new-password"
                    placeholder={hasSavedApiKey ? '已保存；留空不变' : '输入 API Key'}
                    value={form.apiKey ?? ''}
                    onChange={event => { set({ apiKey: event.target.value }) }} />
                </label>
              ) : (
                <label style={formFieldStyle}>
                  <span style={formLabelStyle}>环境变量</span>
                  <input style={formInputStyle} placeholder="DEEPSEEK_API_KEY" value={form.apiKeyEnv ?? ''}
                    onChange={event => { set({ apiKeyEnv: event.target.value }) }} />
                </label>
              )}
            </>
          )}
        </div>
        <footer style={dialogFooterStyle}>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="dshw-btn-ghost" style={dialogActionButtonStyle} onClick={onClose}>取消</button>
            <button type="button" style={primaryButtonStyle} disabled={saving || !formValid} onClick={onSave}>
              {saving ? '保存中' : '保存'}
            </button>
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

/* ── settings styles ── */

const settingsHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  height: 40,
  padding: '0 14px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 13,
  fontWeight: 600,
  color: C_TEXT,
}

const settingsLayoutStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '144px minmax(0, 1fr)',
}

const settingsNavStyle: CSSProperties = {
  minHeight: 0,
  padding: 6,
  borderRight: `1px solid ${C_BORDER}`,
}

const settingsNavItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  height: 30,
  padding: '0 8px',
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  color: C_SECONDARY,
}

const settingsNavActiveStyle: CSSProperties = {
  ...settingsNavItemStyle,
  background: C_HOVER,
  color: C_TEXT,
}

const settingsSectionStyle: CSSProperties = { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }

const settingsSectionHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 40,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

const settingsSectionTitleStyle: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: C_TEXT }

const settingsSectionSubStyle: CSSProperties = { fontSize: 11, color: C_MUTED }

const settingsBodyStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' }

const settingsCardStyle: CSSProperties = {
  margin: '0 auto',
  width: '100%',
  maxWidth: 760,
  padding: 20,
  boxSizing: 'border-box',
}

const repoCardStyle: CSSProperties = {
  overflow: 'hidden',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 4,
}

const repoRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minHeight: 64,
  padding: '0 14px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${C_BORDER}`,
}

const repoIconStyle: CSSProperties = {
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  width: 28,
  height: 28,
  borderRadius: 8,
  fontSize: 11,
  background: C_HOVER,
  color: C_SECONDARY,
}

const repoTextStyle: CSSProperties = { flex: 1, minWidth: 0 }

const repoTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 12.5,
  fontWeight: 500,
  color: C_TEXT,
}

const repoDetailStyle: CSSProperties = { marginTop: 1, fontSize: 11, color: C_MUTED }

const repoButtonStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: C_HOVER,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: 'none',
  whiteSpace: 'nowrap',
  color: C_SECONDARY,
}

const addButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: C_ACCENT,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: 'none',
  whiteSpace: 'nowrap',
  color: '#fff',
}

const workerNameStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12.5,
  fontWeight: 500,
  color: C_TEXT,
}

const defaultBadgeStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  marginLeft: 6,
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: C_BADGE,
  color: C_BADGE_FG,
}

const cleanupRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 52,
  padding: '0 10px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

const cleanupNameStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 500, color: C_TEXT }

const cleanupBranchStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: C_MUTED }

const cleanupSelectStyle: CSSProperties = {
  flex: 'none',
  width: 148,
  height: 28,
  padding: '0 7px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  background: C_SURFACE,
  outline: 'none',
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: C_TEXT,
}

const primaryButtonStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: C_ACCENT,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  color: '#fff',
}

const formFieldStyle: CSSProperties = { display: 'block', fontSize: 11.5, color: C_SECONDARY }

const formLabelStyle: CSSProperties = { display: 'block', marginBottom: 4 }

const formInputStyle: CSSProperties = {
  width: '100%',
  height: 28,
  padding: '0 8px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  outline: 'none',
  background: C_SURFACE,
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: C_TEXT,
}

const smallIconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  border: 'none',
  borderRadius: 6,
  padding: 0,
  background: 'transparent',
  cursor: 'pointer',
  color: C_SECONDARY,
}
