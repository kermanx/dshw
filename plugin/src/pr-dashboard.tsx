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
import type {
  CiCheck, CloneGitStatus, CloneRecord, DshWorkerProgress, HarnessRepositoryStatus,
  DshwRepositoryStatus, JobRecord, PrDashboardRecord, PrDashboardStatus, PullRequestReview,
  ReviewRequestRecord, ServiceState, WorkerConfig, WorkerTypeAvailability,
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

const ok = 'var(--dsw-alias-state-success-primary)'
const warn = 'var(--dsw-alias-state-warn-primary)'
const bad = 'var(--dsw-alias-state-error-primary)'
const faint = 'var(--dsw-alias-label-tertiary)'

const toneColor = (tone: Tone): string => tone === 'ok' ? ok : tone === 'warn' ? warn : tone === 'bad' ? bad : tone === 'accent' ? 'var(--dsw-alias-state-business-primary)' : faint

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

/** Colored status dot (StatusDot port). */
function StatusDot({ tone, pulse }: { tone: Tone; pulse?: boolean }): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-block', flex: 'none', width: 8, height: 8, borderRadius: '50%', background: toneColor(tone) }}
    />
  )
}

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

/* ── the dashboard ── */

export function PrDashboard({ baseUrl, refreshKey, t, onRefresh }: {
  baseUrl: string
  refreshKey: number
  t: (key: string, params?: Record<string, string | number>) => string
  onRefresh?: () => void
}): ReactNode {
  const { snapshot, connection } = useKanbanData(baseUrl, refreshKey)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<{ message: string; bad: boolean } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const [workerPick, setWorkerPick] = useState<{ cloneName: string; action: PrAction } | null>(null)

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
      chooseWorker(cloneName, action)
      return
    }
    void post('/api/pr-action', { name: cloneName, action }, `${action}:${cloneName}`)
  }

  const chooseWorker = (cloneName: string, action: PrAction): void => {
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

  const busyByPr = new Map(snapshot?.prs.map(pr => [pr, findBusyJob(pr, snapshot.jobs)]) ?? [])
  const workingAgentByPr = new Map(snapshot?.prs.map(pr => [pr, findWorkingAgent(pr, snapshot.jobs)]) ?? [])
  const prs = snapshot?.prs ?? []
  const status = snapshot?.prDashboard

  const refresh = (): void => {
    void post('/api/prs/refresh', {}, 'prs-refresh')
    onRefresh?.()
  }

  return (
    <div style={rootStyle}>
      {status !== undefined && status.state === 'error' && (
        <div style={errorStripStyle}>
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
                  onChooseWorker={chooseWorker}
                  onToggleSync={(name, enabled) => { void post('/api/sync/toggle', { name, enabled }, `sync-toggle:${name}`) }}
                  onGitAction={(name, action) => { void post('/api/clone/maintenance', { name, action }, `git-maintenance:${name}`) }}
                  onRefresh={refresh}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {workerPick !== null && snapshot !== undefined && (
        <WorkerPicker
          workers={snapshot.workers}
          workerTypes={snapshot.workerTypes}
          onClose={() => { setWorkerPick(null) }}
          onPick={startWithWorker}
        />
      )}

      {toast !== null && (
        <div style={toastStyle} role="status">{toast.message}</div>
      )}
    </div>
  )
}

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
  const row = (): ReactNode => (
    <tr style={trStyle}>
      <td style={tdStyle}>
        <div style={cellMainStyle}>
          <a style={titleLinkStyle} href={pr.url} title={pr.title} target="_blank" rel="noreferrer">
            <span style={numberStyle}>#{pr.number}</span>
            <span style={{ ...titleStyle, ...(pr.isDraft ? { color: 'var(--dsw-alias-label-secondary)' } : {}) }}>{pr.title}</span>
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
            <button type="button" style={pausedButtonStyle} title={pr.agentPausedReason} onClick={onRefresh}>
              自动任务已暂停 · 查看原因
            </button>
          )}
        </div>
      </td>
    </tr>
  )
  return pr.isDraft ? <tbody style={draftRowStyle}>{row()}</tbody> : <tbody>{row()}</tbody>
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
        <span style={busyRowStyle}><StatusDot tone="accent" pulse />修复中 · 查看</span>
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
              <StatusDot tone={checkTone(check)} />
              <span style={popoverRowTextStyle}>{check.name}</span>
              <span style={{ ...popoverRowBadgeStyle, color: toneColor(checkTone(check)) }}>{checkLabel(check)}</span>
            </a>
          ))}
        </div>
      )}>
        {(_, setOpen) => (
          <>
            <span style={statusGlyphStyle}><StatusDot tone={ciTone(pr.ciStatus)} /></span>
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
              style={actionLinkStyle}
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
        <span style={busyRowStyle}><StatusDot tone="accent" pulse />解决评论中 · 查看</span>
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
                <a key={`requested-${login}`} style={popoverPersonRowStyle} href={`https://github.com/${login}`} target="_blank" rel="noreferrer">
                  <img style={avatarStyle} src={avatar(login)} alt={login} />
                  <span style={popoverRowTextStyle}>@{login}</span>
                  <span style={{ ...popoverRowBadgeStyle, color: warn }}><StatusDot tone="warn" />等待 review</span>
                </a>
              ))}
            </div>
          )}
          {reviewed.length > 0 && (
            <div style={{ ...popoverSectionStyle, ...(requested.length > 0 ? popoverSectionSpacedStyle : {}) }}>
              <div style={popoverSectionTitleStyle}>已 Review</div>
              {reviewed.map(item => (
                <a key={`reviewed-${item.login}`} style={popoverPersonRowStyle} href={`${pr.url}/files`} target="_blank" rel="noreferrer">
                  <img style={avatarStyle} src={avatar(item.login)} alt={item.login} />
                  <span style={popoverRowTextStyle}>@{item.login}</span>
                  <span style={{ ...popoverRowBadgeStyle, color: toneColor(reviewStateTone(item.review, pr)) }}>
                    <StatusDot tone={reviewStateTone(item.review, pr)} />
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
            <span style={statusGlyphStyle}><StatusDot tone={reviewTone(pr.reviewDecision)} /></span>
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
              style={actionLinkStyle}
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
                <span style={statusGlyphStyle}><StatusDot tone="bad" /></span>
                <span style={statusTextStyle}>冲突</span>
                <span style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); setOpen(true) }} />
              </>
            )}
          </HoverPopover>
        )
        : (
          <span style={{ ...mergeableLabelStyle, color: toneColor(mergeTone(pr.mergeable)) }}>
            <StatusDot tone={mergeTone(pr.mergeable)} />
            {mergeLabel(pr.mergeable)}
          </span>
        )}
      {busyHere && (
        <span style={busyRowStyle}><StatusDot tone="accent" pulse />{busyLabel(busy)} · 查看</span>
      )}
      {!busyHere && autoAt !== undefined && (
        <div style={cellNoteRowStyle}>
          <span style={cellNoteStyle}>约 {autoMergeMinutes(pr)} 分钟</span>
          <span style={noteSeparatorStyle}>·</span>
          <button
            type="button"
            style={actionLinkStyle}
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
            style={actionLinkStyle}
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
        <span style={gitChipStyle}>{label}</span>
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
    <div style={dialogOverlayStyle} role="presentation">
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
  background: 'var(--dsw-alias-bg-base)',
}

const errorStripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 32,
  padding: '0 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'color-mix(in srgb, var(--dsw-alias-state-warn-tertiary) 60%, transparent)',
}

const errorStripTextStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary)' }

const loadingStripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 32,
  padding: '0 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 50%, var(--dsw-alias-interactive-bg-hover))',
}

const tableScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  padding: '0 16px 16px',
}

const tableStyle: CSSProperties = {
  width: '100%',
  minWidth: 900,
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
}

const thStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--dsw-alias-label-secondary)',
  position: 'sticky',
  top: 0,
  zIndex: 1,
  background: 'var(--dsw-alias-bg-base)',
}

const trStyle: CSSProperties = { }

const tdStyle: CSSProperties = {
  height: 54,
  padding: '5px 12px',
  verticalAlign: 'middle',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
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
  textDecoration: 'none',
}

const numberStyle: CSSProperties = { flex: 'none', fontFamily: 'monospace', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }

const titleStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  fontSize: 13,
  color: 'var(--dsw-alias-label-primary)',
}

const draftBadgeStyle: CSSProperties = {
  flex: 'none',
  padding: '1px 6px',
  borderRadius: 6,
  fontSize: 10,
  background: 'var(--dsw-alias-interactive-bg-hover)',
  color: 'var(--dsw-alias-label-secondary)',
}

const cellSubStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  marginTop: 2,
  fontFamily: 'monospace',
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
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
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'inherit',
  fontSize: 12.5,
  textAlign: 'left',
}

const statusGlyphStyle: CSSProperties = { display: 'inline-flex', flex: 'none' }

const statusTextStyle: CSSProperties = { whiteSpace: 'nowrap', color: 'inherit' }

const countStyle: CSSProperties = { flex: 'none', fontFamily: 'monospace', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }

const cellNoteRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }

const cellNoteStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const noteSeparatorStyle: CSSProperties = { flex: 'none', fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' }

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
  color: 'var(--dsw-alias-state-business-primary)',
  fontFamily: 'inherit',
}

const busyRowStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  width: 'fit-content',
  fontSize: 11.5,
  color: 'var(--dsw-alias-label-secondary)',
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
  background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-interactive-bg-hover-solid)',
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

const syncLabelStyle: CSSProperties = { fontSize: 12.5, whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)' }

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
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-base)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  boxSizing: 'border-box',
}

const popoverEmptyStyle: CSSProperties = { padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }

const popoverRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 26,
  padding: '0 8px',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  textDecoration: 'none',
}

const popoverRowTextStyle: CSSProperties = { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const popoverRowBadgeStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', fontSize: 11.5, whiteSpace: 'nowrap' }

const popoverSectionStyle: CSSProperties = { paddingBottom: 4 }

const popoverSectionSpacedStyle: CSSProperties = { marginTop: 3, paddingTop: 4, borderTop: '1px solid var(--dsw-alias-border-l2)' }

const popoverSectionTitleStyle: CSSProperties = { padding: '4px 7px', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--dsw-alias-label-tertiary)' }

const popoverPersonRowStyle: CSSProperties = { ...popoverRowStyle, minHeight: 32 }

const avatarStyle: CSSProperties = { width: 20, height: 20, borderRadius: '50%', flex: 'none', objectFit: 'cover', background: 'var(--dsw-alias-interactive-bg-hover)' }

const avatarStackStyle: CSSProperties = { display: 'inline-flex', flex: 'none', alignItems: 'center', paddingLeft: 3 }

const stackAvatarStyle: CSSProperties = { width: 16, height: 16, marginLeft: -3, borderRadius: '50%', flex: 'none', objectFit: 'cover', border: '1px solid var(--dsw-alias-bg-base)' }

const stackMoreStyle: CSSProperties = { marginLeft: 3, fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)' }

const conflictPathStyle: CSSProperties = { padding: '2px 0', fontFamily: 'monospace', fontSize: 11.5, lineHeight: 1.45, overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary)' }

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
  color: 'var(--dsw-alias-label-secondary)',
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

const dialogMaskStyle: CSSProperties = { position: 'absolute', inset: 0, background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent)' }

const dialogStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: 380,
  maxWidth: 'calc(100vw - 32px)',
  padding: 16,
  boxSizing: 'border-box',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-base)',
  boxShadow: 'var(--dsw-shadow-lv2)',
}

const dialogTitleStyle: CSSProperties = { marginBottom: 10, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }

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

const dialogWorkerNameStyle: CSSProperties = { fontSize: 13, color: 'var(--dsw-alias-label-primary)' }

const dialogWorkerTypeStyle: CSSProperties = { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' }

const dialogInputStyle: CSSProperties = {
  marginTop: 10,
  height: 34,
  padding: '0 10px',
  boxSizing: 'border-box',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  outline: 'none',
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--dsw-alias-label-primary)',
}

const dialogCloseRowStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginTop: 12 }

const dialogCancelStyle: CSSProperties = {
  height: 30,
  padding: '0 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: 'var(--dsw-alias-label-secondary)',
}

const emptyStateStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  height: '100%',
  minHeight: 200,
  color: 'var(--dsw-alias-label-tertiary)',
}

const emptyStateLineStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }

const emptyStateTitleStyle: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' }

const emptyStateSubStyle: CSSProperties = { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }

const toastStyle: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  zIndex: 140,
  maxWidth: 420,
  padding: '8px 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-base)',
  boxShadow: 'var(--dsw-shadow-lv2)',
  fontSize: 12.5,
  color: 'var(--dsw-alias-label-primary)',
}
