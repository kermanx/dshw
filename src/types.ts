export type JobStatus = 'queued' | 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled'
export type SyncStatus = 'active' | 'draft' | 'closed' | 'error'
export type CiStatus = 'none' | 'pending' | 'passed' | 'failed'

export interface CloneRecord {
  name: string
  path: string
  sourcePath: string
  remoteUrl: string
  repoSlug: string
  branch: string
  worktreeBranch: string
  createdAt: string
}

export interface SyncRecord {
  id: string
  cloneName: string
  clonePath: string
  remoteUrl: string
  repoSlug: string
  prNumber: number
  prUrl: string
  branch: string
  baseRefName: string
  /** PR-specific base snapshot reported by GitHub. */
  baseOid: string
  /** Latest target branch tip observed by the shared ref watcher. */
  observedBaseOid?: string
  headOid: string
  status: SyncStatus
  /** 自动 sync（冲突合并 / CI 修复）开关；缺省视为 true（兼容旧状态），自动追踪发现的 PR 初始为 false。 */
  enabled?: boolean
  pausedReason?: string
  agentPausedAt?: string
  agentPausedReason?: string
  createdAt: string
  updatedAt: string
  nextPrRefreshAt: string
  /** First target-branch push in the current debounce cycle; keeps repeated pushes from postponing forever. */
  pendingBaseCheckStartedAt?: string
  pendingBaseCheckAt?: string
  immediateCheckRequestedAt?: string
  ciMonitorHeadOid?: string
  nextCiCheckAt?: string
  noChecksSince?: string
  lastCiStatus?: CiStatus
  lastFixedHeadOid?: string
  lastError?: string
}

export interface JobRecord {
  id: string
  type: 'update-harness' | 'sync-check' | 'merge-base' | 'fix-ci' | 'resolve-comments'
  status: JobStatus
  syncId?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  cancelRequestedAt?: string
  summary: string
  output?: string
  dshWorker?: DshWorkerState
}

export interface DshWorkerHandle {
  runId: string
  label: string
  domain: string
  plistPath: string
  requestPath: string
  resultPath: string
  progressProtocol?: 'memory-events-v1'
  /** Legacy file-backed progress handle, retained only for state compatibility. */
  progressPath?: string
  startedAt: string
}

export interface DshWorkerProgress {
  runId: string
  phase: 'starting' | 'running' | 'finishing'
  message: string
  startedAt: string
  updatedAt: string
  outputTail: string
}

export interface DshWorkerState {
  handle: DshWorkerHandle
  kind: DshRunRecord['kind']
  sync: SyncRecord
  oldHead: string
  label: string
}

export interface DshRunRecord {
  id: string
  syncId: string
  kind: 'merge-base' | 'fix-ci' | 'resolve-comments'
  clonePath: string
  startedAt: string
  finishedAt: string
  status: 'succeeded' | 'blocked' | 'failed' | 'cancelled'
  finalOutput: string
  blockedReason?: string
}

export interface EventRecord {
  id: string
  time: string
  level: 'info' | 'warning' | 'error'
  kind: string
  message: string
}

export interface ServiceState {
  version: 2
  serviceStartedAt?: string
  update: {
    nextAt?: string
    lastAt?: string
    lastStatus?: 'succeeded' | 'failed'
    lastMessage?: string
  }
  syncs: SyncRecord[]
  jobs: JobRecord[]
  dshRuns: DshRunRecord[]
  events: EventRecord[]
}

export interface PullRequestInfo {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
  reviewDecision: string
  reviewRequests: PullRequestReviewRequest[]
  latestReviews: PullRequestReview[]
  statusCheckRollup: PullRequestCheck[]
}

export interface PullRequestReviewRequest {
  __typename?: string
  login?: string
}

/** `gh pr list --author @me` 返回的轻量摘要，用于自动追踪发现。 */
export interface MyPullRequestSummary {
  number: number
  title: string
  url: string
  isDraft: boolean
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
}

export interface ReviewRequestRecord {
  number: number
  title: string
  url: string
  isDraft: boolean
  author: string
  headRefName: string
  baseRefName: string
  updatedAt: string
}

export interface PullRequestReview {
  author?: { login?: string }
  state: string
  submittedAt?: string
}

export interface ReviewerCommentProgress {
  total: number
  resolved: number
}

export interface PullRequestCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  state?: string
  conclusion?: string
  detailsUrl?: string
  targetUrl?: string
  workflowName?: string
}

export interface CiCheck {
  name: string
  bucket: string
  state: string
  workflow: string
  link: string
}

export interface PrDashboardRecord {
  cloneName: string
  clonePath: string
  repoSlug: string
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  branch: string
  baseRefName: string
  mergeable: string
  mergeStateStatus: string
  conflictPaths?: string[]
  baseBehind?: boolean
  reviewDecision: string
  reviewRequests: string[]
  reviews: PullRequestReview[]
  reviewerComments: Record<string, ReviewerCommentProgress>
  ciStatus: CiStatus
  ciSummary: string
  checks: CiCheck[]
  syncId?: string
  syncEnabled?: boolean
  pendingBaseCheckAt?: string
  unresolvedComments?: number
  agentPausedReason?: string
  updatedAt: string
}
