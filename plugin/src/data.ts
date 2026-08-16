/** Kanban data layer: snapshot type, dshw format/pr-job-state ports, the
 *  /api/state + SSE data channel, and streaming-output merging. */
import { useEffect, useState } from 'react'
import type {
  CiCheck, CloneRecord, DshWorkerProgress, EventRecord, HarnessRepositoryStatus,
  DshwRepositoryStatus, JobRecord, MonitoredRepo, PrDashboardRecord, PrDashboardStatus,
  PullRequestReview, ReviewRequestRecord, ServiceState, WorkerConfig,
  WorkerTypeAvailability,
} from '../../src/types.ts'
import type { Tone } from './theme.ts'

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
  repos: MonitoredRepo[]
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
export type GitAction = 'discard-unstaged' | 'discard-staged' | 'abort-merge' | 'discard-unpushed' | 'pull'

/* ── labels / small derivations (ports of ui/src/format.ts + pr-job-state.ts) ── */

export const ciLabel = (value: string): string => ({ passed: '通过', failed: '失败', pending: '运行中', none: '无检查' })[value] ?? value
export const reviewLabel = (value: string): string => ({ APPROVED: '已批准', CHANGES_REQUESTED: '需修改', REVIEW_REQUIRED: '待 review' })[value] ?? '无要求'
export const mergeLabel = (value: string): string => ({ MERGEABLE: '可合并', CONFLICTING: '冲突', UNKNOWN: '计算中' })[value] ?? value

export const ciTone = (value: string): Tone => value === 'passed' ? 'ok' : value === 'failed' ? 'bad' : value === 'pending' ? 'warn' : 'neutral'
export const reviewTone = (value: string): Tone => value === 'APPROVED' ? 'ok' : value === 'CHANGES_REQUESTED' ? 'bad' : 'neutral'
export const mergeTone = (value: string): Tone => value === 'MERGEABLE' ? 'ok' : value === 'CONFLICTING' ? 'bad' : 'neutral'

/** conflict → agent merge; mergeable but behind base → direct merge+push. */
export function mergeAction(pr: PrDashboardRecord): PrAction | undefined {
  if (pr.mergeable === 'CONFLICTING') return 'merge-base'
  if (pr.mergeable === 'MERGEABLE' && pr.baseBehind === true) return 'merge-base-direct'
  return undefined
}

/** 冲突但处于 base push 后的静默期：到点会自动开始合并。 */
export function autoMergeAt(pr: PrDashboardRecord): string | undefined {
  if (pr.mergeable !== 'CONFLICTING' || pr.syncEnabled !== true || pr.pendingBaseCheckAt === undefined) return undefined
  return Date.parse(pr.pendingBaseCheckAt) > Date.now() ? pr.pendingBaseCheckAt : undefined
}

export function autoMergeMinutes(pr: PrDashboardRecord): number {
  const at = autoMergeAt(pr)
  return at === undefined ? 0 : Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 60_000))
}

export function belongsToPr(job: JobRecord, pr: PrDashboardRecord): boolean {
  return (pr.syncId !== undefined && job.syncId === pr.syncId)
    || job.summary.startsWith(`${pr.cloneName} / PR #${pr.number}`)
}

export function findBusyJob(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  const running = jobs.filter(job => job.status === 'running' && belongsToPr(job, pr))
  return running.find(job => job.type === 'fix-ci' || job.type === 'merge-base') ?? running[0]
}

export function findWorkingAgent(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  return jobs.find(job => job.status === 'running' && job.dshWorker !== undefined && belongsToPr(job, pr))
}

export function busyLabel(job?: JobRecord): string {
  return job?.type === 'fix-ci' ? '修复 CI' : job?.type === 'merge-base' ? '合并 base' : job?.type === 'resolve-comments' ? '解决评论' : '检查状态'
}

export function lastFailedMerge(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  const failed = jobs.filter(job => (
    job.syncId === pr.syncId
    && job.type === 'merge-base'
    && (job.status === 'failed' || job.status === 'blocked')
  ))
  return failed.at(-1)
}

export function hasLocalGitStatus(pr: PrDashboardRecord): boolean {
  const status = pr.localGitStatus
  return status !== undefined && (status.unstaged || status.staged || status.merging || status.ahead > 0 || status.behind > 0)
}
/* ── data channel: /api/state poll + /api/events SSE (use-workflow port) ── */

export function useKanbanData(baseUrl: string, refreshKey: number): { snapshot?: KanbanSnapshot; connection: 'connecting' | 'live' | 'reconnecting' } {
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
/* ── shared list helpers ── */

/** 被监控（enabled）的仓库，按展示顺序。 */
export function enabledRepos(snapshot?: KanbanSnapshot): MonitoredRepo[] {
  return snapshot?.repos.filter(repo => repo.enabled) ?? []
}

/** 把记录（PR / review）按 repo 分组，顺序遵循监控列表（未在列表中的 repo 排在最后）。 */
export function groupByRepo<T extends { repoSlug: string }>(
  records: readonly T[],
  repos: readonly MonitoredRepo[],
): Array<{ repoSlug: string; records: T[] }> {
  const byRepo = new Map<string, T[]>()
  for (const record of records) {
    const group = byRepo.get(record.repoSlug) ?? []
    group.push(record)
    byRepo.set(record.repoSlug, group)
  }
  const ordered = repos.filter(repo => repo.enabled).map(repo => repo.repoSlug)
  const extra = [...byRepo.keys()].filter(slug => !ordered.includes(slug)).sort()
  return [...ordered, ...extra].map(repoSlug => ({ repoSlug, records: byRepo.get(repoSlug) ?? [] }))
}

export function sortJobs(jobs: readonly JobRecord[]): JobRecord[] {
  return [...jobs].sort((left, right) => (
    Number(right.status === 'running') - Number(left.status === 'running')
    || Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || right.id.localeCompare(left.id)
  ))
}

export function mergeJobs(previous: readonly JobRecord[], incoming: readonly JobRecord[]): JobRecord[] {
  const byId = new Map(previous.map(job => [job.id, job]))
  for (const job of incoming) byId.set(job.id, job)
  return sortJobs([...byId.values()])
}

export function sortRecords(incoming: readonly EventRecord[]): EventRecord[] {
  return [...incoming].sort((left, right) => (
    Date.parse(right.time) - Date.parse(left.time) || right.id.localeCompare(left.id)
  ))
}

export function mergeRecords(previous: readonly EventRecord[], incoming: readonly EventRecord[]): EventRecord[] {
  const byId = new Map(previous.map(record => [record.id, record]))
  for (const record of incoming) byId.set(record.id, record)
  return sortRecords([...byId.values()])
}

export const jobLabel = (value: string): string =>
  ({ running: '运行中', succeeded: '已完成', blocked: '无法完成', failed: '失败', cancelled: '已终止', queued: '等待中' })[value] ?? value
export const jobTone = (value: string): Tone =>
  value === 'succeeded' ? 'ok' : value === 'failed' || value === 'blocked' ? 'bad' : value === 'running' ? 'warn' : 'neutral'
export const kindLabel = (value: string): string =>
  ({ 'merge-base': '合并 base', 'fix-ci': '修 CI', 'resolve-comments': '解决评论', 'update-dshw': '更新 dshw', 'update-harness': '更新 Harness', 'reconfigure-harness': '从头配置 Harness', 'sync-check': '状态检查' })[value] ?? value

export function jobExecutor(job: JobRecord): string {
  if (job.executor !== undefined) return job.executor
  if (job.dshWorker === undefined) return '内置'
  const type = job.dshWorker.handle.workerType
  return type === 'codex' ? 'Codex' : type === 'claude-code' ? 'Claude Code' : 'dsh'
}

export function relativeTimeLabel(value?: string, now = Date.now()): string {
  if (value === undefined) return '—'
  const time = Date.parse(value)
  if (Number.isNaN(time)) return '—'
  const seconds = Math.max(0, Math.floor((now - time) / 1000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3600)} 小时前`
}

export function shortTimeLabel(value?: string): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export const levelTone = (level: EventRecord['level']): Tone => level === 'error' ? 'bad' : level === 'warning' ? 'warn' : 'neutral'
export const levelLabel = (level: EventRecord['level']): string => level === 'error' ? '错误' : level === 'warning' ? '警告' : '信息'
/* ── shared helpers ── */

export function rank(check: CiCheck): number { return check.bucket === 'fail' || check.bucket === 'cancel' ? 0 : check.bucket === 'pending' ? 1 : 2 }
export function checkLabel(check: CiCheck): string { return check.bucket === 'pass' ? '通过' : check.bucket === 'pending' ? '运行中' : '失败' }
export function checkTone(check: CiCheck): Tone { return check.bucket === 'pass' ? 'ok' : check.bucket === 'pending' ? 'warn' : 'bad' }

export function reviewState(review: PullRequestReview, pr: PrDashboardRecord): string {
  const login = review.author?.login
  const progress = login === undefined ? undefined : pr.reviewerComments?.[login]
  if (progress !== undefined && progress.total > 0) return `${progress.resolved}/${progress.total}`
  return review.state === 'APPROVED' ? '已批准' : review.state === 'CHANGES_REQUESTED' ? '要求修改' : '已 review'
}

export function reviewStateTone(review: PullRequestReview, pr: PrDashboardRecord): Tone {
  const login = review.author?.login
  const progress = login === undefined ? undefined : pr.reviewerComments?.[login]
  if (progress !== undefined && progress.total > 0) return progress.resolved === progress.total ? 'ok' : 'warn'
  return review.state === 'APPROVED' ? 'ok' : review.state === 'CHANGES_REQUESTED' ? 'bad' : 'neutral'
}


/** Join a durable log page with the bounded live tail without duplicating their overlap. */
export function mergeProgressOutput(history: string, liveTail: string): string {
  if (history === '') return liveTail
  if (liveTail === '') return history
  if (history.endsWith(liveTail)) return history
  if (liveTail.startsWith(history)) return liveTail
  const limit = Math.min(history.length, liveTail.length)
  const pattern = liveTail.slice(0, limit)
  const prefix = new Int32Array(pattern.length)
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = prefix[matched - 1]!
    if (pattern[index] === pattern[matched]) matched += 1
    prefix[index] = matched
  }
  let overlap = 0
  const suffix = history.slice(-limit)
  for (let index = 0; index < suffix.length; index += 1) {
    const character = suffix[index]
    while (overlap > 0 && character !== pattern[overlap]) overlap = prefix[overlap - 1]!
    if (character === pattern[overlap]) overlap += 1
    if (overlap === pattern.length) overlap = prefix[overlap - 1]!
  }
  if (overlap > 0) return `${history}${liveTail.slice(overlap)}`
  return `${history}${history.endsWith('\n') ? '' : '\n'}${liveTail}`
}

/** Strip ANSI escapes from progress/log output. */
export function stripAnsi(value: unknown): string {
  return String(value ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
}

/** Progress phase label (format.ts phaseLabel). */
export function phaseLabel(value: string): string {
  return ({ starting: '正在启动', running: 'Agent 运行中', cancelling: '正在暂停', paused: '已暂停', finishing: '正在收尾' })[value] ?? '等待输出'
}

/** Elapsed wall time (format.ts elapsedTime). */
export function elapsedLabel(startValue?: string, endValue?: string, current = Date.now()): string {
  const start = startValue === undefined ? current : Date.parse(startValue)
  const end = endValue === undefined ? current : Date.parse(endValue)
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

/** Progress output block kinds (progress-output.ts). */
export type ProgressOutputKind = 'agent' | 'thinking' | 'user' | 'system' | 'tool-call' | 'tool-result' | 'step' | 'stderr' | 'plain'

export interface ProgressOutputBlock {
  kind: ProgressOutputKind
  title?: string
  body: string
  preview?: string
  failed?: boolean
}

/** Parse the bounded plain-text progress tail (progress-output.ts port). */
export function parseProgressOutput(output: string): ProgressOutputBlock[] {
  const blocks: ProgressOutputBlock[] = []
  let current: ProgressOutputBlock | undefined

  const flush = (): void => {
    if (current === undefined) return
    current.body = current.body.replace(/\n+$/u, '')
    current.preview = previewOf(current.body)
    blocks.push(current)
    current = undefined
  }

  for (const line of output.split('\n')) {
    const next = blockStart(line)
    if (next !== undefined) {
      flush()
      current = next
      continue
    }
    if (current === undefined) current = { kind: 'plain', body: line }
    else current.body += `${current.body === '' ? '' : '\n'}${line}`
  }
  flush()
  return blocks
}

export function blockStart(line: string): ProgressOutputBlock | undefined {
  if (line.startsWith('Agent：')) return { kind: 'agent', title: 'Agent', body: line.slice('Agent：'.length) }
  if (line.startsWith('思考：')) return { kind: 'thinking', title: '思考', body: line.slice('思考：'.length) }
  if (line.startsWith('用户指令：')) return { kind: 'user', title: '你', body: line.slice('用户指令：'.length) }
  if (line.startsWith('系统：')) return { kind: 'system', title: '系统', body: line.slice('系统：'.length) }

  const toolCall = /^调用工具 (.+?)：(.*)$/u.exec(line)
  if (toolCall !== null) return { kind: 'tool-call', title: toolCall[1] ?? 'unknown', body: toolCall[2] ?? '' }

  const toolResult = /^工具结果 (完成|失败(?:（.*?）)?)(?:：(.*))?$/u.exec(line)
  if (toolResult !== null) {
    const status = toolResult[1] ?? '完成'
    return {
      kind: 'tool-result',
      title: status,
      body: toolResult[2] ?? '',
      failed: status.startsWith('失败'),
    }
  }

  if (/^(?:开始任务（|步骤 .+ (?:开始|完成)$|任务结束：)/u.test(line)) {
    return { kind: 'step', body: line }
  }
  if (line.startsWith('[stderr]')) return { kind: 'stderr', body: line.slice('[stderr]'.length).trimStart() }
  return undefined
}

export function previewOf(body: string): string | undefined {
  const line = body.split('\n')
    .map(candidate => candidate.trim())
    .find(candidate => candidate !== '' && !['{', '}', '[', ']', '},', '],'].includes(candidate))
  if (line === undefined || line === '') return undefined
  return line.length <= 110 ? line : `${line.slice(0, 110)}…`
}
