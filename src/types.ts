export type JobStatus = 'queued' | 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled'
export type SyncStatus = 'active' | 'draft' | 'closed' | 'error'
export type CiStatus = 'none' | 'pending' | 'passed' | 'failed'
export type WorkerType = 'dsh' | 'codex' | 'claude-code'
export type ApiKeyMode = 'value' | 'environment'
export type CredentialSource = 'saved' | 'environment' | 'local' | 'missing'

export interface WorkerTypeAvailability {
  type: WorkerType
  available: boolean
  version?: string
  reason?: string
}

export interface WorkerReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface WorkerModelOption {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  reasoningEfforts: WorkerReasoningEffort[]
  defaultReasoningEffort?: string
}

export interface WorkerModelCatalog {
  type: WorkerType
  provider?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  models: WorkerModelOption[]
}

export interface WorkerConfig {
  id: string
  name: string
  type: WorkerType
  enabled: boolean
  isDefault: boolean
  provider?: string
  model?: string
  reasoningEffort?: string
  baseUrl?: string
  searchBaseUrl?: string
  apiKeyMode: ApiKeyMode
  apiKeyEnv?: string
  hasApiKey: boolean
  credentialSource: CredentialSource
  createdAt: string
  updatedAt: string
}

export interface WorkerConfigInput {
  name: string
  type: WorkerType
  enabled?: boolean
  provider?: string
  model?: string
  reasoningEffort?: string
  baseUrl?: string
  searchBaseUrl?: string
  apiKeyMode?: ApiKeyMode
  apiKeyEnv?: string
  apiKey?: string
}

export interface HarnessRepositoryStatus {
  state: 'ready' | 'error'
  checkedAt: string
  behind?: number
  dirty?: boolean
  error?: string
}

export interface DshwRepositoryStatus extends HarnessRepositoryStatus {
  upstream?: string
}

export interface WorktreeCleanupCandidate {
  name: string
  branch: string
  staged: boolean
  unstaged: boolean
  merging: boolean
  ahead: number
  behind: number
  needsDecision: boolean
  inspectionError?: string
}

export interface WorktreeCleanupPreview {
  total: number
  active: number
  busy: number
  candidates: WorktreeCleanupCandidate[]
}

export interface WorkerExecutionConfig {
  id: string
  name: string
  type: WorkerType
  provider?: string
  model?: string
  reasoningEffort?: string
  baseUrl?: string
  searchBaseUrl?: string
  apiKeyMode: ApiKeyMode
  apiKeyEnv?: string
  apiKey?: string
}

/** 一个被追踪 PR 的 worktree（git 是唯一真相源：运行时从
 *  `git worktree list` 枚举并推导，不落独立元数据文件）。 */
export interface CloneRecord {
  name: string
  path: string
  repoSlug: string
  /** PR head 分支（从 worktree 分支的 upstream 配置推导）。 */
  branch: string
  worktreeBranch: string
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
  type: 'update-dshw' | 'update-harness' | 'reconfigure-harness' | 'sync-check' | 'merge-base' | 'fix-ci' | 'resolve-comments' | 'custom'
  status: JobStatus
  syncId?: string
  /** Worker configuration name captured when the job starts. Missing for built-in and legacy jobs. */
  executor?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  cancelRequestedAt?: string
  /** Next periodic task-boundary reminder for a running Worker. */
  nextAgentSteerAt?: string
  summary: string
  output?: string
  /** Persisted field name retained for compatibility; may contain any Worker type. */
  dshWorker?: WorkerState
}

export interface WorkerHandle {
  runId: string
  label: string
  domain: string
  plistPath: string
  requestPath: string
  resultPath: string
  controlSocketPath?: string
  eventLogPath?: string
  runtimeCommit?: string
  /** Missing on older persisted handles, which are always dsh. */
  workerType?: WorkerType
  progressProtocol?: 'memory-events-v1' | 'session-control-v1'
  /** Legacy file-backed progress handle, retained only for state compatibility. */
  progressPath?: string
  startedAt: string
}

export interface WorkerProgress {
  runId: string
  phase: 'starting' | 'running' | 'cancelling' | 'paused' | 'finishing'
  message: string
  startedAt: string
  updatedAt: string
  outputTail: string
}

export interface WorkerState {
  handle: WorkerHandle
  kind: WorkerRunRecord['kind']
  sync: SyncRecord
  oldHead: string
  label: string
}

export interface WorkerRunRecord {
  id: string
  syncId: string
  kind: 'merge-base' | 'fix-ci' | 'resolve-comments' | 'custom'
  clonePath: string
  startedAt: string
  finishedAt: string
  status: 'succeeded' | 'blocked' | 'failed' | 'cancelled'
  finalOutput: string
  blockedReason?: string
}

/** Legacy type aliases retained for persisted state and older modules. */
export type DshWorkerHandle = WorkerHandle
export type DshWorkerProgress = WorkerProgress
export type DshWorkerState = WorkerState
export type DshRunRecord = WorkerRunRecord

export interface EventRecord {
  id: string
  time: string
  level: 'info' | 'warning' | 'error'
  kind: string
  message: string
}

export interface LogPage {
  records: EventRecord[]
  nextCursor?: string
  hasMore: boolean
}

export interface JobPage {
  records: JobRecord[]
  nextCursor?: string
  hasMore: boolean
}

/** 一个由 dshw 监控的 GitHub 仓库；数组顺序即各面板的展示顺序。 */
export interface MonitoredRepo {
  repoSlug: string
  enabled: boolean
}

export interface ServiceState {
  version: 3
  serviceStartedAt?: string
  update: {
    nextAt?: string
    lastAt?: string
    lastStatus?: 'succeeded' | 'failed'
    lastMessage?: string
  }
  /** 监控的 GitHub 仓库（顺序即展示顺序）；v2 迁移时以现有 sync 推断。 */
  repos: MonitoredRepo[]
  syncs: SyncRecord[]
  jobs: JobRecord[]
  dshRuns: DshRunRecord[]
  events: EventRecord[]
  /** Last usable dashboard snapshot, retained across daemon restarts. */
  prDashboardCache?: {
    records: PrDashboardRecord[]
    lastSuccessAt?: string
  }
  /** Last usable review-request snapshot, retained across daemon restarts. */
  reviewRequestsCache?: {
    records: ReviewRequestRecord[]
    lastSuccessAt?: string
  }
}

export interface PullRequestInfo {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author?: { login?: string }
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

/** `gh pr list --author @me` / `--assignee @me` 返回的轻量摘要，用于自动追踪发现。 */
export interface MyPullRequestSummary {
  number: number
  title: string
  url: string
  isDraft: boolean
  author?: { login?: string }
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
}

export interface ReviewRequestRecord {
  repoSlug: string
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

export interface CloneGitStatus {
  unstaged: boolean
  staged: boolean
  merging: boolean
  ahead: number
  behind: number
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
  /** PR 作者 login；非自己创建的 PR（assign 给我）会带上。 */
  author?: string
  /** PR assign 给我但不是由我创建（用于看板区分“我的 PR”和“assign 给我的 PR”）。 */
  assignedToMe?: boolean
  /** Exact remote PR head observed during the latest GitHub refresh. */
  headOid?: string
  /** PR-specific base snapshot observed during the latest GitHub refresh. */
  baseOid?: string
  mergeable: string
  mergeStateStatus: string
  conflictPaths?: string[]
  autoMergeSkippedReason?: string
  baseBehind?: boolean
  reviewDecision: string
  reviewRequests: string[]
  reviews: PullRequestReview[]
  reviewerComments: Record<string, ReviewerCommentProgress>
  ciStatus: CiStatus
  ciSummary: string
  checks: CiCheck[]
  localGitStatus?: CloneGitStatus
  syncId?: string
  syncEnabled?: boolean
  pendingBaseCheckAt?: string
  unresolvedComments?: number
  agentPausedReason?: string
  updatedAt: string
}

export interface GitGraphCommit {
  hash: string
  parents: string[]
  subject: string
  body: string
  author: {
    name: string
    email: string
    timestamp: number
  }
  refs: string[]
}

export interface GitGraphBranch {
  name: string
  label: string
  oid: string
  kind: 'master' | 'pr'
  number?: number
  title?: string
  url?: string
  isDraft?: boolean
}

export interface GitGraphSnapshot {
  repoSlug: string
  generatedAt: string
  commits: GitGraphCommit[]
  branches: GitGraphBranch[]
  truncated: boolean
}

export interface PrDashboardStatus {
  state: 'loading' | 'ready' | 'error'
  refreshing: boolean
  stale: boolean
  lastAttemptAt?: string
  lastSuccessAt?: string
  error?: string
  /** Exact event-log record containing the reason for the current error. */
  errorEventId?: string
}
