import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_STEER_INTERVAL_MS,
  AUTO_REVIEW_ROOT,
  BASE_DEBOUNCE_MS,
  BASE_DEBOUNCE_MAX_MS,
  CI_WATCH_INTERVAL_MS,
  CLONES_ROOT,
  CODE_WORKSPACE_FILE,
  DEV_MODE,
  DSHW_ROOT,
  DSHW_UPDATE_CHECK_INTERVAL_MS,
  HARNESS_ROOT,
  HOST,
  LOG_ROOT,
  PORT,
  PR_DASHBOARD_INTERVAL_MS,
  PR_DISCOVERY_INTERVAL_MS,
  PR_REVIEW_INTERVAL_MS,
  PR_WATCH_INTERVAL_MS,
  REF_WATCH_INTERVAL_MS,
  SERVICE_LABEL,
  WORKSPACE_REFRESH_INTERVAL_MS,
} from './config.ts'
import { createPrClone, createReviewClone, listClones, removeClone } from './clone.ts'
import { readDshwRepositoryStatus } from './dshw-repository.ts'
import { cloneGitStatus, commitOid, currentHead, fetchBranch, fetchMergePreflight, fetchPullRequestHead, fetchRemoteBranchTip, gitCommonDir, isAncestor, isDocumentationConflictPath, maintainClone, mergeConflictPaths, remoteBranchOid, synchronizeMergeWorktree, synchronizeReviewWorktree } from './git.ts'
import type { CloneMaintenanceAction } from './git.ts'
import { assessCiAutoFix, ciChecks, dashboardOpenPullRequests, listUserRepos, pullRequest, reviewerCommentProgress, reviewRequestedPullRequests, rollupChecks, summarizeChecks, trackedOpenPullRequests } from './github.ts'
import { readHarnessRepositoryStatus } from './harness-repository.ts'
import { mergePrDashboardSyncState } from './pr-dashboard.ts'
import { readGitGraph } from './git-graph.ts'
import { StateStore } from './state.ts'
import { AutoReviewDiffCache } from './auto-review-diff.ts'
import { AutoReviewStore, countSeverities, dueReviews, formatFindings, MAX_AUTO_FIX_ROUNDS, observePrCommits, RECOMMENDED_REVIEW_MODELS, shouldAutoFix, withLiveFixStatus } from './auto-review.ts'
import { runReviews } from './review/engine.ts'
import { captureFixDiff, parseFixSummary } from './auto-review-fix.ts'
import { parseRoute, routePrompt, type FeishuRoute } from './feishu-route.ts'
import { estimatePricing } from './review/pricing.ts'
import { renderReviewPage, renderReviewPageMissing, type ReviewPageDiff } from './review-page.ts'
import { FeishuService, FeishuStore } from './feishu.ts'
import type { FeishuConfigInput } from './types.ts'
import { ensureManagedRoot } from './repos.ts'
import type { AutoReviewConfig, DshWorkerHandle, AutoReviewConfigInput, AutoReviewRecord, AutoReviewSummary, CiCheck, CloneGitStatus, CloneRecord, DshwRepositoryStatus, DshWorkerProgress, HarnessRepositoryStatus, JobRecord, MonitoredRepo, PrDashboardRecord, PrDashboardStatus, PullRequestInfo, ReviewRequestRecord, ReviewDiffManifest, SyncRecord, WorkerConfigInput, WorkerExecutionConfig, WorktreeCleanupCandidate, WorktreeCleanupPreview } from './types.ts'
import { after, id, isTaskCancelled, messageOf, now, run, runOrThrow, TaskCancelledError } from './util.ts'
import { refreshCodeWorkspace } from './workspace.ts'
import { seedDemoScenarios } from './dev-demo.ts'
import { assertManagedHarnessOwned, ensureInstallation, ensureManagedHarness, requireDaemonInstallation, type InstallationRecord } from './install.ts'
import { WorkerConfigStore } from './worker-config.ts'
import { WorkerRegistry } from './worker-driver.ts'
import { renderPeriodicAgentReminder, renderPromptTemplate, steerDshWorker, completeDshWorker, inspectDshWorker } from './dsh.ts'
import { renderReviewTurnPrompt } from './review-conversation.ts'
import { readFileAtHead, ReviewDiffCache } from './review-diff.ts'
import { highlightLines, shikiLangFor } from './syntax.ts'
import { reviewViewedKey, ReviewViewedStore } from './review-viewed.ts'

/** Cheap model used to route natural-language Feishu messages. */
const INTERPRET_MODEL = 'deepseek-flash'

const NO_CHECKS_GRACE_MS = 5 * 60 * 1000
const HISTORY_PAGE_SIZE = 35
const OUTPUT_PAGE_BYTES = 64 * 1024

interface OutputPage {
  output: string
  nextBefore?: number
  hasMore: boolean
}

export async function readOutputPage(path: string, before?: number, pageBytes = OUTPUT_PAGE_BYTES): Promise<OutputPage> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const end = Math.min(before ?? size, size)
    const start = Math.max(0, end - pageBytes)
    const buffer = Buffer.alloc(end - start)
    await file.read(buffer, 0, buffer.length, start)
    let contentStart = 0
    if (start > 0) {
      const newline = buffer.indexOf(0x0a)
      contentStart = newline < 0 ? 0 : newline + 1
    }
    const pageStart = start + contentStart
    return {
      output: buffer.subarray(contentStart).toString('utf8').trimEnd(),
      ...(pageStart > 0 ? { nextBefore: pageStart } : {}),
      hasMore: pageStart > 0,
    }
  } finally {
    await file.close()
  }
}

export function observeBaseTip(sync: SyncRecord, oid: string): 'initialized' | 'unchanged' | 'changed' {
  const previous = sync.observedBaseOid
  sync.observedBaseOid = oid
  if (previous === undefined) return 'initialized'
  return previous === oid ? 'unchanged' : 'changed'
}

export function scheduleBaseCheck(sync: SyncRecord, observedAt = Date.now()): string {
  const startedAt = sync.pendingBaseCheckStartedAt ?? new Date(observedAt).toISOString()
  sync.pendingBaseCheckStartedAt = startedAt
  const debounceAt = observedAt + BASE_DEBOUNCE_MS
  const mustCheckAt = Date.parse(startedAt) + BASE_DEBOUNCE_MAX_MS
  sync.pendingBaseCheckAt = new Date(Math.min(debounceAt, mustCheckAt)).toISOString()
  return sync.pendingBaseCheckAt
}

export function summarizePrDashboardErrors(messages: readonly string[]): string {
  const unique = [...new Set(messages
    .map(message => message.replace(/\s+/gu, ' ').trim())
    .filter(message => message !== '')
    .map(message => message.length <= 360 ? message : `${message.slice(0, 360)}…`))]
  if (unique.length === 0) return 'PR 状态刷新失败，原因未知'
  if (unique.length === 1) return unique[0]!
  return `${unique.length} 项刷新失败；${unique[0]}`
}

export function worktreeNeedsCleanupDecision(status: CloneGitStatus): boolean {
  return status.staged || status.unstaged || status.merging || status.ahead > 0
}

/** Count only running jobs that are visible in the Jobs view. */
export function countVisibleRunningJobs(jobs: readonly JobRecord[]): number {
  return jobs.filter(job => job.status === 'running' && job.type !== 'sync-check').length
}

export const HARNESS_RECONFIGURE_STEPS = [
  { command: 'git', args: ['clean', '-fdx'] },
  { command: 'git', args: ['pull', '--ff-only', 'origin', 'master'], timeoutMs: 5 * 60 * 1000 },
  { command: 'git', args: ['clean', '-fdx'] },
  { command: 'pnpm', args: ['install', '--frozen-lockfile'], timeoutMs: 10 * 60 * 1000 },
  { command: process.execPath, args: ['scripts/install-lefthook.mjs'] },
  { command: 'pnpm', args: ['run', 'typecheck'], timeoutMs: 10 * 60 * 1000 },
] as const

export const DSHW_UPDATE_STEPS = [
  { command: 'git', args: ['pull', '--ff-only'], timeoutMs: 5 * 60 * 1000 },
  { command: 'pnpm', args: ['install', '--frozen-lockfile'], timeoutMs: 10 * 60 * 1000 },
  { command: 'pnpm', args: ['run', 'typecheck'], timeoutMs: 10 * 60 * 1000 },
  { command: 'pnpm', args: ['run', 'build:plugin'], timeoutMs: 2 * 60 * 1000 },
] as const

function clearPendingBaseCheck(sync: SyncRecord): void {
  sync.pendingBaseCheckStartedAt = undefined
  sync.pendingBaseCheckAt = undefined
}

export async function runService(): Promise<void> {
  const installation = DEV_MODE ? await ensureInstallation() : await requireDaemonInstallation()
  // Offline development: the managed Harness clone is only needed by dsh
  // workers, so a UI-only run can skip the clone (and the network it needs).
  if (DEV_MODE && process.env.DSHW_DEV_SKIP_MANAGED_HARNESS !== '1') await ensureManagedHarness(installation)
  await mkdir(CLONES_ROOT, { recursive: true })
  const store = await StateStore.open()
  const workers = await WorkerConfigStore.open()
  const workerRegistry = await WorkerRegistry.create()
  const reviewViewed = await ReviewViewedStore.open()
  const autoReview = await AutoReviewStore.open()
  const feishu = await FeishuStore.open()
  store.state.serviceStartedAt = now()
  store.event('info', 'service', `后台服务已启动，监听 http://${HOST}:${PORT}`)
  await store.changed()
  const service = new WorkflowService(store, installation, workers, workerRegistry, reviewViewed, autoReview, feishu)
  await service.start()
}

class WorkflowService {
  readonly #store: StateStore
  readonly #installation: InstallationRecord
  readonly #workers: WorkerConfigStore
  readonly #workerRegistry: WorkerRegistry
  readonly #syncLocks = new Set<string>()
  readonly #externalDshSyncs = new Set<string>()
  readonly #jobControllers = new Map<string, AbortController>()
  readonly #sse = new Set<ServerResponse>()
  readonly #workerProgress = new Map<string, DshWorkerProgress>()
  readonly #agentSteersInFlight = new Set<string>()
  readonly #reviewActionsInFlight = new Set<string>()
  readonly #reviewViewed: ReviewViewedStore
  readonly #reviewDiffCache: ReviewDiffCache
  readonly #autoReview: AutoReviewStore
  readonly #autoReviewDiff = new AutoReviewDiffCache()
  /** Records whose review is running right now (one run per PR). */
  readonly #autoReviewRunning = new Set<string>()
  readonly #autoReviewControllers = new Map<string, AbortController>()
  readonly #feishu: FeishuService
  readonly #conflictPathsCache = new Map<string, Promise<string[]>>()
  #server: Server | undefined
  #timer: NodeJS.Timeout | undefined
  #progressFingerprint = ''
  #runningUpdate = false
  #updatingDshw = false
  #cleaningWorktrees = false
  #updatePromise: Promise<void> | undefined
  #draining = false
  #lastRefWatchAt = 0
  #lastWorkspaceRefreshAt = 0
  #workspaceRefreshPromise: Promise<void> | undefined
  #workspaceRefreshQueued = false
  #lastPrDashboardRefreshAt = 0
  #lastReviewProgressRefreshAt = 0
  #prDashboardRefreshPromise: Promise<void> | undefined
  #prDashboard: PrDashboardRecord[]
  #prDashboardStatus: PrDashboardStatus
  #reviewRequests: ReviewRequestRecord[]
  #reviewRequestsStatus: PrDashboardStatus
  #harnessRepository: HarnessRepositoryStatus
  #dshwRepository: DshwRepositoryStatus
  #lastDshwRepositoryRefreshAt = 0
  #dshwRepositoryRefreshPromise: Promise<void> | undefined
  #rateLimited = false
  #rateLimitResetAt: string | undefined
  #lastDiscoveryAt = 0
  #discoveryPromise: Promise<void> | undefined
  #monitoredRepos: MonitoredRepo[]
  /** 用户有权限的仓库列表缓存（gh 分页拉取较慢，避免每次进入设置面板都等十几秒）。 */
  #userReposCache: { repos: string[]; fetchedAt: number } | undefined

  constructor(store: StateStore, installation: InstallationRecord, workers: WorkerConfigStore, workerRegistry: WorkerRegistry, reviewViewed: ReviewViewedStore, autoReview: AutoReviewStore, feishu: FeishuStore) {
    this.#store = store
    this.#installation = installation
    this.#workers = workers
    this.#workerRegistry = workerRegistry
    this.#reviewViewed = reviewViewed
    this.#reviewDiffCache = new ReviewDiffCache(reviewViewed)
    this.#autoReview = autoReview
    this.#feishu = new FeishuService(feishu, {
      record: key => this.#autoReview.record(key),
      runReview: async (key) => { await this.#enqueueAutoReview(key) },
      startFix: async (key, instruction) => {
        const record = this.#autoReview.record(key)
        if (record === undefined) throw new Error('找不到这条自动评审记录')
        await this.#startAutoReviewFix(record, { automatic: false, ...(instruction === undefined ? {} : { instruction }) })
      },
      steerFix: async (key, instruction) => await this.#steerAutoReviewFix(key, instruction),
      interpret: async (key, message) => await this.#interpretFeishuMessage(key, message),
      pushFix: async (key: string) => {
        const record = this.#autoReview.record(key)
        if (record === undefined) throw new Error('找不到这条自动评审记录')
        await this.#pushAutoReviewFix(record)
      },
      fixHint: record => this.#autoReviewFixHint(record),
      event: (level, message) => { this.#store.event(level, 'feishu', message) },
    })
    this.#monitoredRepos = store.state.repos
    const cached = store.state.prDashboardCache
    this.#prDashboard = cached?.records ?? []
    this.#prDashboardStatus = {
      state: 'loading',
      refreshing: true,
      stale: cached !== undefined,
      ...(cached?.lastSuccessAt === undefined ? {} : { lastSuccessAt: cached.lastSuccessAt }),
    }
    const cachedReviews = store.state.reviewRequestsCache
    this.#reviewRequests = cachedReviews?.records ?? []
    this.#reviewRequestsStatus = {
      state: 'loading',
      refreshing: true,
      stale: cachedReviews !== undefined,
      ...(cachedReviews?.lastSuccessAt === undefined ? {} : { lastSuccessAt: cachedReviews.lastSuccessAt }),
    }
    this.#harnessRepository = { state: 'error', checkedAt: now(), error: '正在检查仓库' }
    this.#dshwRepository = { state: 'error', checkedAt: now(), error: '正在检查 dshw 更新' }
    store.onChange(() => this.#broadcast())
  }

  async start(): Promise<void> {
    // Offline development: show the reviewer with real local commits instead of
    // empty states. Both flags are required and never set by the launcher.
    if (DEV_MODE && process.env.DSHW_DEMO === '1') await this.#loadDemoScenario()
    this.#harnessRepository = await readHarnessRepositoryStatus()
    this.#dshwRepository = await readDshwRepositoryStatus(false)
    this.#server = createServer((request, response) => {
      void this.#route(request.method ?? 'GET', request.url ?? '/', request, response)
        .catch(error => this.#json(response, 500, { error: messageOf(error) }))
    })
    await new Promise<void>((resolve, reject) => {
      this.#server?.once('error', reject)
      this.#server?.listen(PORT, HOST, resolve)
    })
    this.#timer = setInterval(() => void this.#tick(), 5_000)
    this.#timer.unref()
    process.on('SIGTERM', () => void this.#drainAndExit())
    process.on('SIGINT', () => void this.#drainAndExit())
    this.#resumeDshJobs()
    this.#feishu.start()
    await this.#tick()
    await this.#refreshHarnessRepository()
    // 预热用户仓库列表缓存（gh 分页较慢），避免首次打开设置面板等待
    void this.#userRepos().catch(() => {})
    this.#broadcast()
  }

  async #route(
    method: string,
    url: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    // Cross-origin API access for the Harness Web plugin: the native kanban
    // panel fetches this API and opens the SSE stream from the harness page
    // origin. The server is loopback-only, so a wildcard origin is safe; JSON
    // POSTs need the preflight OPTIONS answer.
    if (url === '/api/identity' || url.startsWith('/api/')) {
      response.setHeader('access-control-allow-origin', '*')
      response.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      response.setHeader('access-control-allow-headers', 'content-type')
      response.setHeader('access-control-max-age', '86400')
      if (method === 'OPTIONS') {
        response.writeHead(204)
        response.end()
        return
      }
    }
    if (method === 'GET' && url === '/api/identity') {
      this.#json(response, 200, {
        product: 'dshw',
        installationId: this.#installation.id,
        dshwRoot: this.#installation.dshwRoot,
        serviceLabel: SERVICE_LABEL,
        port: PORT,
      })
      return
    }
    if (method === 'GET' && url === '/api/state') {
      this.#json(response, 200, await this.#snapshot())
      return
    }
    if (method === 'GET' && new URL(url, `http://${HOST}:${PORT}`).pathname === '/api/git-graph') {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      const requested = requestUrl.searchParams.get('repo') ?? undefined
      const enabled = this.#monitoredRepos.filter(repo => repo.enabled)
      const repo = requested === undefined
        ? enabled[0]
        : enabled.find(candidate => candidate.repoSlug === requested)
      if (requested !== undefined && repo === undefined) {
        this.#json(response, 404, { error: `未监控的仓库：${requested}` })
        return
      }
      if (repo === undefined) {
        this.#json(response, 200, await readGitGraph(HARNESS_ROOT, []))
        return
      }
      const root = await ensureManagedRoot(repo.repoSlug, this.#installation)
      const prs = this.#prDashboard.filter(pr => pr.repoSlug === repo.repoSlug)
      this.#json(response, 200, await readGitGraph(root, prs))
      return
    }
    if (method === 'GET' && url === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write(`data: ${JSON.stringify(await this.#snapshot())}\n\n`)
      this.#sse.add(response)
      response.on('close', () => this.#sse.delete(response))
      return
    }
    if (method === 'GET' && new URL(url, `http://${HOST}:${PORT}`).pathname === '/api/logs') {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      this.#json(response, 200, await this.#store.logs(requestUrl.searchParams.get('before') ?? undefined, HISTORY_PAGE_SIZE))
      return
    }
    if (method === 'GET' && new URL(url, `http://${HOST}:${PORT}`).pathname === '/api/jobs/output') {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      const beforeValue = requestUrl.searchParams.get('before')
      const before = beforeValue === null ? undefined : Number(beforeValue)
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new Error('输出分页游标无效')
      this.#json(response, 200, await this.#jobOutput(requestUrl.searchParams.get('jobId') ?? undefined, before))
      return
    }
    if (method === 'GET' && new URL(url, `http://${HOST}:${PORT}`).pathname === '/api/jobs') {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      this.#json(response, 200, this.#store.jobs(requestUrl.searchParams.get('before') ?? undefined, HISTORY_PAGE_SIZE))
      return
    }
    if (method === 'GET' && new URL(url, `http://${HOST}:${PORT}`).pathname === '/api/worker-models') {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      const type = requestUrl.searchParams.get('type')
      if (type !== 'dsh' && type !== 'codex' && type !== 'claude-code') throw new Error('未知 worker 类型')
      const provider = requestUrl.searchParams.get('provider') ?? undefined
      this.#json(response, 200, { catalog: await this.#workerRegistry.modelCatalog(type, provider) })
      return
    }
    if (method === 'GET' && url === '/api/workers') {
      this.#json(response, 200, { workers: this.#workers.list() })
      return
    }
    if (method === 'POST' && url === '/api/workers') {
      const input = await readBody(request) as unknown as WorkerConfigInput
      this.#workerRegistry.assertAvailable(input.type)
      const created = await this.#workers.create(input)
      this.#store.event('info', 'settings', `已添加 worker 配置「${created.name}」`)
      await this.#store.changed()
      this.#json(response, 201, { worker: created })
      return
    }
    if (method === 'PUT' && url === '/api/workers/order') {
      const body = await readBody(request)
      if (!Array.isArray(body.ids) || body.ids.some(value => typeof value !== 'string')) throw new Error('ids must be a string array')
      const workers = await this.#workers.reorder(body.ids)
      this.#store.event('info', 'settings', `worker 顺序已更新；默认使用「${workers[0]?.name ?? '无'}」`)
      await this.#store.changed()
      this.#json(response, 200, { workers })
      return
    }
    if (method === 'PUT' && url.startsWith('/api/workers/') && url.endsWith('/default')) {
      const configId = decodeURIComponent(url.slice('/api/workers/'.length, -'/default'.length))
      const selected = await this.#workers.setDefault(configId)
      this.#store.event('info', 'settings', `默认 worker 已切换为「${selected.name}」`)
      await this.#store.changed()
      this.#json(response, 200, { worker: selected })
      return
    }
    if ((method === 'PUT' || method === 'DELETE') && url.startsWith('/api/workers/')) {
      const configId = decodeURIComponent(url.slice('/api/workers/'.length))
      if (method === 'DELETE') {
        await this.#workers.remove(configId)
        this.#store.event('info', 'settings', '已删除 worker 配置')
        await this.#store.changed()
        this.#json(response, 200, { deleted: true })
      } else {
        const input = await readBody(request) as unknown as WorkerConfigInput
        this.#workerRegistry.assertAvailable(input.type)
        const updated = await this.#workers.update(configId, input)
        this.#store.event('info', 'settings', `已更新 worker 配置「${updated.name}」`)
        await this.#store.changed()
        this.#json(response, 200, { worker: updated })
      }
      return
    }
    if (method === 'POST' && url === '/api/syntax') {
      const body = await readBody(request)
      const path = bodyString(body, 'path')
      const rawLines = body.lines
      if (path === undefined || path.length > 2_000) throw new Error('syntax.path 无效')
      if (!Array.isArray(rawLines)) throw new Error('syntax.lines must be an array')
      if (rawLines.length > 2_000) throw new Error('单次最多着色 2000 行')
      const lines: string[] = []
      for (const line of rawLines) {
        if (typeof line !== 'string' || line.length > 4_000) throw new Error('syntax.lines 内容无效')
        lines.push(line)
      }
      const lang = shikiLangFor(path)
      // 逐行去重，减小请求与服务端缓存压力。
      const unique = [...new Set(lines)]
      const tokenized = lang === undefined
        ? undefined
        : await highlightLines(lang, unique)
      const byText = new Map<string, unknown>()
      if (tokenized !== undefined) {
        unique.forEach((text, index) => { byText.set(text, tokenized[index]) })
      }
      this.#json(response, 200, {
        lang: lang?.id ?? null,
        tokens: lines.map(text => (byText.get(text) ?? null)),
      })
      return
    }
    if (method === 'POST' && url === '/api/worker-progress') {
      const body = await readBody(request)
      this.#acceptWorkerProgress(body)
      response.writeHead(204)
      response.end()
      return
    }
    if (method === 'POST' && url === '/api/sync/toggle') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      const body = await readBody(request)
      const clone = await findClone(bodyString(body, 'name'))
      const enabled = body.enabled === true
      const sync = await this.#setSyncEnabled(clone, enabled)
      this.#json(response, 200, { syncId: sync.id, enabled: sync.enabled === true })
      return
    }
    if (method === 'GET' && url === '/api/repos') {
      this.#json(response, 200, { repos: this.#monitoredRepos })
      return
    }
    if (method === 'GET' && url === '/api/repos/available') {
      const available = await this.#userRepos()
      this.#json(response, 200, { repos: available })
      return
    }
    if (method === 'PUT' && url === '/api/repos') {
      const body = await readBody(request)
      const incoming = body.repos
      if (!Array.isArray(incoming) || incoming.some(value => (
        typeof value !== 'object' || value === null
        || typeof (value as { repoSlug?: unknown }).repoSlug !== 'string'
        || typeof (value as { enabled?: unknown }).enabled !== 'boolean'
      ))) {
        throw new Error('repos must be an array of { repoSlug, enabled }')
      }
      const seen = new Set<string>()
      const next: MonitoredRepo[] = (incoming as Array<{ repoSlug: string; enabled: boolean }>).map(value => {
        const repoSlug = value.repoSlug.trim()
        if (!/^[^/]+\/[^/]+$/u.test(repoSlug)) throw new Error(`无效的 GitHub 仓库：${JSON.stringify(repoSlug)}`)
        if (seen.has(repoSlug)) throw new Error(`重复的仓库：${repoSlug}`)
        seen.add(repoSlug)
        return { repoSlug, enabled: value.enabled }
      })
      const previouslyEnabled = new Set(this.#monitoredRepos.filter(repo => repo.enabled).map(repo => repo.repoSlug))
      const newlyEnabled = next.filter(repo => repo.enabled && !previouslyEnabled.has(repo.repoSlug))
      this.#monitoredRepos = next
      this.#store.state.repos = next
      const summary = next.filter(repo => repo.enabled).map(repo => repo.repoSlug).join('、') || '无'
      this.#store.event('info', 'settings', `监控仓库已更新：${summary}`)
      await this.#store.changed()
      if (newlyEnabled.length > 0) {
        this.#lastDiscoveryAt = 0
        void this.#discoverMyPrs()
      }
      this.#lastPrDashboardRefreshAt = 0
      void this.#refreshPrDashboard()
      this.#json(response, 200, { repos: next })
      return
    }
    if (method === 'POST' && url === '/api/prs/refresh') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      this.#lastReviewProgressRefreshAt = 0
      await this.#discoverMyPrs()
      await this.#refreshPrDashboard()
      this.#json(response, 202, { accepted: true, prs: this.#prDashboard.length })
      return
    }
    if (method === 'POST' && url === '/api/clone/maintenance') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      const body = await readBody(request)
      const clone = await findClone(bodyString(body, 'name'))
      const action = bodyString(body, 'action') as CloneMaintenanceAction | undefined
      if (action !== 'discard-unstaged' && action !== 'discard-staged' && action !== 'abort-merge' && action !== 'discard-unpushed' && action !== 'pull') {
        throw new Error('未知 clone 维护操作')
      }
      const sync = this.#store.state.syncs.find(candidate => candidate.clonePath === clone.path)
      if (sync !== undefined && this.#syncLocks.has(sync.id)) throw new Error(`${clone.name} 已有任务执行中`)
      await maintainClone(clone.path, clone.branch, action)
      const label = action === 'discard-unstaged'
        ? '已撤销未暂存更改'
        : action === 'discard-staged'
          ? '已撤销未提交更改'
          : action === 'abort-merge'
            ? '已终止 merge'
            : action === 'discard-unpushed' ? '已丢弃未推送提交' : '已拉取远端提交'
      this.#store.event('info', 'clone-maintenance', `${clone.name}: ${label}`)
      await this.#refreshPrDashboardAfterAction()
      this.#json(response, 200, { completed: true })
      return
    }
    if (method === 'POST' && url === '/api/repository/refresh') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      if (this.#updatePromise !== undefined || this.#updatingDshw || this.#cleaningWorktrees) throw new Error('仓库维护任务正在运行，请等待完成')
      await Promise.all([
        this.#refreshDshwRepository(true),
        this.#refreshHarnessRepository(true),
        (async () => {
          await this.#discoverMyPrs()
          await this.#refreshPrDashboard()
        })(),
      ])
      this.#broadcast()
      this.#json(response, 200, { refreshed: true })
      return
    }
    if (method === 'POST' && url === '/api/worktrees/cleanup/preview') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      if (this.#updatePromise !== undefined || this.#updatingDshw || this.#cleaningWorktrees) throw new Error('仓库维护任务正在运行，请等待完成')
      this.#json(response, 200, await this.#scanWorktreeCleanup())
      return
    }
    if (method === 'POST' && url === '/api/worktrees/cleanup') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      if (this.#updatePromise !== undefined || this.#updatingDshw || this.#cleaningWorktrees) throw new Error('仓库维护任务正在运行，请等待完成')
      const body = await readBody(request)
      if (!Array.isArray(body.deleteDirty) || body.deleteDirty.some(value => typeof value !== 'string')) {
        throw new Error('deleteDirty must be a string array')
      }
      this.#cleaningWorktrees = true
      try {
        this.#json(response, 200, await this.#cleanupWorktrees(body.deleteDirty))
      } finally {
        this.#cleaningWorktrees = false
      }
      return
    }
    if (method === 'POST' && url === '/api/jobs/cancel') {
      const body = await readBody(request)
      const cancelled = await this.#cancelJob(bodyString(body, 'jobId'))
      this.#json(response, 202, { cancelled })
      return
    }
    if (method === 'POST' && url === '/api/jobs/pause') {
      const body = await readBody(request)
      await this.#pauseDshJob(bodyString(body, 'jobId'))
      this.#json(response, 202, { accepted: true })
      return
    }
    if (method === 'POST' && url === '/api/jobs/steer') {
      const body = await readBody(request)
      await this.#steerDshJob(bodyString(body, 'jobId'), bodyString(body, 'prompt'))
      this.#json(response, 202, { accepted: true })
      return
    }
    if (method === 'POST' && url === '/api/jobs/finish') {
      const body = await readBody(request)
      await this.#finishReviewConversation(bodyString(body, 'jobId'))
      this.#json(response, 202, { accepted: true })
      return
    }
    if (method === 'POST' && url === '/api/pr-action') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      const body = await readBody(request)
      const name = bodyString(body, 'name')
      const action = bodyString(body, 'action')
      if (action !== 'merge-base' && action !== 'fix-ci' && action !== 'merge-base-direct' && action !== 'resolve-comments' && action !== 'custom') throw new Error('未知 PR 操作')
      const clone = await findClone(name)
      const sync = await this.#manualSync(clone)
      if (action === 'merge-base' || action === 'merge-base-direct') {
        const additionalInstruction = bodyString(body, 'additionalInstruction')?.trim()
        if ((additionalInstruction?.length ?? 0) > 4_000) throw new Error('额外指令不能超过 4000 个字符')
        this.#startManualMergeBase(sync, bodyString(body, 'workerConfigId'), additionalInstruction)
      } else {
        const workerConfig = this.#workers.executionConfig(bodyString(body, 'workerConfigId'))
        const additionalInstruction = bodyString(body, 'additionalInstruction')?.trim()
        if ((additionalInstruction?.length ?? 0) > 4_000) throw new Error('额外指令不能超过 4000 个字符')
        if (action === 'custom' && (additionalInstruction === undefined || additionalInstruction === '')) throw new Error('自定义任务指令不能为空')
        this.#workerRegistry.assertAvailable(workerConfig.type)
        this.#startManualAction(sync, action, workerConfig, additionalInstruction)
      }
      this.#json(response, 202, { accepted: true, syncId: sync.id })
      return
    }


    if (url.startsWith('/api/feishu')) {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      const path = requestUrl.pathname
      if (method === 'GET' && path === '/api/feishu') {
        this.#json(response, 200, {
          config: this.#feishu.publicConfig(),
          threads: this.#feishu.threads(),
        })
        return
      }
      if (method === 'PUT' && path === '/api/feishu/config') {
        const input = await readBody(request) as unknown as FeishuConfigInput
        const config = await this.#feishu.updateConfig(input)
        this.#store.event('info', 'feishu', `飞书通知设置已更新：${config.enabled ? '已开启' : '已关闭'}`)
        await this.#store.changed()
        this.#json(response, 200, { config: this.#feishu.publicConfig() })
        return
      }
      if (method === 'POST' && path === '/api/feishu/check') {
        const status = await this.#feishu.check()
        await this.#store.changed()
        this.#json(response, 200, { status })
        return
      }
      if (method === 'POST' && path === '/api/feishu/chat') {
        const body = await readBody(request)
        const name = bodyString(body, 'name')?.trim() ?? ''
        if (name === '' || name.length > 60) throw new Error('话题群名称需要在 1 到 60 个字符之间')
        const status = await this.#feishu.check()
        if (status.botReady !== true) throw new Error(status.error ?? 'lark-cli 的机器人身份不可用，请先登录')
        const created = await this.#feishu.createTopicChat(name)
        this.#store.event('info', 'feishu', `已创建飞书话题群「${created.chatName}」`)
        await this.#store.changed()
        this.#json(response, 200, created)
        return
      }
      if (method === 'POST' && path === '/api/feishu/test') {
        const body = await readBody(request)
        const text = bodyString(body, 'text')?.trim() === undefined || bodyString(body, 'text')?.trim() === ''
          ? '**dshw 测试消息**\n\n飞书机器人已连通；之后每个 PR 的进展都会发在这里。'
          : bodyString(body, 'text')!.trim()
        await this.#feishu.sendTest(text)
        this.#store.event('info', 'feishu', '已发送一条飞书测试消息')
        await this.#store.changed()
        this.#json(response, 200, { sent: true })
        return
      }
      if (method === 'POST' && path === '/api/feishu/origin') {
        const body = await readBody(request)
        const origin = bodyString(body, 'origin')?.trim() ?? ''
        if (origin !== '') {
          const parsedOrigin = new URL(origin)
          if (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') {
            const current = this.#feishu.config()
            if (current.webBaseUrl !== origin) await this.#feishu.updateConfig({ webBaseUrl: origin })
          }
        }
        this.#json(response, 200, { config: this.#feishu.publicConfig() })
        return
      }
      if (method === 'POST' && path === '/api/feishu/thread/forget') {
        const body = await readBody(request)
        const key = bodyString(body, 'key')
        if (key === undefined) throw new Error('缺少 key')
        const thread = this.#feishu.thread(key)
        if (thread === undefined) throw new Error('找不到这个话题')
        const store = this.#feishu.store()
        await store.removeThread(key)
        await this.#store.changed()
        this.#json(response, 200, { removed: true })
        return
      }
      throw new Error(`未知的飞书请求：${method} ${path}`)
    }
    if (url.startsWith('/api/auto-review')) {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      const path = requestUrl.pathname
      const recordId = requestUrl.searchParams.get('id') ?? undefined
      const record = recordId === undefined ? undefined : this.#autoReview.record(recordId)
      if (method === 'GET' && path === '/api/auto-review/config') {
        this.#json(response, 200, { config: this.#autoReview.config() })
        return
      }
      if (method === 'PUT' && path === '/api/auto-review/config') {
        const input = await readBody(request) as unknown as AutoReviewConfigInput
        const config = await this.#autoReview.updateConfig(input)
        this.#store.event('info', 'auto-review', `自动评审设置已更新：${config.enabled ? '已开启' : '已关闭'}`)
        await this.#store.changed()
        this.#json(response, 200, { config })
        return
      }
      if (method === 'GET' && path === '/api/auto-review/record') {
        if (record === undefined) throw new Error('找不到这条自动评审记录')
        this.#json(response, 200, { record: withLiveFixStatus(record, this.#store.state.jobs) })
        return
      }

      if (method === 'GET' && path === '/api/auto-review/models') {
        this.#json(response, 200, await this.#autoReviewModels())
        return
      }
      if (method === 'GET' && path === '/api/auto-review/github') {
        this.#json(response, 200, await this.#autoReviewGithubStatus())
        return
      }
      if (method === 'GET' && path === '/api/auto-review/diff') {
        if (record === undefined) throw new Error('找不到这条自动评审记录')
        const pr = this.#prDashboard.find(candidate => candidate.repoSlug === record.repoSlug && candidate.number === record.number)
        if (pr === undefined) throw new Error('PR 不在当前看板中，无法读取改动')
        const manifest = await this.#autoReviewDiff.open(record, pr.clonePath, { refresh: requestUrl.searchParams.get('refresh') === '1' })
        if (requestUrl.searchParams.has('file')) {
          const payload = this.#autoReviewDiff.payload(requestUrl.searchParams.get('token') ?? '', Number(requestUrl.searchParams.get('file')))
          if (payload === undefined) throw new Error('该 diff 已失效，请重新打开')
          this.#json(response, 200, payload)
        } else {
          this.#json(response, 200, manifest)
        }
        return
      }
      if (method !== 'POST') throw new Error(`未知的自动评审请求：${method} ${path}`)
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      const body = await readBody(request)
      const bodyId = bodyString(body, 'id') ?? recordId
      if (path === '/api/auto-review/run') {
        const target = bodyId === undefined ? undefined : this.#autoReview.record(bodyId)
        if (target === undefined) throw new Error('找不到这条自动评审记录')
        target.status = 'pending'
        target.trigger = 'manual'
        target.dueAt = now()
        target.skippedReason = undefined
        target.updatedAt = now()
        await this.#autoReview.saveRecord(target)
        await this.#store.changed()
        this.#json(response, 202, { accepted: true })
        return
      }
      if (path === '/api/auto-review/cancel') {
        const controller = bodyId === undefined ? undefined : this.#autoReviewControllers.get(bodyId)
        if (controller === undefined) throw new Error('这条记录没有正在进行的评审')
        controller.abort()
        this.#json(response, 202, { accepted: true })
        return
      }
      if (path === '/api/auto-review/fix') {
        const target = bodyId === undefined ? undefined : this.#autoReview.record(bodyId)
        if (target === undefined) throw new Error('找不到这条自动评审记录')
        const instruction = bodyString(body, 'instruction')?.trim()
        if ((instruction?.length ?? 0) > 4_000) throw new Error('补充指令不能超过 4000 个字符')
        await this.#startAutoReviewFix(target, { automatic: false, ...(instruction === undefined ? {} : { instruction }) })
        this.#json(response, 202, { accepted: true })
        return
      }
      if (path === '/api/auto-review/forget') {
        if (bodyId === undefined) throw new Error('缺少 id')
        const removed = await this.#autoReview.removeRecord(bodyId)
        if (!removed) throw new Error('找不到这条自动评审记录')
        await this.#store.changed()
        this.#json(response, 200, { removed: true })
        return
      }
      if (path === '/api/auto-review/clear') {
        await this.#autoReview.clearRecords()
        this.#store.event('info', 'auto-review', '已清空自动评审记录')
        await this.#store.changed()
        this.#json(response, 200, { cleared: true })
        return
      }
      throw new Error(`未知的自动评审请求：${path}`)
    }
    if (url.startsWith('/api/reviews/')) {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      const parsed = parseReviewPath(requestUrl.pathname)
      if (parsed === undefined) throw new Error('无效的 review 路径')
      if (method === 'GET' && parsed.action === 'diff') {
        const review = this.#reviewRecordFor(parsed.repoSlug, parsed.prNumber)
        // 允许 review 任意被跟踪的 PR（含自己创建的 PR，而不仅是“需要我 review 的 PR”）。
        if (review === undefined) throw new Error(`找不到要 Review 的 PR：${parsed.repoSlug}#${String(parsed.prNumber)}`)
        const managedRoot = await ensureManagedRoot(parsed.repoSlug, this.#installation)
        if (requestUrl.searchParams.has('file')) {
          const fileIndex = Number(requestUrl.searchParams.get('file'))
          const payload = this.#reviewDiffCache.payload(requestUrl.searchParams.get('token') ?? '', fileIndex)
          if (payload === undefined) throw new Error('该 diff 已失效，请重新打开 Review')
          this.#json(response, 200, payload)
        } else {
          const refresh = requestUrl.searchParams.get('refresh') === '1'
          const manifest: ReviewDiffManifest = await this.#reviewDiffCache.open(review, managedRoot, { refresh })
          this.#json(response, 200, manifest)
        }
        return
      }
      if (method === 'PUT' && parsed.action === 'viewed') {
        const body = await readBody(request)
        const total = body.total
        const incoming = body.viewed
        if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw new Error('viewed.total must be a non-negative integer')
        if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) throw new Error('viewed.viewed must be an object')
        const viewed: Record<string, string> = {}
        let count = 0
        for (const [path, fingerprint] of Object.entries(incoming as Record<string, unknown>)) {
          if (typeof fingerprint !== 'string') throw new Error('viewed.viewed values must be strings')
          if (typeof path !== 'string' || path.length === 0 || path.length > 2_000) throw new Error('viewed 路径无效')
          viewed[path] = fingerprint
          count += 1
          if (count > 5_000) throw new Error('viewed 文件数超过上限')
        }
        // 分页模式已读页面（页面内容指纹 → true），可选。
        let paged: Record<string, boolean> | undefined
        if (body.paged !== undefined) {
          const rawPaged = body.paged
          if (typeof rawPaged !== 'object' || rawPaged === null || Array.isArray(rawPaged)) throw new Error('viewed.paged must be an object')
          paged = {}
          let pagedCount = 0
          for (const [fingerprint, marked] of Object.entries(rawPaged as Record<string, unknown>)) {
            if (typeof fingerprint !== 'string' || fingerprint.length === 0 || fingerprint.length > 2_000) throw new Error('viewed.paged 键无效')
            if (marked !== true) throw new Error('viewed.paged 值必须为 true')
            paged[fingerprint] = true
            pagedCount += 1
            if (pagedCount > 20_000) throw new Error('viewed.paged 页数超过上限')
          }
        }
        this.#reviewViewed.set(reviewViewedKey(parsed.repoSlug, parsed.prNumber), {
          total,
          viewed,
          ...(paged === undefined ? {} : { paged }),
        })
        // Push the updated read-status summary to the lists immediately.
        this.#broadcast()
        this.#json(response, 200, { accepted: true })
        return
      }
      if (method === 'GET' && parsed.action === 'content') {
        const token = requestUrl.searchParams.get('token') ?? ''
        const path = requestUrl.searchParams.get('path') ?? ''
        if (path === '') throw new Error('缺少文件路径')
        const clonePath = this.#reviewDiffCache.clonePathFor(token, path)
        if (clonePath === undefined) throw new Error('该 diff 已失效，请重新打开 Review')
        this.#json(response, 200, await readFileAtHead(clonePath, path))
        return
      }
      throw new Error(`未知的 review 请求：${method} ${parsed.action}`)
    }
    if (method === 'POST' && url === '/api/review-action') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      const body = await readBody(request)
      const repoSlug = bodyString(body, 'repoSlug')
      const prNumberValue = body.number
      if (repoSlug === undefined || typeof prNumberValue !== 'number' || !Number.isSafeInteger(prNumberValue) || prNumberValue <= 0) {
        throw new Error('Review 请求缺少有效的 repoSlug 或 PR 编号')
      }
      const prNumber = prNumberValue
      const review = this.#reviewRecordFor(repoSlug, prNumber)
      if (review === undefined) throw new Error(`找不到待 Review PR：${repoSlug}#${String(prNumber)}`)
      const additionalInstruction = bodyString(body, 'additionalInstruction')?.trim()
      if (additionalInstruction === undefined || additionalInstruction === '') throw new Error('Review 对话指令不能为空')
      if (additionalInstruction.length > 4_000) throw new Error('Review 对话指令不能超过 4000 个字符')
      const actionKey = `${repoSlug}#${String(prNumber)}`
      const alreadyRunning = this.#store.state.jobs.some(job => (
        job.status === 'running'
        && job.type === 'review'
        && job.dshWorker?.sync.repoSlug === repoSlug
        && job.dshWorker.sync.prNumber === prNumber
      ))
      if (alreadyRunning || this.#reviewActionsInFlight.has(actionKey)) throw new Error(`${actionKey} 已有 Review 对话正在进行或准备中`)

      this.#reviewActionsInFlight.add(actionKey)
      try {
        const workerConfig = this.#workers.executionConfig(bodyString(body, 'workerConfigId'))
        this.#workerRegistry.assertAvailable(workerConfig.type)
        const managedRoot = await ensureManagedRoot(repoSlug, this.#installation)
        const pr = await pullRequest(managedRoot, repoSlug, prNumber)
        if (pr.state !== 'OPEN') throw new Error(`PR #${String(prNumber)} 当前不是 open 状态`)
        const head = await fetchPullRequestHead(managedRoot, prNumber)
        const clone = await createReviewClone({ ...review, headRefName: pr.headRefName }, managedRoot, head.ref)
        const synchronized = await synchronizeReviewWorktree(
          clone.path,
          head.ref,
          body.stashDirty === true,
          `dshw review ${repoSlug}#${String(prNumber)} ${now()}`,
        )
        if (!synchronized.ready) {
          this.#json(response, 409, {
            error: 'Review 本地分支存在未提交改动；启动前需要先 stash',
            needsStash: true,
            clonePath: clone.path,
            dirtySummary: synchronized.dirtySummary.slice(0, 4_000),
          })
          return
        }
        if (synchronized.stashed) {
          this.#store.event('warning', 'review-stash', `${repoSlug} / PR #${String(prNumber)}: 启动 Review 对话前已 stash 本地改动`)
        }
        this.#reviewDiffCache.invalidate(review)
        const sync = this.#manualSyncFromPr(clone, { ...pr, headRefOid: head.oid })
        this.#startManualAction(sync, 'review', workerConfig, additionalInstruction)
        this.#json(response, 202, { accepted: true, syncId: sync.id, clonePath: clone.path, stashed: synchronized.stashed })
      } finally {
        this.#reviewActionsInFlight.delete(actionKey)
      }
      return
    }
    if (method === 'POST' && url === '/api/restart') {
      this.#json(response, 202, { draining: true })
      setImmediate(() => void this.#drainAndExit())
      return
    }
    if (method === 'POST' && url === '/api/dshw/update') {
      if (DEV_MODE) throw new Error('开发模式下不能从页面更新 dshw')
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      if (this.#updatingDshw || this.#updatePromise !== undefined || this.#cleaningWorktrees) throw new Error('仓库维护任务正在运行，请等待完成')
      await this.#updateDshw()
      this.#json(response, 200, { updated: true, restarting: true })
      setImmediate(() => void this.#drainAndExit())
      return
    }
    if (method === 'POST' && url === '/api/update') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      if (this.#updatingDshw || this.#cleaningWorktrees) throw new Error('仓库维护任务正在运行，请等待完成')
      // 失败状态已在 #updateHarness 内记录并广播，这里只需避免 unhandled rejection
      void this.#ensureHarnessUpdated().catch(() => {})
      const job = this.#store.state.jobs.findLast(candidate => candidate.type === 'update-harness' && candidate.status === 'running')
      if (job === undefined) throw new Error('主仓库同步任务未能启动')
      this.#json(response, 202, { accepted: true, jobId: job.id })
      return
    }
    if (method === 'POST' && url === '/api/reconfigure') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      if (this.#updatingDshw || this.#cleaningWorktrees) throw new Error('仓库维护任务正在运行，请等待完成')
      if (this.#updatePromise !== undefined) throw new Error('主仓库维护任务正在运行，请等待完成')
      const promise = this.#reconfigureHarness()
      this.#updatePromise = promise
      void promise.catch(() => {}).finally(() => {
        if (this.#updatePromise === promise) this.#updatePromise = undefined
      })
      const job = this.#store.state.jobs.findLast(candidate => candidate.type === 'reconfigure-harness' && candidate.status === 'running')
      if (job === undefined) throw new Error('重新配置任务未能启动')
      this.#json(response, 202, { accepted: true, jobId: job.id })
      return
    }
    if (method === 'POST' && url === '/api/open-code') {
      // Open the generated VS Code workspace on the host (used by the kanban
      // panel's VS Code button). `code` may be absent from the daemon's PATH.
      await runOrThrow('code', [CODE_WORKSPACE_FILE])
      this.#json(response, 200, { ok: true })
      return
    }

    // Read-only review page linked from Feishu messages. Reached directly on
    // the daemon port or through the plugin's `/api/dshw` proxy; the proxy
    // reports its prefix so links and redirects stay on the browser's origin.
    if ((method === 'GET' || method === 'POST') && url.startsWith('/review/')) {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      const pathname = requestUrl.pathname
      const prefix = typeof request.headers['x-dshw-prefix'] === 'string' ? request.headers['x-dshw-prefix'] : ''
      const fixAction = /^(\/review\/([^/]+)\/(\d+))\/fix$/u.exec(pathname)
      if (method === 'POST' && fixAction !== null) {
        const repoSlug = decodeURIComponent(fixAction[2]!)
        const number = Number(fixAction[3])
        const record = this.#autoReview.record(`${repoSlug}#${String(number)}`)
        const back = `${prefix}${fixAction[1]!}`
        const redirect = (query: string): void => {
          response.writeHead(303, { location: `${back}${query}` })
          response.end()
        }
        if (record === undefined) {
          redirect('?fix=error&message=' + encodeURIComponent('找不到这条评审记录'))
          return
        }
        if (this.#draining) {
          redirect('?fix=error&message=' + encodeURIComponent('服务正在重启，请稍后重试'))
          return
        }
        try {
          await this.#startAutoReviewFix(record, { automatic: false })
          redirect('?fix=started')
        } catch (error) {
          redirect(`?fix=error&message=${encodeURIComponent(messageOf(error))}`)
        }
        return
      }
      if (method !== 'GET') throw new Error(`未知的评审页面请求：${method} ${pathname}`)
      const match = /^\/review\/([^/]+)\/(\d+)$/u.exec(pathname)
      if (match === null) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        response.end(renderReviewPageMissing('评审链接格式不正确。'))
        return
      }
      const repoSlug = decodeURIComponent(match[1]!)
      const number = Number(match[2])
      const record = this.#autoReview.record(`${repoSlug}#${String(number)}`)
      if (record === undefined) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        response.end(renderReviewPageMissing(`没有找到 ${repoSlug} #${String(number)} 的评审记录。`))
        return
      }
      let diff: ReviewPageDiff | undefined
      const pr = this.#prDashboard.find(candidate => candidate.repoSlug === repoSlug && candidate.number === number)
      try {
        if (pr !== undefined) {
          const captured = await this.#autoReviewDiff.capture(record, pr.clonePath)
          diff = {
            fromOid: captured.manifest.fromOid,
            toOid: captured.manifest.toOid,
            additions: captured.manifest.additions,
            deletions: captured.manifest.deletions,
            files: captured.manifest.files,
            payloads: captured.payloads,
          }
        }
      } catch { /* the page still renders the findings without the diff */ }
      const fix = requestUrl.searchParams.get('fix')
      const flash = fix === null ? undefined
        : fix === 'started' ? { ok: true, message: '已启动修复会话；进展会更新在飞书卡片上，完成后这个页面也会同步。' }
          : { ok: false, message: requestUrl.searchParams.get('message') ?? '启动修复会话失败' }
      // The fix diff is read live so the page tracks the latest turn.
      let fixDiff = record.fix?.diff
      if (record.fix !== undefined) {
        const pr = this.#prDashboard.find(candidate => candidate.repoSlug === record.repoSlug && candidate.number === record.number)
        if (pr !== undefined) {
          const clone = await findClone(pr.cloneName).catch(() => undefined)
          if (clone !== undefined) fixDiff = await captureFixDiff(clone.path) ?? fixDiff
        }
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(renderReviewPage(record, diff, {
        actionPath: `${prefix}${pathname}`,
        ...(flash === undefined ? {} : { flash }),
        ...(fixDiff === undefined ? {} : { fixDiff }),
      }))
      return
    }
    if (method === 'GET' && !url.startsWith('/api/')) {
      // The standalone browser UI was removed: the kanban now lives in the
      // DeepSeek Harness plugin. Keep a plain notice at the root.
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('dshw 后台服务运行中。看板已迁移到 DeepSeek Harness 插件，请通过 Harness Web 的左侧栏入口使用。\n')
      return
    }
    this.#json(response, 404, { error: 'not found' })
  }

  /** Resolve a review identity for a PR: prefer an explicit review request, then
   *  fall back to any tracked dashboard PR (so own PRs are reviewable too). */
  #reviewRecordFor(repoSlug: string, prNumber: number): ReviewRequestRecord | undefined {
    const requested = this.#reviewRequests.find(candidate => candidate.repoSlug === repoSlug && candidate.number === prNumber)
    if (requested !== undefined) return requested
    const pr = this.#prDashboard.find(candidate => candidate.repoSlug === repoSlug && candidate.number === prNumber)
    if (pr === undefined) return undefined
    return {
      repoSlug: pr.repoSlug,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      author: pr.author ?? '',
      headRefName: pr.branch,
      baseRefName: pr.baseRefName,
      updatedAt: pr.updatedAt,
    }
  }

  async #snapshot(): Promise<object> {
    const { prDashboardCache: _prDashboardCache, reviewRequestsCache: _reviewRequestsCache, repos: _repos, jobs, ...state } = this.#store.state
    const recentJobs = jobs.filter((job, index) => job.status === 'running' || index >= jobs.length - HISTORY_PAGE_SIZE)
    const clones = await listClones()
    const worktreeCleanupCount = this.#prDashboardStatus.state === 'ready' && !this.#prDashboardStatus.stale
      ? this.#worktreeCleanupState(clones).inactive.length
      : undefined
    return {
      service: {
        startedAt: this.#store.state.serviceStartedAt,
        installationId: this.#installation.id,
        draining: this.#draining,
        activeJobs: countVisibleRunningJobs(jobs),
        updatingDshw: this.#updatingDshw,
        port: PORT,
        devMode: DEV_MODE,
        rateLimited: this.#rateLimited,
        ...(this.#rateLimitResetAt === undefined ? {} : { rateLimitResetAt: this.#rateLimitResetAt }),
      },
      repos: this.#monitoredRepos,
      clones,
      ...(worktreeCleanupCount === undefined ? {} : { worktreeCleanupCount }),
      prs: mergePrDashboardSyncState(this.#prDashboard, this.#store.state.syncs),
      prDashboard: this.#prDashboardStatus,
      reviewRequests: this.#reviewRequests.map(record => {
        const viewed = this.#reviewViewed.summary(reviewViewedKey(record.repoSlug, record.number))
        return viewed === undefined ? record : { ...record, viewed }
      }),
      reviewRequestsStatus: this.#reviewRequestsStatus,
      autoReview: {
        config: this.#autoReview.config(),
        records: this.#autoReviewSummaries(),
        running: [...this.#autoReviewRunning],
      },
      feishu: {
        config: this.#feishu.publicConfig(),
        threads: this.#feishu.threads().map(thread => ({
          key: thread.key,
          title: thread.title,
          threadId: thread.threadId,
          updatedAt: thread.updatedAt,
        })),
      },
      jobProgress: this.#readJobProgress(),
      workers: this.#workers.list(),
      workerTypes: this.#workerRegistry.availability(),
      harnessRepository: this.#harnessRepository,
      dshwRepository: this.#dshwRepository,
      ...state,
      jobs: recentJobs,
    }
  }


  /* ── PR Auto Reviewer ─────────────────────────────────────────────────── */

  /** Seed the demo PR + review record (development only; see dev-demo.ts). */
  async #loadDemoScenario(): Promise<void> {
    for (const { pr, record } of await seedDemoScenarios()) {
      if (!this.#prDashboard.some(candidate => candidate.repoSlug === pr.repoSlug && candidate.number === pr.number)) {
        this.#prDashboard = [...this.#prDashboard, pr]
        this.#prDashboardStatus = {
          state: 'ready',
          refreshing: false,
          stale: false,
          lastAttemptAt: now(),
          lastSuccessAt: now(),
        }
      }
      if (this.#autoReview.record(record.id) === undefined) await this.#autoReview.saveRecord(record)
    }
    this.#store.event('info', 'auto-review', '已加载 PR Auto Reviewer 演示数据（DSHW_DEMO=1）')
    await this.#store.changed()
  }


  /** Records for the list view: comments are fetched per record on demand. */
  #autoReviewSummaries(): AutoReviewSummary[] {
    const jobs = this.#store.state.jobs
    return this.#autoReview.records().map(record => {
      const live = withLiveFixStatus(record, jobs)
      const { comments, ...rest } = live
      return { ...rest, commentCount: comments.length }
    })
  }


  /** Render one of the auto-review turn prompts for this PR. */
  async #autoReviewTurnPrompt(file: string, sync: SyncRecord): Promise<string> {
    const template = await readFile(join(DSHW_ROOT, 'prompts', file), 'utf8')
    return renderPromptTemplate(template, {
      clonePath: sync.clonePath,
      prNumber: String(sync.prNumber),
      branch: sync.branch,
      baseRefName: sync.baseRefName,
    })
  }

  /** Render one summary row's debounce deadline for the event log. */
  #autoReviewSchedule(record: AutoReviewRecord): string {
    if (record.dueAt === undefined) return ''
    const seconds = Math.max(1, Math.round((Date.parse(record.dueAt) - Date.now()) / 1_000))
    return `${String(Math.floor(seconds / 60))} 分 ${String(seconds % 60)} 秒`
  }

  /** Fold a fresh dashboard snapshot into the debounce scheduler. */
  async #observeAutoReviews(): Promise<void> {
    const config = this.#autoReview.config()
    if (!config.enabled) return
    const records = new Map(this.#autoReview.records().map(record => [record.id, record]))
    const changed = observePrCommits(records, this.#prDashboard, config, Date.now())
    if (changed.length === 0) return
    for (const record of changed) await this.#autoReview.saveRecord(record)
    for (const record of changed) {
      if (record.status !== 'pending') continue
      this.#store.event(
        'info',
        'auto-review',
        `${record.repoSlug} / PR #${record.number}: 检测到新提交 ${record.observedHeadOid.slice(0, 7)}，${this.#autoReviewSchedule(record)}后自动评审`,
      )
    }
    await this.#store.changed()
  }

  /** Queue a manual review (used by the Feishu `/review` command). */
  async #enqueueAutoReview(key: string): Promise<void> {
    const record = this.#autoReview.record(key)
    if (record === undefined) throw new Error('找不到这条自动评审记录')
    if (this.#autoReviewRunning.has(key)) throw new Error('这个 PR 正在评审')
    record.status = 'pending'
    record.trigger = 'manual'
    record.dueAt = now()
    record.skippedReason = undefined
    record.updatedAt = now()
    await this.#autoReview.saveRecord(record)
    await this.#store.changed()
    if (!this.#draining) this.#startDueAutoReviews()
  }

  /** Send one instruction to the PR's running fix session (Feishu free text). */
  async #steerAutoReviewFix(key: string, instruction: string): Promise<boolean> {
    const record = this.#autoReview.record(key)
    if (record?.fix === undefined) return false
    const job = this.#store.state.jobs.find(candidate => candidate.id === record.fix!.jobId && candidate.status === 'running')
    if (job === undefined || job.dshWorker === undefined) return false
    await this.#steerDshJob(job.id, instruction)
    return true
  }

  /** Kick off every review whose debounce deadline has passed. */
  #startDueAutoReviews(): void {
    // A manual run is honoured even while automatic watching is off; queued
    // automatic runs stop when the switch is turned off.
    const enabled = this.#autoReview.config().enabled
    for (const record of dueReviews(this.#autoReview.records(), Date.now())) {
      if (!enabled && record.trigger === 'auto') continue
      if (this.#autoReviewRunning.has(record.id)) continue
      void this.#startAutoReview(record).catch(() => { /* recorded on the record and in the log */ })
    }
  }

  /** Run the review agent for one record and persist its findings. */
  async #startAutoReview(record: AutoReviewRecord): Promise<void> {
    if (this.#autoReviewRunning.has(record.id)) throw new Error(`${record.id} 的自动评审正在进行`)
    const config = this.#autoReview.config()
    const pr = this.#prDashboard.find(candidate => candidate.repoSlug === record.repoSlug && candidate.number === record.number)
    const headOid = record.observedHeadOid
    if (pr === undefined) {
      record.status = 'idle'
      record.dueAt = undefined
      record.pendingSince = undefined
      record.skippedReason = 'PR 不在当前看板中（可能已关闭）'
      record.updatedAt = now()
      await this.#autoReview.saveRecord(record)
      await this.#store.changed()
      return
    }
    if (record.trigger === 'auto' && record.reviewedHeadOid === headOid) {
      record.status = record.reviewedHeadOid === undefined ? 'idle' : 'reviewed'
      record.dueAt = undefined
      record.pendingSince = undefined
      record.updatedAt = now()
      await this.#autoReview.saveRecord(record)
      await this.#store.changed()
      return
    }
    const apiKey = this.#autoReview.apiKey()
    if (apiKey === undefined) {
      record.status = 'failed'
      record.error = `缺少评审模型 API Key（${config.apiKeyMode === 'value' ? '已保存的 Key 为空' : `环境变量 ${config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}`}）`
      record.dueAt = undefined
      record.pendingSince = undefined
      record.finishedAt = now()
      record.updatedAt = record.finishedAt
      await this.#autoReview.saveRecord(record)
      this.#store.event('error', 'auto-review', `${record.repoSlug} / PR #${record.number}: ${record.error}`)
      await this.#store.changed()
      return
    }

    this.#autoReviewRunning.add(record.id)
    const controller = new AbortController()
    this.#autoReviewControllers.set(record.id, controller)
    record.status = 'running'
    record.startedAt = now()
    record.finishedAt = undefined
    record.error = undefined
    record.summary = ''
    record.comments = []
    record.counts = { critical: 0, warning: 0, suggestion: 0 }
    record.headOid = headOid
    record.baseOid = pr.baseOid ?? record.baseOid
    record.dueAt = undefined
    record.pendingSince = undefined
    record.skippedReason = undefined
    record.updatedAt = record.startedAt
    await this.#autoReview.saveRecord(record)
    this.#store.event('info', 'auto-review', `${record.repoSlug} / PR #${record.number}: 开始评审 ${headOid.slice(0, 7)}`)
    await this.#store.changed()

    try {
      await this.#ensureAutoReviewCommits(pr, record.baseOid, headOid)
      const description = await this.#autoReviewPrBody(pr)
      const runDir = join(AUTO_REVIEW_ROOT, 'runs', `${record.id.replace(/[^a-zA-Z0-9._-]+/gu, '-')}-${String(Date.now())}`)
      const models = config.models.length > 0 ? config.models : [config.model]
      const result = await runReviews({
        repoSlug: record.repoSlug,
        prNumber: record.number,
        title: record.title,
        description,
        instructions: config.instructions,
        clonePath: pr.clonePath,
        baseOid: record.baseOid,
        headOid,
        runDir,
        models,
        ...(config.modelProfile === undefined ? {} : { modelProfile: config.modelProfile }),
        baseUrl: config.baseUrl,
        apiKey,
        engineVersion: config.engineVersion,
        pricingFor: model => estimatePricing(model),
        timeoutSeconds: config.timeoutSeconds,
        signal: controller.signal,
      })
      record.status = result.status === 'completed' ? 'reviewed' : 'failed'
      record.finishedAt = now()
      record.summary = result.summary
      record.comments = result.comments
      record.counts = countSeverities(result.comments)
      record.models = result.models
      record.model = result.models.join(' + ')
      record.engine = result.engineVersion
      record.usage = result.usage === undefined ? undefined : { ...result.usage }
      record.error = result.error ?? undefined
      if (result.status === 'completed') record.reviewedHeadOid = headOid
      record.updatedAt = record.finishedAt
      await this.#autoReview.saveRecord(record)
      const counts = record.counts
      this.#store.event(
        result.status === 'completed' ? 'info' : 'error',
        'auto-review',
        result.status === 'completed'
          ? `${record.repoSlug} / PR #${record.number}: 评审完成（${result.models.join(' + ')}；${String(counts.critical)} critical / ${String(counts.warning)} warning / ${String(counts.suggestion)} suggestion）`
          : `${record.repoSlug} / PR #${record.number}: 评审失败：${result.error ?? '未知错误'}`,
      )
    } catch (error) {
      record.status = 'failed'
      record.error = messageOf(error)
      record.finishedAt = now()
      record.updatedAt = record.finishedAt
      await this.#autoReview.saveRecord(record)
      this.#store.event('error', 'auto-review', `${record.repoSlug} / PR #${record.number}: 评审失败：${record.error}`)
    } finally {
      this.#autoReviewRunning.delete(record.id)
      this.#autoReviewControllers.delete(record.id)
      await this.#store.changed()
    }

    void this.#feishu.notifyReview(record).catch(() => { /* recorded as an event by the bot */ })
    const latest = this.#autoReview.record(record.id) ?? record
    if (!shouldAutoFix(latest, this.#autoReview.config())) return
    try {
      await this.#startAutoReviewFix(latest, { automatic: true })
    } catch (error) {
      this.#store.event('warning', 'auto-review', `${record.repoSlug} / PR #${record.number}: 未能启动自动修复：${messageOf(error)}`)
      await this.#store.changed()
    }
  }


  /**
   * Push an auto-review fix that is waiting in the working tree.
   *
   * Runs one more dsh turn with the push prompt (commit + push + no force), then
   * marks the record as pushed. Triggered by the card button or a Feishu message.
   */
  async #pushAutoReviewFix(record: AutoReviewRecord): Promise<void> {
    const pr = this.#prDashboard.find(candidate => candidate.repoSlug === record.repoSlug && candidate.number === record.number)
    if (pr === undefined) throw new Error('PR 不在当前看板中，无法推送')
    if (record.fix === undefined) throw new Error('这条记录还没有修复会话')
    if (record.fix.status === 'running') throw new Error('修复会话还在运行，等它完成再推送')
    const clone = await findClone(pr.cloneName)
    const prInfo = await pullRequest(clone.path, clone.repoSlug, pr.number)
    if (prInfo.state !== 'OPEN') throw new Error(`PR #${String(pr.number)} 当前不是 open 状态`)
    const existing = this.#store.state.syncs.find(candidate => candidate.repoSlug === clone.repoSlug && candidate.prNumber === pr.number)
    const sync = existing ?? this.#manualSyncFromPr(clone, prInfo)
    const workerConfig = this.#workers.executionConfig(this.#autoReview.config().workerConfigId)
    this.#workerRegistry.assertAvailable(workerConfig.type)
    const job = this.#beginJob('auto-review-fix', `${sync.cloneName} / PR #${sync.prNumber}: 推送修复`, sync.id)
    record.fix = { ...record.fix, jobId: job.id, status: 'running' }
    record.updatedAt = now()
    await this.#autoReview.saveRecord(record)
    this.#store.event('info', 'auto-review', `${record.repoSlug} / PR #${record.number}: 开始推送修复`)
    await this.#store.changed()
    const prompt = await this.#autoReviewTurnPrompt('auto-review-fix-push.md', sync)
    void this.#withSyncLock(sync, async () => {
      try {
        await this.#runAgent(sync, 'auto-review-fix', workerConfig, prompt, job, { turns: [], push: true })
      } catch (error) {
        const latest = this.#autoReview.record(record.id) ?? record
        latest.fix = { ...latest.fix!, status: 'ready' }
        latest.error = messageOf(error)
        latest.updatedAt = now()
        await this.#autoReview.saveRecord(latest)
        this.#store.event('warning', 'auto-review', `${record.repoSlug} / PR #${record.number}: 推送失败：${messageOf(error)}`)
      } finally {
        void this.#refreshPrDashboardAfterAction()
      }
    })
  }

  /** Make sure the reviewed base/head commits exist in the PR clone before cloning it. */
  async #ensureAutoReviewCommits(pr: PrDashboardRecord, baseOid: string, headOid: string): Promise<void> {
    const has = async (oid: string): Promise<boolean> => (
      oid !== '' && (await run('git', ['cat-file', '-e', `${oid}^{commit}`], { cwd: pr.clonePath })).code === 0
    )
    if (await has(headOid) && await has(baseOid)) return
    await runOrThrow('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`], {
      cwd: pr.clonePath,
      timeoutMs: 5 * 60 * 1000,
    })
    if (!await has(headOid) || !await has(baseOid)) throw new Error('PR 的基准或最新提交不在本地仓库中，无法评审')
  }

  /** Pull request description for the review prompt (best effort). */
  async #autoReviewPrBody(pr: PrDashboardRecord): Promise<string> {
    const result = await run('gh', ['pr', 'view', String(pr.number), '--repo', pr.repoSlug, '--json', 'body', '--jq', '.body'], {
      timeoutMs: 30_000,
    })
    return result.code === 0 ? result.stdout.trim().slice(0, 20_000) : ''
  }

  /** GitHub connectivity as the settings panel shows it. */
  async #autoReviewGithubStatus(): Promise<{ authenticated: boolean, account?: string, repositories: string[], error?: string }> {
    const repositories = this.#monitoredRepos.filter(repo => repo.enabled).map(repo => repo.repoSlug)
    const result = await run('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: 30_000 })
    if (result.code !== 0) {
      return {
        authenticated: false,
        repositories,
        error: result.stderr.trim().slice(-600) === '' ? 'gh 命令失败' : result.stderr.trim().slice(-600),
      }
    }
    return { authenticated: true, account: result.stdout.trim(), repositories }
  }


  /**
   * Models the configured review endpoint serves.
   *
   * The gateway is OpenAI-compatible for every family, so its `/models` list is
   * the authoritative picker source; a failed lookup falls back to the models
   * the panel already knows plus the currently configured one.
   */
  async #autoReviewModels(): Promise<{ models: string[], recommended: string[], error?: string }> {
    const config = this.#autoReview.config()
    const apiKey = this.#autoReview.apiKey()
    const fallback = [...new Set([config.model, ...RECOMMENDED_REVIEW_MODELS])]
    if (apiKey === undefined) return { models: fallback, recommended: [...RECOMMENDED_REVIEW_MODELS], error: '还没有配置评审模型 API Key' }
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/+$/u, '')}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) return { models: fallback, recommended: [...RECOMMENDED_REVIEW_MODELS], error: `模型列表请求失败：HTTP ${String(response.status)}` }
      const body = await response.json() as { data?: Array<{ id?: unknown }> }
      const models = (body.data ?? [])
        .map(entry => entry.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
        .sort((left, right) => left.localeCompare(right))
      return models.length === 0
        ? { models: fallback, recommended: [...RECOMMENDED_REVIEW_MODELS], error: '模型列表为空' }
        : { models, recommended: [...RECOMMENDED_REVIEW_MODELS] }
    } catch (error) {
      return { models: fallback, recommended: [...RECOMMENDED_REVIEW_MODELS], error: `无法读取模型列表：${messageOf(error)}` }
    }
  }


  /** Push running fix-session progress into the Feishu card (the bot throttles patches). */
  async #syncFeishuFixProgress(): Promise<void> {
    for (const record of this.#autoReview.records()) {
      const fix = record.fix
      if (fix === undefined || fix.status !== 'running') continue
      const job = this.#store.state.jobs.find(candidate => candidate.id === fix.jobId && candidate.status === 'running')
      const runId = job?.dshWorker?.handle.runId
      if (runId === undefined) continue
      const progress = this.#workerProgress.get(runId)
      if (progress === undefined) continue
      await this.#feishu.syncFixProgress(record, { status: 'running', phase: progress.phase, message: progress.message })
    }
  }



  /**
   * Route one natural-language Feishu message.
   *
   * Uses the cheapest configured reviewer (`deepseek-flash`) as a router so the
   * topic behaves like a chat: questions get answered, "重新评审" re-runs the
   * review, "修一下" starts or steers the fix session. Any failure falls back to
   * the pre-router behaviour (treat the text as a fix instruction).
   */
  async #interpretFeishuMessage(key: string, message: string): Promise<FeishuRoute> {
    const record = this.#autoReview.record(key)
    if (record === undefined) return { action: 'answer', reply: '这个 PR 已经不在自动评审记录里了。' }
    const config = this.#autoReview.config()
    const apiKey = this.#autoReview.apiKey()
    if (apiKey === undefined) return parseRoute('', message)
    const liveFix = this.#store.state.jobs.some(job => job.id === record.fix?.jobId && job.status === 'running')
    const prompt = routePrompt(record, message, liveFix)
    try {
      const response = await fetch(`${config.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: INTERPRET_MODEL,
          messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
          temperature: 0,
          max_tokens: 500,
        }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!response.ok) return parseRoute('', message)
      const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = body.choices?.[0]?.message?.content
      return parseRoute(typeof content === 'string' ? content : '', message)
    } catch {
      return parseRoute('', message)
    }
  }

  /** Why the review card shows no fix session (auto-fix off, below threshold, …). */
  #autoReviewFixHint(record: AutoReviewRecord): string {
    const config = this.#autoReview.config()
    if (!config.enabled) return '自动评审已关闭'
    if (!config.autoFix) return '自动修复未开启'
    if (record.status !== 'reviewed') return '评审未完成'
    const counts = record.counts
    const blocking = config.fixSeverity === 'critical' ? counts.critical : counts.critical + counts.warning
    if (blocking === 0) return '未达到自动修复级别'
    if ((record.fixRounds ?? 0) >= MAX_AUTO_FIX_ROUNDS) return `已达 ${String(MAX_AUTO_FIX_ROUNDS)} 次上限`
    return '自动修复未启动'
  }

  /** Start a dsh session that works through the record's findings. */
  async #startAutoReviewFix(record: AutoReviewRecord, options: { automatic: boolean, instruction?: string }): Promise<void> {
    const config = this.#autoReview.config()
    // The record may hold the status from before a daemon restart; the live job
    // list is authoritative for "is a fix session running right now".
    const liveFixStatus = record.fix === undefined
      ? undefined
      : this.#store.state.jobs.find(job => job.id === record.fix!.jobId)?.status ?? record.fix.status
    if (liveFixStatus === 'running') throw new Error('这条记录的修复会话已经在运行')
    if (options.automatic && (record.fixRounds ?? 0) >= MAX_AUTO_FIX_ROUNDS) throw new Error(`已达到 ${String(MAX_AUTO_FIX_ROUNDS)} 次自动修复上限`)
    const pr = this.#prDashboard.find(candidate => candidate.repoSlug === record.repoSlug && candidate.number === record.number)
    if (pr === undefined) throw new Error('PR 不在当前看板中，无法启动修复会话')
    const clone = await findClone(pr.cloneName)
    const prInfo = await pullRequest(clone.path, clone.repoSlug, pr.number)
    if (prInfo.state !== 'OPEN') throw new Error(`PR #${String(pr.number)} 当前不是 open 状态`)
    const existing = this.#store.state.syncs.find(candidate => candidate.repoSlug === clone.repoSlug && candidate.prNumber === pr.number)
    const sync = existing ?? this.#manualSyncFromPr(clone, prInfo)
    const workerConfig = this.#workers.executionConfig(config.workerConfigId)
    this.#workerRegistry.assertAvailable(workerConfig.type)
    const findings = formatFindings(record)
    if (findings === '') throw new Error('这条记录没有可修复的评审意见')
    const label = options.automatic ? '自动评审修复' : '手动发起评审修复'
    this.#prepareManualAction(sync, label)
    const job = this.#beginJob('auto-review-fix', `${sync.cloneName} / PR #${sync.prNumber}: ${label}`, sync.id)
    record.fix = {
      jobId: job.id,
      status: 'running',
      startedAt: now(),
      headOid: record.reviewedHeadOid ?? record.headOid,
    }
    record.fixRounds = (record.fixRounds ?? 0) + 1
    record.updatedAt = now()
    await this.#autoReview.saveRecord(record)
    this.#store.event('info', 'auto-review', `${record.repoSlug} / PR #${record.number}: ${label}已启动（${workerConfig.name}）`)
    await this.#store.changed()
    void this.#feishu.notifyFixStarted(record).catch(() => { /* recorded as an event by the bot */ })
    const prompt = options.instruction === undefined || options.instruction.trim() === ''
      ? findings
      : `${findings}\n\n## 用户补充指令\n\n${options.instruction.trim()}`
    void this.#withSyncLock(sync, async () => {
      try {
        const turns = [
          await this.#autoReviewTurnPrompt('auto-review-scope-audit.md', sync),
          await this.#autoReviewTurnPrompt('auto-review-fix-summary.md', sync),
        ]
        await this.#runAgent(sync, 'auto-review-fix', workerConfig, prompt, job, { turns })
      } finally {
        const latest = await pullRequest(clone.path, clone.repoSlug, pr.number).catch(() => undefined)
        const fix = record.fix
        if (fix !== undefined && job.dshWorker?.kind !== 'auto-review-fix') {
          record.fix = {
            ...fix,
            status: job.status,
            ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
            ...(latest === undefined ? {} : { producedHeadOid: latest.headRefOid }),
            ...(job.output === undefined || job.status !== 'blocked' ? {} : { blockedReason: job.output.slice(-600) }),
          }
          record.updatedAt = now()
          await this.#autoReview.saveRecord(record)
          void this.#feishu.notifyFix(record, job.status).catch(() => { /* recorded as an event by the bot */ })
        }
        void this.#refreshPrDashboardAfterAction()
      }
    })
  }

  async #jobOutput(jobId: string | undefined, before?: number): Promise<OutputPage> {
    if (jobId === undefined) throw new Error('缺少 jobId')
    const job = this.#store.state.jobs.find(candidate => candidate.id === jobId)
    if (job === undefined) throw new Error(`找不到任务：${jobId}`)
    const runId = job.dshWorker?.handle.runId
    if (runId === undefined) return { output: job.output ?? '', hasMore: false }
    if (!/^[a-z]+-[a-z0-9-]+$/u.test(runId)) throw new Error('任务包含无效的 runId')
    try {
      const page = await readOutputPage(join(LOG_ROOT, `${runId}.log`), before)
      return page.output === '' && !page.hasMore
        ? { output: job.output ?? '', hasMore: false }
        : page
    } catch {
      return { output: job.output ?? '', hasMore: false }
    }
  }

  async #scanWorktreeCleanup(): Promise<WorktreeCleanupPreview> {
    await this.#discoverMyPrs()
    await this.#refreshPrDashboard()
    if (this.#prDashboardStatus.state !== 'ready' || this.#prDashboardStatus.stale) {
      throw new Error(`无法确认 active PR，已取消清理：${this.#prDashboardStatus.error ?? 'PR 状态不是最新'}`)
    }
    const clones = await listClones()
    const { activeNames, busyPaths, inactive } = this.#worktreeCleanupState(clones)
    const candidates = await Promise.all(inactive.map(async clone => {
      try {
        const status = await cloneGitStatus(clone.path, '@{upstream}')
        return {
          name: clone.name,
          branch: clone.branch,
          ...status,
          needsDecision: worktreeNeedsCleanupDecision(status),
        } satisfies WorktreeCleanupCandidate
      } catch (error) {
        return {
          name: clone.name,
          branch: clone.branch,
          staged: false,
          unstaged: false,
          merging: false,
          ahead: 0,
          behind: 0,
          needsDecision: true,
          inspectionError: messageOf(error),
        } satisfies WorktreeCleanupCandidate
      }
    }))
    return {
      total: clones.length,
      active: clones.filter(clone => activeNames.has(clone.name)).length,
      busy: clones.filter(clone => busyPaths.has(clone.path) && !activeNames.has(clone.name)).length,
      candidates: candidates.sort((left, right) => Number(left.needsDecision) - Number(right.needsDecision) || left.name.localeCompare(right.name)),
    }
  }

  #worktreeCleanupState(clones: CloneRecord[]): {
    activeNames: Set<string>
    busyPaths: Set<string>
    inactive: CloneRecord[]
  } {
    const activeNames = new Set(this.#prDashboard.map(record => record.cloneName))
    const busyPaths = new Set(this.#store.state.syncs
      .filter(sync => this.#syncLocks.has(sync.id))
      .map(sync => sync.clonePath))
    for (const job of this.#store.state.jobs) {
      if (job.status === 'running' && job.dshWorker !== undefined) busyPaths.add(job.dshWorker.sync.clonePath)
    }
    return {
      activeNames,
      busyPaths,
      inactive: clones.filter(clone => !activeNames.has(clone.name) && !busyPaths.has(clone.path)),
    }
  }

  async #cleanupWorktrees(deleteDirty: string[]): Promise<{
    deleted: string[]
    kept: string[]
    failed: Array<{ name: string, error: string }>
  }> {
    const preview = await this.#scanWorktreeCleanup()
    const forceDelete = new Set(deleteDirty)
    const deletable = preview.candidates.filter(candidate => !candidate.needsDecision || forceDelete.has(candidate.name))
    const deleted: string[] = []
    const removedPaths = new Set<string>()
    const failed: Array<{ name: string, error: string }> = []
    for (const candidate of deletable) {
      try {
        const clone = await removeClone(candidate.name)
        deleted.push(candidate.name)
        removedPaths.add(clone.path)
      } catch (error) {
        failed.push({ name: candidate.name, error: messageOf(error) })
      }
    }
    const kept = preview.candidates
      .filter(candidate => candidate.needsDecision && !forceDelete.has(candidate.name))
      .map(candidate => candidate.name)
    if (removedPaths.size > 0) {
      this.#store.state.syncs = this.#store.state.syncs.filter(sync => !removedPaths.has(sync.clonePath))
      this.#lastWorkspaceRefreshAt = 0
      this.#store.event('info', 'worktree-cleanup', `已清理 ${deleted.length} 个非 active PR worktree${kept.length > 0 ? `，保留 ${kept.length} 个含本地内容的 worktree` : ''}`)
      await this.#store.changed()
      await this.#refreshWorkspace()
    }
    for (const failure of failed) this.#store.event('error', 'worktree-cleanup', `${failure.name} 删除失败：${failure.error}`)
    if (failed.length > 0) await this.#store.changed()
    return { deleted, kept, failed }
  }

  async #setSyncEnabled(clone: CloneRecord, enabled: boolean): Promise<SyncRecord> {
    const sync = this.#store.state.syncs.find(candidate => candidate.clonePath === clone.path)
    if (sync === undefined) throw new Error(`${clone.name} 尚未被追踪；等待下一轮 PR 自动发现`)
    if ((sync.enabled !== false) === enabled) return sync
    sync.enabled = enabled
    sync.updatedAt = now()
    const record = this.#prDashboard.find(candidate => candidate.repoSlug === sync.repoSlug && candidate.number === sync.prNumber)
    if (record !== undefined) record.syncEnabled = enabled
    if (enabled) {
      sync.immediateCheckRequestedAt = now()
      this.#store.event('info', 'sync', `PR #${sync.prNumber} 已开启自动 sync，追加一次即时检查`)
    } else {
      sync.immediateCheckRequestedAt = undefined
      clearPendingBaseCheck(sync)
      sync.nextCiCheckAt = undefined
      this.#recomputeNextUpdate()
      this.#store.event('info', 'sync', `PR #${sync.prNumber} 已关闭自动 sync；仍会继续追踪 PR 状态`)
    }
    await this.#store.changed()
    return sync
  }

  /** 自动发现在所有被监控仓库上我创建或 assign 给我的 open PR：克隆并纳入追踪（sync 默认关闭），并清理已关闭 PR 的 sync。 */
  async #discoverMyPrs(): Promise<void> {
    if (this.#discoveryPromise !== undefined) return await this.#discoveryPromise
    this.#lastDiscoveryAt = Date.now()
    this.#discoveryPromise = (async () => {
      try {
        const reviewRefresh = this.#refreshReviewRequests()
        const clones = await listClones()
        let tracked = 0
        let cloned = 0
        let staleTotal = 0
        let firstError = ''
        for (const repo of this.#monitoredRepos) {
          if (!repo.enabled) continue
          const repoSlug = repo.repoSlug
          try {
            const root = await ensureManagedRoot(repoSlug, this.#installation)
            const prs = await trackedOpenPullRequests(root, repoSlug)
            for (const pr of prs) {
              const existing = this.#store.state.syncs.find(
                sync => sync.repoSlug === repoSlug && sync.prNumber === pr.number,
              )
              if (existing !== undefined) continue
              let clone = clones.find(candidate => candidate.repoSlug === repoSlug && candidate.branch === pr.headRefName)
              if (clone === undefined) {
                clone = await createPrClone(pr, repoSlug)
                clones.push(clone)
                cloned += 1
              }
              const sync: SyncRecord = {
                id: id('sync'),
                cloneName: clone.name,
                clonePath: clone.path,
                remoteUrl: `https://github.com/${repoSlug}.git`,
                repoSlug,
                prNumber: pr.number,
                prUrl: pr.url,
                branch: pr.headRefName,
                baseRefName: pr.baseRefName,
                baseOid: pr.baseRefOid,
                headOid: pr.headRefOid,
                status: pr.isDraft ? 'draft' : 'active',
                enabled: false,
                pausedReason: pr.isDraft ? 'PR 是 draft，冲突同步和 CI 修复均已暂停' : undefined,
                createdAt: now(),
                updatedAt: now(),
                nextPrRefreshAt: now(),
              }
              this.#store.state.syncs.push(sync)
              this.#store.event('info', 'track', `发现 PR #${pr.number}「${pr.title}」（${repoSlug}），已克隆并纳入追踪（sync 默认关闭，可在 UI 打开）`)
              tracked += 1
            }
            const openNumbers = new Set(prs.map(pr => pr.number))
            const stale = this.#store.state.syncs.filter(sync => (
              sync.repoSlug === repoSlug && !openNumbers.has(sync.prNumber) && !this.#syncLocks.has(sync.id)
            ))
            if (stale.length > 0) {
              const staleIds = new Set(stale.map(sync => sync.id))
              this.#store.state.syncs = this.#store.state.syncs.filter(sync => !staleIds.has(sync.id))
              for (const sync of stale) {
                this.#store.event('info', 'sync', `PR #${sync.prNumber}（${repoSlug}）已不再 open，停止追踪`)
              }
              staleTotal += stale.length
            }
          } catch (error) {
            this.#noteGhFailure(error)
            firstError = messageOf(error)
            this.#store.event('warning', 'track', `${repoSlug} 自动发现 PR 失败：${messageOf(error)}`)
          }
        }
        await reviewRefresh
        if (tracked > 0 || staleTotal > 0 || firstError !== '') await this.#store.changed()
        if (cloned > 0) {
          this.#lastWorkspaceRefreshAt = 0
          void this.#refreshWorkspace()
        }
        if (firstError !== '' && this.#reviewRequestsStatus.state === 'loading') {
          this.#reviewRequestsStatus = {
            state: 'error',
            refreshing: false,
            stale: this.#reviewRequests.length > 0,
            error: firstError,
          }
        }
      } catch (error) {
        this.#noteGhFailure(error)
        if (this.#reviewRequestsStatus.state === 'loading') {
          this.#reviewRequestsStatus = {
            state: 'error',
            refreshing: false,
            stale: this.#reviewRequests.length > 0,
            error: messageOf(error),
          }
        }
        this.#store.event('warning', 'track', `自动发现 PR 失败：${messageOf(error)}`)
        await this.#store.changed()
      }
    })()
    try {
      await this.#discoveryPromise
    } finally {
      this.#discoveryPromise = undefined
    }
  }

  async #refreshReviewRequests(): Promise<void> {
    const attemptAt = now()
    this.#reviewRequestsStatus = {
      ...this.#reviewRequestsStatus,
      refreshing: true,
      lastAttemptAt: attemptAt,
    }
    this.#broadcast()
    try {
      const enabled = this.#monitoredRepos.filter(repo => repo.enabled)
      const collected: ReviewRequestRecord[] = []
      const failures: string[] = []
      for (const repo of enabled) {
        try {
          const root = await ensureManagedRoot(repo.repoSlug, this.#installation)
          const records = await reviewRequestedPullRequests(root, repo.repoSlug)
          collected.push(...records)
        } catch (error) {
          this.#noteGhFailure(error)
          failures.push(`${repo.repoSlug}: ${messageOf(error)}`)
        }
      }
      const completedAt = now()
      this.#reviewRequests = collected
      this.#reviewRequestsStatus = {
        state: 'ready',
        refreshing: false,
        stale: false,
        lastAttemptAt: attemptAt,
        lastSuccessAt: completedAt,
      }
      this.#store.state.reviewRequestsCache = { records: collected, lastSuccessAt: completedAt }
      if (failures.length > 0) {
        this.#store.event('warning', 'reviews', `待 review PR 刷新部分失败：${failures.join('；')}`)
      }
    } catch (error) {
      this.#noteGhFailure(error)
      const detail = messageOf(error)
      const errorEvent = this.#store.event('warning', 'reviews', `待 review PR 刷新失败，保留旧数据：${detail}`)
      this.#reviewRequestsStatus = {
        state: 'error',
        refreshing: false,
        stale: this.#reviewRequests.length > 0,
        lastAttemptAt: attemptAt,
        ...(this.#reviewRequestsStatus.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.#reviewRequestsStatus.lastSuccessAt }),
        error: detail,
        errorEventId: errorEvent.id,
      }
    }
    await this.#store.changed()
  }

  async #tick(): Promise<void> {
    if (this.#draining) return
    const currentTime = Date.now()
    void this.#steerDueAgents(currentTime)
    if (currentTime - this.#lastDshwRepositoryRefreshAt >= DSHW_UPDATE_CHECK_INTERVAL_MS && !this.#updatingDshw) {
      this.#lastDshwRepositoryRefreshAt = currentTime
      void this.#refreshDshwRepository(true)
    }
    if (currentTime - this.#lastDiscoveryAt >= PR_DISCOVERY_INTERVAL_MS) {
      this.#lastDiscoveryAt = currentTime
      void this.#discoverMyPrs()
    }
    if (currentTime - this.#lastRefWatchAt >= REF_WATCH_INTERVAL_MS) {
      this.#lastRefWatchAt = currentTime
      void this.#watchBaseRefs()
    }
    if (currentTime - this.#lastWorkspaceRefreshAt >= WORKSPACE_REFRESH_INTERVAL_MS) {
      this.#lastWorkspaceRefreshAt = currentTime
      void this.#refreshWorkspace()
    }
    if (currentTime - this.#lastPrDashboardRefreshAt >= PR_DASHBOARD_INTERVAL_MS) {
      this.#lastPrDashboardRefreshAt = currentTime
      void this.#refreshPrDashboard()
    }
    this.#startDueAutoReviews()
    void this.#syncFeishuFixProgress()
    for (const sync of [...this.#store.state.syncs]) {
      if (sync.enabled === false) continue
      if (this.#syncLocks.has(sync.id)) continue
      if (sync.immediateCheckRequestedAt !== undefined && Date.parse(sync.immediateCheckRequestedAt) <= currentTime) {
        sync.immediateCheckRequestedAt = undefined
        void this.#withSyncLock(sync, () => this.#checkSync(sync, true, false))
        continue
      }
      if (sync.pendingBaseCheckAt !== undefined && Date.parse(sync.pendingBaseCheckAt) <= currentTime) {
        void this.#withSyncLock(sync, () => this.#checkSync(sync, true, true))
        continue
      }
      if (sync.nextCiCheckAt !== undefined && Date.parse(sync.nextCiCheckAt) <= currentTime) {
        void this.#withSyncLock(sync, () => this.#monitorCi(sync))
        continue
      }
      if (Date.parse(sync.nextPrRefreshAt) <= currentTime) {
        void this.#withSyncLock(sync, () => this.#refreshPrLifecycle(sync))
      }
    }
  }

  async #steerDueAgents(currentTime: number): Promise<void> {
    const jobs = this.#store.state.jobs.filter(job => (
      job.status === 'running'
      && job.dshWorker !== undefined
      && job.cancelRequestedAt === undefined
      && job.nextAgentSteerAt !== undefined
      && Date.parse(job.nextAgentSteerAt) <= currentTime
      && !this.#agentSteersInFlight.has(job.id)
    ))
    for (const job of jobs) {
      const worker = job.dshWorker
      if (worker === undefined) continue
      const phase = this.#workerProgress.get(worker.handle.runId)?.phase
      if (phase === undefined || phase === 'paused' || phase === 'cancelling' || phase === 'finishing') continue
      this.#agentSteersInFlight.add(job.id)
      try {
        const prompt = renderPeriodicAgentReminder(worker)
        await this.#workerRegistry.steer(worker.handle, prompt)
        await this.#appendDshOutput(job, `系统定时 steer：${prompt}`)
        this.#store.event('info', 'dsh-control', `已发送 20 分钟任务边界提醒：${job.summary}`)
      } catch (error) {
        if (job.status === 'running') {
          this.#store.event('warning', 'dsh-control', `20 分钟任务边界提醒发送失败：${job.summary}：${messageOf(error)}`)
        }
      } finally {
        this.#agentSteersInFlight.delete(job.id)
        job.nextAgentSteerAt = job.status === 'running' ? after(AGENT_STEER_INTERVAL_MS) : undefined
        await this.#store.changed()
      }
    }
  }

  async #refreshWorkspace(): Promise<void> {
    if (this.#workspaceRefreshPromise !== undefined) {
      this.#workspaceRefreshQueued = true
      return await this.#workspaceRefreshPromise
    }
    do {
      this.#workspaceRefreshQueued = false
      this.#workspaceRefreshPromise = (async () => {
        const result = await refreshCodeWorkspace(this.#prDashboard)
        if (result.warnings.length > 0) {
          this.#store.event('warning', 'workspace', `code workspace 刷新时跳过 ${result.warnings.length} 个 clone`)
          await this.#store.changed()
        }
      })()
      try {
        await this.#workspaceRefreshPromise
      } catch (error) {
        this.#store.event('error', 'workspace', messageOf(error))
        await this.#store.changed()
      } finally {
        this.#workspaceRefreshPromise = undefined
      }
    } while (this.#workspaceRefreshQueued)
  }

  async #refreshPrDashboard(): Promise<void> {
    if (this.#prDashboardRefreshPromise !== undefined) return await this.#prDashboardRefreshPromise
    this.#lastPrDashboardRefreshAt = Date.now()
    const attemptAt = now()
    this.#prDashboardStatus = {
      ...this.#prDashboardStatus,
      refreshing: true,
      lastAttemptAt: attemptAt,
    }
    this.#broadcast()
    this.#prDashboardRefreshPromise = (async () => {
      // 每个被监控仓库一次 list 查询拿到所有 open PR，避免每个 clone 一次 gh pr view 烧 GraphQL 额度
      const clones = await listClones()
      const enabled = this.#monitoredRepos.filter(repo => repo.enabled)
      const previousByClone = new Map(this.#prDashboard.map(record => [record.cloneName, record]))
      const refreshErrors: string[] = []
      let firstErrorEventId: string | undefined
      const recordRefreshError = (detail: string, kind = 'pr-dashboard'): void => {
        refreshErrors.push(detail)
        const event = this.#store.event('warning', kind, detail)
        firstErrorEventId ??= event.id
      }
      const commitFetches = new Map<string, Promise<void>>()
      const targetTipFetches = new Map<string, Promise<string>>()
      const commonDirs = new Map<string, Promise<string>>()
      const commonDirFor = (clone: CloneRecord): Promise<string> => {
        const existing = commonDirs.get(clone.path)
        if (existing !== undefined) return existing
        const pending = gitCommonDir(clone.path)
        commonDirs.set(clone.path, pending)
        return pending
      }
      const ensureCommitAvailable = async (clone: CloneRecord, branch: string, oid: string): Promise<void> => {
        // Old clone metadata can point sourcePath at the user's original checkout,
        // while the clone is actually a worktree of the managed root. Ask Git for
        // the true object database so shared worktrees never fetch the same ref at once.
        const key = `${await commonDirFor(clone)}\n${branch}\n${oid}`
        const existing = commitFetches.get(key)
        if (existing !== undefined) return await existing
        const promise = (async () => {
          try {
            await commitOid(clone.path, oid)
            return
          } catch {
            await fetchBranch(clone.path, branch)
            await commitOid(clone.path, oid)
          }
        })()
        commitFetches.set(key, promise)
        return await promise
      }
      const latestTargetOid = async (clone: CloneRecord, branch: string): Promise<string> => {
        // Worktrees sharing one object database also share origin refs and fetched objects.
        const key = `${await commonDirFor(clone)}\n${branch}`
        const existing = targetTipFetches.get(key)
        if (existing !== undefined) return await existing
        const promise = fetchRemoteBranchTip(clone.path, branch)
        targetTipFetches.set(key, promise)
        return await promise
      }
      const matched: PrDashboardRecord[] = []
      for (const repo of enabled) {
        const repoSlug = repo.repoSlug
        let openPrs: PullRequestInfo[]
        let assignedOnlyNumbers: ReadonlySet<number> = new Set()
        try {
          const root = await ensureManagedRoot(repoSlug, this.#installation)
          const combined = await dashboardOpenPullRequests(root, repoSlug)
          openPrs = combined.prs
          assignedOnlyNumbers = combined.assignedOnlyNumbers
        } catch (error) {
          this.#noteGhFailure(error)
          recordRefreshError(`${repoSlug}: ${messageOf(error)}`)
          // 单次网络抖动或 GraphQL 超时不该清空整张看板：沿用该仓库上一次成功刷新的记录
          matched.push(...[...previousByClone.values()].filter(record => record.repoSlug === repoSlug))
          continue
        }
        const byBranch = new Map(openPrs.map(pr => [pr.headRefName, pr]))
        const repoClones = clones.filter(clone => clone.repoSlug === repoSlug)
        const clonedBranches = new Set(repoClones.map(clone => `${clone.repoSlug}\n${clone.branch}`))
        const pendingClones = openPrs.filter(pr => !clonedBranches.has(`${repoSlug}\n${pr.headRefName}`))
        if (pendingClones.length > 0) recordRefreshError(`${repoSlug}: ${pendingClones.length} 个 open PR 的本地 clone 尚未准备完成`)
        const records = await Promise.all(repoClones.map(async clone => {
          try {
            const pr = byBranch.get(clone.branch)
            if (pr === undefined) return undefined
            const previous = previousByClone.get(clone.name)
            const checks = rollupChecks(pr.statusCheckRollup)
            const ci = summarizeChecks(checks)
            const conflicting = pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'
            await ensureCommitAvailable(clone, pr.headRefName, pr.headRefOid)
            const targetOid = pr.mergeable === 'MERGEABLE' || conflicting
              ? await latestTargetOid(clone, pr.baseRefName)
              : undefined
            const localGitStatus = await cloneGitStatus(clone.path, pr.headRefOid)
            // GitHub 对落后的 PR 也报 BLOCKED 而非 BEHIND，用本地 git 判断是否落后 base
            const baseBehind = pr.mergeable === 'MERGEABLE'
              && targetOid !== undefined
              && !(await isAncestor(clone.path, targetOid, pr.headRefOid))
            let conflictPaths = conflicting ? previous?.conflictPaths : undefined
            if (conflicting && targetOid !== undefined) {
              try {
                // GitHub computes mergeability against the current target tip. baseRefOid is
                // only the PR's base snapshot and can remain an ancestor after target moves.
                conflictPaths = await this.#cachedConflictPaths(clone.repoSlug, clone.path, pr.headRefOid, targetOid)
              } catch (error) {
                const detail = `${clone.name} 冲突文件：${messageOf(error)}`
                recordRefreshError(detail, 'conflict-paths')
                this.#noteGhFailure(error)
              }
            }
            const sync = this.#store.state.syncs.find(candidate => (
              candidate.repoSlug === clone.repoSlug && candidate.prNumber === pr.number
            ))
            const record: PrDashboardRecord = {
              cloneName: clone.name,
              clonePath: clone.path,
              repoSlug: clone.repoSlug,
              number: pr.number,
              title: pr.title,
              url: pr.url,
              state: pr.state,
              isDraft: pr.isDraft,
              branch: pr.headRefName,
              baseRefName: pr.baseRefName,
              author: pr.author?.login ?? '',
              ...(assignedOnlyNumbers.has(pr.number) ? { assignedToMe: true } : {}),
              headOid: pr.headRefOid,
              baseOid: pr.baseRefOid,
              mergeable: pr.mergeable,
              mergeStateStatus: pr.mergeStateStatus,
              ...(conflictPaths === undefined ? {} : { conflictPaths }),
              ...(conflictPaths !== undefined
                && conflictPaths.length > 0
                && conflictPaths.every(isDocumentationConflictPath)
                ? { autoMergeSkippedReason: '仅文档冲突' }
                : {}),
              ...(baseBehind ? { baseBehind: true } : {}),
              reviewDecision: pr.reviewDecision,
              reviewRequests: pr.reviewRequests
                .filter(request => request.__typename === 'User' && request.login !== undefined)
                .map(request => request.login!),
              reviews: pr.latestReviews,
              reviewerComments: previous?.reviewerComments ?? {},
              ciStatus: ci.status,
              ciSummary: ci.summary,
              checks,
              localGitStatus,
              ...(sync === undefined ? {} : {
                syncId: sync.id,
                syncEnabled: sync.enabled !== false,
                ...(sync.pendingBaseCheckAt === undefined ? {} : { pendingBaseCheckAt: sync.pendingBaseCheckAt }),
                ...(sync.agentPausedReason === undefined ? {} : { agentPausedReason: sync.agentPausedReason }),
              }),
              ...(previous?.unresolvedComments === undefined ? {} : { unresolvedComments: previous.unresolvedComments }),
              updatedAt: now(),
            }
            return record
          } catch (error) {
            const detail = `${clone.name}: ${messageOf(error)}`
            recordRefreshError(detail)
            this.#noteGhFailure(error)
            return previousByClone.get(clone.name)
          }
        }))
        matched.push(...records.filter((record): record is PrDashboardRecord => record !== undefined))
      }
      this.#prDashboard = matched
        .sort((left, right) => Number(left.isDraft) - Number(right.isDraft) || left.number - right.number || left.cloneName.localeCompare(right.cloneName))
      // Do not hold the first visible PR rows behind the more expensive review-thread query.
      this.#broadcast()
      if (Date.now() - this.#lastReviewProgressRefreshAt >= PR_REVIEW_INTERVAL_MS) {
        this.#lastReviewProgressRefreshAt = Date.now()
        try {
          const byRepo = new Map<string, PrDashboardRecord[]>()
          for (const record of matched) {
            const group = byRepo.get(record.repoSlug) ?? []
            group.push(record)
            byRepo.set(record.repoSlug, group)
          }
          for (const [repoSlug, records] of byRepo) {
            const root = await ensureManagedRoot(repoSlug, this.#installation)
            const progress = await reviewerCommentProgress(root, repoSlug, records.map(record => record.number))
            for (const record of records) {
              record.reviewerComments = progress.get(record.number) ?? {}
              const unresolved = Object.values(record.reviewerComments)
                .reduce((count, reviewer) => count + reviewer.total - reviewer.resolved, 0)
              delete record.unresolvedComments
              if (unresolved > 0) record.unresolvedComments = unresolved
            }
          }
        } catch (error) {
          const detail = `review 评论计数失败：${messageOf(error)}`
          recordRefreshError(detail)
          this.#noteGhFailure(error)
        }
      }
      const completedAt = now()
      const complete = refreshErrors.length === 0
      const lastSuccessAt = complete ? completedAt : this.#prDashboardStatus.lastSuccessAt
      this.#prDashboardStatus = complete ? {
        state: 'ready',
        refreshing: false,
        stale: false,
        lastAttemptAt: attemptAt,
        lastSuccessAt: completedAt,
      } : {
        state: 'error',
        refreshing: false,
        stale: true,
        lastAttemptAt: attemptAt,
        ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
        error: summarizePrDashboardErrors(refreshErrors.length > 0 ? refreshErrors : ['已发现 open PR，但对应 clone 尚未准备完成']),
        ...(firstErrorEventId === undefined ? {} : { errorEventId: firstErrorEventId }),
      }
      this.#store.state.prDashboardCache = {
        records: this.#prDashboard,
        ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
      }
      if (complete) this.#clearRateLimited()
      await this.#store.changed()
      await this.#observeAutoReviews()
      await this.#refreshWorkspace()
    })().catch(async (error: unknown) => {
      // 整体失败（如 GraphQL 限流）时保留旧 dashboard，不要清空列表
      this.#noteGhFailure(error)
      const detail = summarizePrDashboardErrors([messageOf(error)])
      const errorEvent = this.#store.event('warning', 'pr-dashboard', `PR 列表刷新失败，保留旧数据：${messageOf(error)}`)
      this.#prDashboardStatus = {
        state: 'error',
        refreshing: false,
        stale: this.#prDashboard.length > 0,
        lastAttemptAt: attemptAt,
        ...(this.#prDashboardStatus.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.#prDashboardStatus.lastSuccessAt }),
        error: detail,
        errorEventId: errorEvent.id,
      }
      await this.#store.changed()
    })
    try {
      await this.#prDashboardRefreshPromise
    } finally {
      this.#prDashboardRefreshPromise = undefined
    }
  }

  /** PR 操作可能同时改变 review、CI 和 merge 状态；完成后绕过定时缓存立即刷新。 */
  async #refreshPrDashboardAfterAction(): Promise<void> {
    // 如果定时刷新恰好正在进行，等它结束后再发起一轮，避免复用任务开始前的旧结果。
    while (this.#prDashboardRefreshPromise !== undefined) {
      await this.#prDashboardRefreshPromise
    }
    this.#lastPrDashboardRefreshAt = 0
    this.#lastReviewProgressRefreshAt = 0
    await this.#refreshPrDashboard()
  }

  async #cachedConflictPaths(repoSlug: string, root: string, headOid: string, baseOid: string): Promise<string[]> {
    const key = `${repoSlug}\n${headOid}\n${baseOid}`
    const existing = this.#conflictPathsCache.get(key)
    if (existing !== undefined) return await existing
    const pending = mergeConflictPaths(root, headOid, baseOid)
    this.#conflictPathsCache.set(key, pending)
    if (this.#conflictPathsCache.size > 100) {
      const oldest = this.#conflictPathsCache.keys().next().value
      if (oldest !== undefined && oldest !== key) this.#conflictPathsCache.delete(oldest)
    }
    try {
      return await pending
    } catch (error) {
      this.#conflictPathsCache.delete(key)
      throw error
    }
  }

  /** Refresh and exactly align a managed merge worktree before any preflight or Agent delegation. */
  async #prepareMergeWorktree(sync: SyncRecord, signal: AbortSignal): Promise<void> {
    const head = await fetchPullRequestHead(sync.clonePath, sync.prNumber, signal)
    const result = await synchronizeMergeWorktree(sync.clonePath, head.ref)
    sync.headOid = head.oid
    sync.updatedAt = now()
    if (result.mode === 'fast-forwarded') {
      this.#store.event(
        'info',
        'merge-head-sync',
        `${sync.cloneName} / PR #${sync.prNumber}: 合并前已 fast-forward 到 GitHub PR head ${head.oid.slice(0, 10)}`,
      )
    } else if (result.mode === 'reset') {
      this.#store.event(
        'warning',
        'merge-head-sync',
        `${sync.cloneName} / PR #${sync.prNumber}: 合并前已从 ${result.previousHead.slice(0, 10)} 对齐到 GitHub PR head ${head.oid.slice(0, 10)}；原本地提交保留在 ${result.recoveryRef}`,
      )
    } else {
      this.#store.event(
        'info',
        'merge-head-sync',
        `${sync.cloneName} / PR #${sync.prNumber}: 合并前 worktree 已是 GitHub PR head ${head.oid.slice(0, 10)}`,
      )
    }
    await this.#store.changed()
  }

  /** gh 调用失败时识别 GraphQL 限流；REST core 是独立额度，可顺带查出重置时间。 */
  #noteGhFailure(error: unknown): void {
    if (!/rate limit/iu.test(messageOf(error)) || this.#rateLimited) return
    this.#rateLimited = true
    void (async () => {
      const result = await run('gh', ['api', 'rate_limit', '--jq', '.resources.graphql.reset'], { cwd: HARNESS_ROOT, timeoutMs: 15_000 })
      const epoch = Number(result.stdout.trim())
      if (result.code === 0 && Number.isFinite(epoch)) this.#rateLimitResetAt = new Date(epoch * 1_000).toISOString()
      await this.#store.changed()
    })()
  }

  /** 用户有权限的仓库列表（10 分钟缓存；gh 分页拉取较慢）。 */
  async #userRepos(): Promise<string[]> {
    const cached = this.#userReposCache
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.repos
    const repos = await listUserRepos(HARNESS_ROOT)
    this.#userReposCache = { repos, fetchedAt: Date.now() }
    return repos
  }

  #clearRateLimited(): void {
    if (!this.#rateLimited) return
    this.#rateLimited = false
    this.#rateLimitResetAt = undefined
  }

  async #withSyncLock(sync: SyncRecord, task: () => Promise<void>): Promise<void> {
    this.#syncLocks.add(sync.id)
    try {
      await task()
    } catch (error) {
      if (isTaskCancelled(error)) {
        sync.lastError = undefined
        sync.updatedAt = now()
        sync.nextPrRefreshAt = after(PR_WATCH_INTERVAL_MS)
        this.#store.event('warning', 'task', `${sync.cloneName} / PR #${sync.prNumber}: 任务已被手动终止`)
        await this.#store.changed()
        return
      }
      sync.status = 'error'
      sync.lastError = messageOf(error)
      sync.updatedAt = now()
      sync.nextPrRefreshAt = after(PR_WATCH_INTERVAL_MS)
      if (sync.pendingBaseCheckAt !== undefined && Date.parse(sync.pendingBaseCheckAt) <= Date.now()) {
        sync.pendingBaseCheckAt = after(REF_WATCH_INTERVAL_MS)
        this.#recomputeNextUpdate()
      }
      this.#store.event('error', 'sync', `${sync.cloneName} / PR #${sync.prNumber}: ${messageOf(error)}`)
      await this.#store.changed()
    } finally {
      this.#syncLocks.delete(sync.id)
      this.#broadcast()
    }
  }

  async #refreshPrLifecycle(sync: SyncRecord): Promise<void> {
    const pr = await pullRequest(sync.clonePath, sync.repoSlug, sync.prNumber)
    if (pr.state !== 'OPEN') {
      await this.#closeSync(sync, `PR #${sync.prNumber} 已不再 open，sync 自动停止`)
      return
    }
    const wasDraft = sync.status === 'draft'
    sync.status = pr.isDraft ? 'draft' : 'active'
    sync.pausedReason = pr.isDraft ? 'PR 是 draft，冲突同步和 CI 修复均已暂停' : undefined
    sync.baseRefName = pr.baseRefName
    sync.baseOid = pr.baseRefOid
    sync.headOid = pr.headRefOid
    sync.updatedAt = now()
    sync.nextPrRefreshAt = after(PR_WATCH_INTERVAL_MS)
    if (wasDraft && !pr.isDraft) {
      sync.immediateCheckRequestedAt = now()
      this.#store.event('info', 'sync', `PR #${sync.prNumber} 已退出 draft，sync 自动恢复`)
    }
    await this.#store.changed()
  }

  async #watchBaseRefs(): Promise<void> {
    const active = this.#store.state.syncs.filter(sync => sync.status !== 'closed' && sync.enabled !== false)
    const groups = new Map<string, SyncRecord[]>()
    for (const sync of active) {
      const key = `${sync.repoSlug}\n${sync.baseRefName}`
      const group = groups.get(key) ?? []
      group.push(sync)
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      const first = group[0]
      if (first === undefined) continue
      try {
        const oid = await remoteBranchOid(first.repoSlug, first.baseRefName)
        for (const sync of group) {
          const observation = observeBaseTip(sync, oid)
          if (observation !== 'changed') {
            if (observation === 'initialized') sync.updatedAt = now()
            continue
          }
          const scheduledAt = scheduleBaseCheck(sync)
          sync.updatedAt = now()
          this.#store.event(
            'info',
            'base-push',
            `${sync.repoSlug}:${sync.baseRefName} 有新 push；PR #${sync.prNumber} 将在 10 分钟静默期后检查冲突（最晚 ${scheduledAt}）`,
          )
        }
        this.#recomputeNextUpdate()
        await this.#store.changed()
      } catch (error) {
        this.#store.event('warning', 'base-watch', `${first.repoSlug}:${first.baseRefName}: ${messageOf(error)}`)
        await this.#store.changed()
      }
    }
  }

  async #checkSync(sync: SyncRecord, checkCiNow: boolean, updateHarnessFirst: boolean): Promise<void> {
    const job = this.#beginJob('sync-check', `${sync.cloneName} / PR #${sync.prNumber} 即时状态检查`, sync.id)
    const signal = this.#jobSignal(job)
    try {
      if (updateHarnessFirst) {
        clearPendingBaseCheck(sync)
        this.#recomputeNextUpdate()
        await this.#ensureHarnessUpdated()
      }
      let pr = await pullRequest(sync.clonePath, sync.repoSlug, sync.prNumber, undefined, signal)
      if (pr.state !== 'OPEN') {
        await this.#closeSync(sync, `PR #${sync.prNumber} 已不再 open，sync 自动停止`)
        this.#finishJob(job, 'succeeded', 'PR 已关闭，sync 自动停止')
        return
      }
      this.#applyPr(sync, pr)
      if (pr.isDraft) {
        sync.status = 'draft'
        sync.pausedReason = 'PR 是 draft，冲突同步和 CI 修复均已暂停'
        this.#finishJob(job, 'succeeded', 'draft PR：两个 sync 操作均暂停')
        await this.#store.changed()
        return
      }
      sync.status = 'active'
      sync.pausedReason = undefined

      if (checkCiNow) await this.#inspectCi(sync, false, signal)
      pr = await pullRequest(sync.clonePath, sync.repoSlug, sync.prNumber, undefined, signal)
      this.#applyPr(sync, pr)
      let mergeSummary = `mergeable=${pr.mergeable}`
      if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
        await this.#prepareMergeWorktree(sync, signal)
        const preflight = await fetchMergePreflight(sync.clonePath, sync.baseRefName, 'HEAD', signal)
        const { conflictPaths } = preflight
        if (conflictPaths.length > 0 && conflictPaths.every(isDocumentationConflictPath)) {
          mergeSummary += '（仅文档冲突，跳过自动合并）'
          this.#store.event(
            'info',
            'mergeability',
            `PR #${sync.prNumber} 仅有文档冲突，跳过自动合并：${conflictPaths.join('、')}`,
          )
        } else if (conflictPaths.length === 0) {
          await this.#mergeBaseDirect(sync, preflight.targetRef, signal)
          mergeSummary += '（本地预检无冲突，已直接合并并 push）'
          this.#store.event(
            'info',
            'merge-base',
            `${sync.cloneName} / PR #${sync.prNumber}: GitHub 报告冲突，但本地预检无冲突；已直接合并 origin/${sync.baseRefName} 并 push`,
          )
        } else {
          await this.#runAgent(sync, 'merge-base')
        }
      } else if (pr.mergeable === 'UNKNOWN') {
        sync.immediateCheckRequestedAt = after(30_000)
        this.#store.event('warning', 'mergeability', `PR #${sync.prNumber} 的 mergeable 暂为 UNKNOWN，30 秒后重试`)
      } else {
        this.#store.event('info', 'mergeability', `PR #${sync.prNumber} 可合并，无需同步 ${sync.baseRefName}`)
      }
      sync.nextPrRefreshAt = after(PR_WATCH_INTERVAL_MS)
      sync.updatedAt = now()
      this.#finishJob(job, 'succeeded', `${mergeSummary}, CI=${sync.lastCiStatus ?? '未检查'}`)
      await this.#store.changed()
    } catch (error) {
      this.#noteGhFailure(error)
      if (updateHarnessFirst && sync.pendingBaseCheckAt === undefined) {
        sync.immediateCheckRequestedAt = after(REF_WATCH_INTERVAL_MS)
      }
      this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', messageOf(error))
      await this.#store.changed()
      throw error
    }
  }

  async #inspectCi(sync: SyncRecord, postPush: boolean, signal?: AbortSignal): Promise<void> {
    const checks = await ciChecks(sync.clonePath, sync.repoSlug, sync.prNumber, signal)
    const summary = summarizeChecks(checks)
    sync.lastCiStatus = summary.status
    this.#store.event(summary.status === 'failed' ? 'warning' : 'info', 'ci', `PR #${sync.prNumber}: ${summary.summary}`)
    if (summary.status === 'pending') {
      sync.ciMonitorHeadOid = sync.headOid
      sync.nextCiCheckAt = after(CI_WATCH_INTERVAL_MS)
      sync.noChecksSince = undefined
    } else if (summary.status === 'failed' && sync.lastFixedHeadOid !== sync.headOid) {
      await this.#autoFixCi(sync, checks, signal)
    } else if (summary.status === 'none' && postPush) {
      sync.ciMonitorHeadOid = sync.headOid
      sync.noChecksSince ??= now()
      sync.nextCiCheckAt = after(CI_WATCH_INTERVAL_MS)
    } else {
      sync.ciMonitorHeadOid = undefined
      sync.nextCiCheckAt = undefined
      sync.noChecksSince = undefined
    }
  }

  async #monitorCi(sync: SyncRecord): Promise<void> {
    const pr = await pullRequest(sync.clonePath, sync.repoSlug, sync.prNumber)
    if (pr.state !== 'OPEN') {
      await this.#closeSync(sync, `PR #${sync.prNumber} 已不再 open，sync 自动停止`)
      return
    }
    this.#applyPr(sync, pr)
    if (pr.isDraft) {
      sync.status = 'draft'
      sync.pausedReason = 'PR 是 draft，冲突同步和 CI 修复均已暂停'
      sync.nextCiCheckAt = undefined
      await this.#store.changed()
      return
    }
    const checks = await ciChecks(sync.clonePath, sync.repoSlug, sync.prNumber)
    const summary = summarizeChecks(checks)
    sync.lastCiStatus = summary.status
    if (summary.status === 'pending') {
      sync.nextCiCheckAt = after(CI_WATCH_INTERVAL_MS)
    } else if (summary.status === 'none') {
      sync.noChecksSince ??= now()
      if (Date.now() - Date.parse(sync.noChecksSince) < NO_CHECKS_GRACE_MS) {
        sync.nextCiCheckAt = after(CI_WATCH_INTERVAL_MS)
      } else {
        sync.nextCiCheckAt = undefined
        sync.ciMonitorHeadOid = undefined
        this.#store.event('warning', 'ci', `PR #${sync.prNumber} push 后 5 分钟仍无 checks，停止等待`)
      }
    } else if (summary.status === 'failed') {
      sync.nextCiCheckAt = undefined
      if (sync.lastFixedHeadOid !== sync.headOid) await this.#autoFixCi(sync, checks)
    } else {
      sync.nextCiCheckAt = undefined
      sync.ciMonitorHeadOid = undefined
      sync.noChecksSince = undefined
      this.#store.event('info', 'ci', `PR #${sync.prNumber}: ${summary.summary}`)
    }
    sync.updatedAt = now()
    await this.#store.changed()
  }

  async #autoFixCi(sync: SyncRecord, checks: readonly CiCheck[], signal?: AbortSignal): Promise<void> {
    const assessment = await assessCiAutoFix(sync.clonePath, sync.repoSlug, checks, sync.baseRefName, signal)
    if (assessment.failingBaseChecks.length > 0) {
      this.#store.event(
        'warning',
        'ci',
        `PR #${sync.prNumber}: ${assessment.failingBaseChecks.map(check => check.name).join('、')} 对应的 master CI lane 最近一次明确结果也失败，不作为自动修复触发项`,
      )
    }
    if (assessment.actionableChecks.length === 0) return
    const additionalInstruction = assessment.failingBaseChecks.length === 0
      ? undefined
      : [
          `本次自动修复只由这些失败 checks 触发：${assessment.actionableChecks.map(check => check.name).join('、')}。`,
          `以下 checks 对应的 master CI lanes 最近一次明确结果也失败，不属于本次修复范围：${assessment.failingBaseChecks.map(check => check.name).join('、')}。`,
        ].join('\n')
    await this.#runAgent(sync, 'fix-ci', undefined, additionalInstruction)
  }

  async #runAgent(
    sync: SyncRecord,
    kind: 'merge-base' | 'fix-ci' | 'resolve-comments' | 'custom' | 'review' | 'auto-review-fix',
    selectedWorker?: WorkerExecutionConfig,
    additionalInstruction?: string,
    existingJob?: JobRecord,
    options: { turns?: string[], push?: boolean } = {},
  ): Promise<void> {
    if (sync.agentPausedReason !== undefined) {
      this.#store.event(
        'warning',
        'dsh-paused',
        `${sync.cloneName} / PR #${sync.prNumber}: 自动 dsh 任务已暂停（${sync.agentPausedReason}）`,
      )
      await this.#store.changed()
      return
    }
    const type = kind
    const label = kind === 'merge-base'
      ? `合并 ${sync.baseRefName}`
      : kind === 'fix-ci'
        ? '修复 CI'
        : kind === 'resolve-comments' ? '解决 review 评论' : kind === 'review' ? 'Review 对话' : kind === 'auto-review-fix' ? '自动评审修复' : '自定义任务'
    const job = existingJob ?? this.#beginJob(type, `${sync.cloneName} / PR #${sync.prNumber}: ${label}`, sync.id)
    job.summary = `${sync.cloneName} / PR #${sync.prNumber}: ${label}`
    const oldHead = sync.headOid
    try {
      if (kind === 'fix-ci') sync.lastFixedHeadOid = oldHead
      const workerConfig = selectedWorker ?? this.#workers.executionConfig()
      job.executor = workerConfig.name
      const handle = await this.#workerRegistry.start(sync, kind, workerConfig, additionalInstruction)
      job.dshWorker = { handle, kind, sync: structuredClone(sync), oldHead, label, ...(options.push === true ? { push: true } : {}) }
      job.nextAgentSteerAt = kind === 'review' ? undefined : after(AGENT_STEER_INTERVAL_MS)
      await this.#store.changed()
      if (options.turns !== undefined) await this.#driveDshTurns(handle, options.turns)
      await this.#completeDshJob(job, sync)
    } catch (error) {
      if (job.dshWorker === undefined) {
        this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', messageOf(error))
        await this.#store.changed()
      }
      throw error
    }
  }


  /**
   * Drive the auto-review fix conversation: wait until the session is paused
   * after a turn, steer the next one, and complete the session at the end.
   */
  async #driveDshTurns(handle: DshWorkerHandle, prompts: readonly string[]): Promise<void> {
    for (const prompt of prompts) {
      if (!await this.#waitDshPaused(handle)) return
      const tail = this.#workerProgress.get(handle.runId)?.outputTail ?? ''
      if (/DSHW_RESULT:\s*blocked/iu.test(tail)) return
      await steerDshWorker(handle, prompt)
    }
    if (!await this.#waitDshPaused(handle)) return
    await completeDshWorker(handle)
  }

  /** Poll the worker until it pauses; false when it exited or timed out. */
  async #waitDshPaused(handle: DshWorkerHandle): Promise<boolean> {
    const deadline = Date.now() + 30 * 60 * 1000
    while (Date.now() < deadline) {
      const progress = this.#workerProgress.get(handle.runId)
      if (progress?.phase === 'paused') return true
      if (progress === undefined) return false
      try {
        const inspected = await inspectDshWorker(handle)
        if (inspected.phase === 'paused') return true
      } catch {
        return false
      }
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    return false
  }

  async #completeDshJob(job: JobRecord, sync: SyncRecord): Promise<void> {
    const worker = job.dshWorker
    if (worker === undefined) throw new Error(`任务 ${job.id} 缺少 dsh worker 状态`)
    const signal = this.#jobSignal(job)
    this.#externalDshSyncs.add(sync.id)
    try {
      const record = await this.#workerRegistry.wait(worker.handle, signal)
      if (!this.#store.state.dshRuns.some(candidate => candidate.id === record.id)) {
        this.#store.state.dshRuns.push(record)
      }
      job.output = record.finalOutput
      if (record.status === 'cancelled') throw new TaskCancelledError()
      if (record.status === 'failed') throw new Error(`${worker.handle.workerType ?? 'dsh'} 调用失败：${record.finalOutput}`)
      if (record.status === 'blocked') {
        const reason = record.blockedReason ?? 'dsh 报告任务无法完成'
        if (worker.kind === 'fix-ci' && sync.lastFixedHeadOid === worker.oldHead) {
          sync.lastFixedHeadOid = undefined
        }
        sync.agentPausedAt = now()
        sync.agentPausedReason = reason
        sync.updatedAt = now()
        this.#finishJob(job, 'blocked', `无法完成：${reason}`)
        this.#store.event(
          'error',
          'dsh-blocked',
          `${sync.cloneName} / PR #${sync.prNumber}: ${reason}；后续自动 dsh 任务已暂停`,
        )
        await this.#store.changed()
        return
      }
      if (worker.kind === 'review') {
        this.#finishJob(job, 'succeeded', `${worker.label}已完成`)
        this.#store.event('info', 'review', `${sync.repoSlug} / PR #${sync.prNumber}: ${worker.label}已完成`)
        await this.#store.changed()
        return
      }

      if (worker.kind === 'auto-review-fix') {
        const record = this.#autoReview.records().find(candidate => candidate.fix?.jobId === job.id)
        if (record === undefined) {
          this.#finishJob(job, 'succeeded', `${worker.label} 已完成`)
          await this.#store.changed()
          return
        }
        const output = job.output ?? ''
        const blocked = /DSHW_RESULT:\s*blocked\s*$/imu.test(output)
        const diff = await captureFixDiff(sync.clonePath)
        if (worker.push === true) {
          const pushed = await pullRequest(sync.clonePath, sync.repoSlug, sync.prNumber).catch(() => undefined)
          if (pushed !== undefined) this.#applyPr(sync, pushed)
          record.fix = {
            ...record.fix!,
            status: 'pushed',
            finishedAt: now(),
            diff,
            ...(pushed === undefined ? {} : { producedHeadOid: pushed.headRefOid }),
          }
          this.#finishJob(job, 'succeeded', `${worker.label} 已 push`)
          this.#store.event('info', 'auto-review', `${sync.repoSlug} / PR #${sync.prNumber}: 修复已推送`)
        } else {
          const parsed = parseFixSummary(output)
          record.fix = {
            ...record.fix!,
            status: blocked ? 'blocked' : 'ready',
            finishedAt: now(),
            diff,
            ...(parsed.summary === '' ? {} : { summary: parsed.summary }),
            ...(parsed.notes.length === 0 ? {} : { notes: parsed.notes }),
            ...(blocked ? { blockedReason: output.slice(-600) } : {}),
          }
          this.#finishJob(job, 'succeeded', `${worker.label} 完成（未推送，等待确认）`)
          this.#store.event('info', 'auto-review', `${sync.repoSlug} / PR #${sync.prNumber}: 修复完成，改动留在工作区等待确认`)
        }
        record.updatedAt = now()
        await this.#autoReview.saveRecord(record)
        void this.#feishu.notifyFix(record, record.fix.status).catch(() => { /* recorded as an event by the bot */ })
        await this.#store.changed()
        return
      }
      const localHead = await currentHead(sync.clonePath)
      const pr = await pullRequest(sync.clonePath, sync.repoSlug, sync.prNumber, undefined, signal)
      this.#applyPr(sync, pr)
      if (localHead === worker.oldHead && pr.headRefOid === worker.oldHead) {
        throw new Error(`dsh 完成了 ${worker.label}，但没有产生并 push 新提交`)
      }
      sync.ciMonitorHeadOid = pr.headRefOid
      sync.noChecksSince = now()
      sync.nextCiCheckAt = after(15_000)
      this.#finishJob(job, 'succeeded', `${worker.label} 已 push；开始等待新 CI`)
      this.#store.event('info', 'dsh', `${sync.cloneName} / PR #${sync.prNumber}: ${worker.label} 已完成`)
      await this.#store.changed()
    } catch (error) {
      if (worker.kind === 'fix-ci' && isTaskCancelled(error) && sync.lastFixedHeadOid === worker.oldHead) {
        sync.lastFixedHeadOid = undefined
      }
      this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', messageOf(error))
      await this.#store.changed()
      throw error
    } finally {
      this.#workerProgress.delete(worker.handle.runId)
      this.#broadcastProgress()
      this.#externalDshSyncs.delete(sync.id)
      void this.#refreshPrDashboardAfterAction()
    }
  }

  #resumeDshJobs(): void {
    const jobs = this.#store.state.jobs.filter(job => job.status === 'running' && job.dshWorker !== undefined)
    for (const job of jobs) {
      const worker = job.dshWorker
      if (worker === undefined) continue
      if (worker.kind === 'review') job.nextAgentSteerAt = undefined
      else job.nextAgentSteerAt ??= new Date(Date.parse(job.startedAt ?? worker.handle.startedAt) + AGENT_STEER_INTERVAL_MS).toISOString()
      const sync = this.#store.state.syncs.find(candidate => candidate.id === job.syncId) ?? structuredClone(worker.sync)
      if (this.#syncLocks.has(sync.id)) {
        job.status = 'failed'
        job.finishedAt = now()
        job.summary = `${job.summary}（恢复时发现同一 PR 已有任务）`
        continue
      }
      const controller = new AbortController()
      this.#jobControllers.set(job.id, controller)
      if (job.cancelRequestedAt !== undefined) controller.abort()
      this.#externalDshSyncs.add(sync.id)
      this.#store.event('info', 'dsh', `重新接管 ${sync.cloneName} / PR #${sync.prNumber} 的 dsh worker ${worker.handle.label}`)
      void this.#workerRegistry.inspect(worker.handle).then(progress => {
        this.#workerProgress.set(worker.handle.runId, progress)
        this.#broadcastProgress()
      }).catch(() => {})
      void this.#withSyncLock(sync, () => this.#completeDshJob(job, sync))
    }
    if (jobs.length > 0) void this.#store.changed()
  }

  async #manualSync(clone: CloneRecord): Promise<SyncRecord> {
    const pr = await pullRequest(clone.path, clone.repoSlug, undefined, clone.branch)
    if (pr.state !== 'OPEN') throw new Error(`PR #${pr.number} 当前不是 open 状态`)
    const existing = this.#store.state.syncs.find(candidate => (
      candidate.repoSlug === clone.repoSlug && candidate.prNumber === pr.number
    ))
    if (existing !== undefined) {
      this.#applyPr(existing, pr)
      return existing
    }
    return this.#manualSyncFromPr(clone, pr)
  }

  #manualSyncFromPr(clone: CloneRecord, pr: PullRequestInfo): SyncRecord {
    const timestamp = now()
    return {
      id: `manual:${clone.path}`,
      cloneName: clone.name,
      clonePath: clone.path,
      remoteUrl: `https://github.com/${clone.repoSlug}.git`,
      repoSlug: clone.repoSlug,
      prNumber: pr.number,
      prTitle: pr.title,
      prUrl: pr.url,
      branch: pr.headRefName,
      baseRefName: pr.baseRefName,
      baseOid: pr.baseRefOid,
      headOid: pr.headRefOid,
      status: pr.isDraft ? 'draft' : 'active',
      pausedReason: pr.isDraft ? 'PR 是 draft；自动任务已暂停，手动操作仍可执行' : undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextPrRefreshAt: after(PR_WATCH_INTERVAL_MS),
    }
  }

  #prepareManualAction(sync: SyncRecord, label: string): void {
    if (this.#syncLocks.has(sync.id)) throw new Error(`${sync.cloneName} 已有任务执行中`)
    if (sync.agentPausedReason !== undefined) {
      this.#store.event('info', 'dsh-resumed', `${sync.cloneName} / PR #${sync.prNumber}: 手动操作恢复 dsh 任务`)
      sync.agentPausedAt = undefined
      sync.agentPausedReason = undefined
    }
    this.#store.event('info', 'manual', `${sync.cloneName} / PR #${sync.prNumber}: ${label}`)
    void this.#store.changed()
  }

  #startManualAction(sync: SyncRecord, action: 'fix-ci' | 'resolve-comments' | 'custom' | 'review', workerConfig: WorkerExecutionConfig, additionalInstruction?: string): void {
    const label = action === 'fix-ci' ? '手动修复 CI' : action === 'resolve-comments' ? '手动解决 review 评论' : action === 'review' ? '手动发起 Review 对话' : '手动执行自定义任务'
    this.#prepareManualAction(sync, label)
    void this.#withSyncLock(sync, async () => {
      await this.#runAgent(sync, action, workerConfig, additionalInstruction)
    })
  }

  #startManualMergeBase(sync: SyncRecord, workerConfigId?: string, additionalInstruction?: string): void {
    this.#prepareManualAction(sync, `手动合并最新 ${sync.baseRefName}`)
    void this.#withSyncLock(sync, async () => {
      await this.#runMergeBaseWithPreflight(sync, workerConfigId, additionalInstruction)
    })
  }

  /** Always preview the latest target locally; use an Agent only for confirmed conflicts. */
  async #runMergeBaseWithPreflight(
    sync: SyncRecord,
    workerConfigId?: string,
    additionalInstruction?: string,
  ): Promise<void> {
    const job = this.#beginJob('merge-base', `${sync.cloneName} / PR #${sync.prNumber}: 直接合并 ${sync.baseRefName}`, sync.id)
    const signal = this.#jobSignal(job)
    let delegatedToAgent = false
    try {
      await this.#prepareMergeWorktree(sync, signal)
      const preflight = await fetchMergePreflight(sync.clonePath, sync.baseRefName, 'HEAD', signal)
      if (preflight.conflictPaths.length > 0) {
        this.#store.event(
          'info',
          'merge-preflight',
          `${sync.cloneName} / PR #${sync.prNumber}: 本地预检确认 ${preflight.conflictPaths.length} 个冲突文件；启动 Agent`,
        )
        await this.#store.changed()
        const workerConfig = this.#workers.executionConfig(workerConfigId)
        this.#workerRegistry.assertAvailable(workerConfig.type)
        delegatedToAgent = true
        await this.#runAgent(sync, 'merge-base', workerConfig, additionalInstruction, job)
        return
      }
      await this.#mergeBaseDirect(sync, preflight.targetRef, signal)
      this.#finishJob(job, 'succeeded', `已合并 origin/${sync.baseRefName} 并 push（本地预检无冲突，未启动 Agent）`)
      this.#store.event('info', 'merge-base', `${sync.cloneName} / PR #${sync.prNumber}: 本地预检无冲突；已直接合并 origin/${sync.baseRefName} 并 push`)
      await this.#store.changed()
    } catch (error) {
      if (job.status === 'running') {
        this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', messageOf(error))
        await this.#store.changed()
      }
      this.#store.event('error', 'merge-base', `${sync.cloneName} / PR #${sync.prNumber}: ${messageOf(error)}`)
      throw error
    } finally {
      if (!delegatedToAgent || job.dshWorker === undefined) void this.#refreshPrDashboardAfterAction()
    }
  }

  async #mergeBaseDirect(sync: SyncRecord, targetRef: string, signal: AbortSignal): Promise<void> {
    await runOrThrow('git', ['merge', '--no-edit', targetRef], { cwd: sync.clonePath, signal })
    await runOrThrow('git', ['push'], { cwd: sync.clonePath, timeoutMs: 5 * 60 * 1000, signal })
  }

  async #cancelJob(jobId: string | undefined): Promise<string[]> {
    if (jobId === undefined) throw new Error('缺少 jobId')
    const requested = this.#store.state.jobs.find(job => job.id === jobId)
    if (requested === undefined) throw new Error(`找不到任务：${jobId}`)
    const related = this.#store.state.jobs.filter(job => (
      job.status === 'running'
      && (job.id === jobId || (requested.syncId !== undefined && job.syncId === requested.syncId))
      && this.#jobControllers.has(job.id)
    ))
    if (related.length === 0) throw new Error('任务已经结束或当前不可终止')
    const requestedAt = now()
    for (const job of related) {
      await this.#appendDshOutput(job, '系统：已请求终止任务')
      job.cancelRequestedAt = requestedAt
      this.#jobControllers.get(job.id)?.abort()
    }
    this.#store.event('warning', 'task', `已请求终止 ${related.length} 个关联任务：${requested.summary}`)
    await this.#store.changed()
    return related.map(job => job.id)
  }

  async #pauseDshJob(jobId: string | undefined): Promise<void> {
    const job = this.#activeDshJob(jobId)
    await this.#workerRegistry.cancel(job.dshWorker!.handle)
    job.nextAgentSteerAt = undefined
    await this.#appendDshOutput(job, '系统：已请求暂停任务')
    this.#store.event('warning', 'dsh-control', `已请求暂停：${job.summary}`)
    await this.#store.changed()
  }

  async #steerDshJob(jobId: string | undefined, prompt: string | undefined): Promise<void> {
    if (prompt === undefined || prompt.trim() === '') throw new Error('请输入要发送给 dsh 的内容')
    const job = this.#activeDshJob(jobId)
    const instruction = prompt.trim()
    await this.#workerRegistry.steer(job.dshWorker!.handle, job.type === 'review' ? renderReviewTurnPrompt(instruction) : instruction)
    if (job.type !== 'review') job.nextAgentSteerAt ??= after(AGENT_STEER_INTERVAL_MS)
    await this.#appendDshOutput(job, `用户指令：${instruction}`)
    this.#store.event('info', 'dsh-control', `已 steer：${job.summary}`)
    await this.#store.changed()
  }

  async #finishReviewConversation(jobId: string | undefined): Promise<void> {
    const job = this.#activeDshJob(jobId)
    if (job.type !== 'review') throw new Error('只有 Review 对话可以正常结束会话')
    const phase = this.#workerProgress.get(job.dshWorker.handle.runId)?.phase
    if (phase !== 'paused') throw new Error('请等待当前一轮回答完成后再结束对话')
    await this.#workerRegistry.complete(job.dshWorker.handle)
    job.nextAgentSteerAt = undefined
    await this.#appendDshOutput(job, '系统：已请求结束 Review 对话')
    this.#store.event('info', 'dsh-control', `已请求结束：${job.summary}`)
    await this.#store.changed()
  }

  #activeDshJob(jobId: string | undefined): JobRecord & { dshWorker: NonNullable<JobRecord['dshWorker']> } {
    if (jobId === undefined) throw new Error('缺少 jobId')
    const job = this.#store.state.jobs.find(candidate => candidate.id === jobId)
    if (job === undefined) throw new Error(`找不到任务：${jobId}`)
    if (job.status !== 'running' || job.dshWorker === undefined) throw new Error('任务已结束或不是可控制的 Worker 任务')
    if (job.cancelRequestedAt !== undefined) throw new Error('任务正在终止')
    return job as JobRecord & { dshWorker: NonNullable<JobRecord['dshWorker']> }
  }

  async #appendDshOutput(job: JobRecord, line: string): Promise<void> {
    const handle = job.dshWorker?.handle
    if (handle === undefined) return
    await appendFile(join(LOG_ROOT, `${handle.runId}.log`), `${line}\n`, 'utf8').catch(() => {})
    const previous = this.#workerProgress.get(handle.runId)
    this.#workerProgress.set(handle.runId, {
      runId: handle.runId,
      phase: previous?.phase ?? 'running',
      message: previous?.message ?? line,
      startedAt: previous?.startedAt ?? handle.startedAt,
      updatedAt: now(),
      outputTail: `${previous?.outputTail ?? ''}${line}\n`.slice(-48_000),
    })
    this.#broadcastProgress()
  }


  #applyPr(sync: SyncRecord, pr: PullRequestInfo): void {
    sync.prUrl = pr.url
    sync.branch = pr.headRefName
    sync.baseRefName = pr.baseRefName
    sync.baseOid = pr.baseRefOid
    sync.headOid = pr.headRefOid
    sync.updatedAt = now()
  }

  async #closeSync(sync: SyncRecord, message: string): Promise<void> {
    this.#store.state.syncs = this.#store.state.syncs.filter(candidate => candidate.id !== sync.id)
    this.#store.event('info', 'sync', message)
    await this.#store.changed()
  }

  async #updateHarness(): Promise<void> {
    this.#runningUpdate = true
    const job = this.#beginJob('update-harness', '更新托管的 deepseek-harness')
    const signal = this.#jobSignal(job)
    try {
      await assertManagedHarnessOwned()
      const before = await currentHead(HARNESS_ROOT)
      const status = await runOrThrow('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: HARNESS_ROOT, signal })
      let stashMessage = ''
      if (status.stdout !== '') {
        const stash = await runOrThrow(
          'git',
          ['stash', 'push', '--include-untracked', '--message', `dshw auto-update ${now()}`],
          { cwd: HARNESS_ROOT, signal },
        )
        stashMessage = `；${stash.stdout.trim()}`
      }
      await runOrThrow('git', ['pull', '--ff-only'], { cwd: HARNESS_ROOT, timeoutMs: 5 * 60 * 1000, signal })
      const current = await currentHead(HARNESS_ROOT)
      const summary = current === before ? `已是最新${stashMessage}` : `已更新 ${before.slice(0, 8)} → ${current.slice(0, 8)}${stashMessage}`
      this.#store.state.update.lastAt = now()
      this.#store.state.update.lastStatus = 'succeeded'
      this.#store.state.update.lastMessage = summary
      this.#recomputeNextUpdate()
      this.#finishJob(job, 'succeeded', summary)
      this.#store.event('info', 'update', summary)
      await this.#store.changed()
    } catch (error) {
      this.#store.state.update.lastAt = now()
      this.#store.state.update.lastStatus = 'failed'
      this.#store.state.update.lastMessage = messageOf(error)
      this.#recomputeNextUpdate()
      this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', messageOf(error))
      this.#store.event('error', 'update', messageOf(error))
      await this.#store.changed()
      throw error
    } finally {
      this.#runningUpdate = false
      await this.#refreshHarnessRepository()
      this.#broadcast()
    }
  }

  async #reconfigureHarness(): Promise<void> {
    this.#runningUpdate = true
    const job = this.#beginJob('reconfigure-harness', '从头配置托管的 deepseek-harness')
    const signal = this.#jobSignal(job)
    try {
      await assertManagedHarnessOwned()
      const branch = (await runOrThrow('git', ['branch', '--show-current'], { cwd: HARNESS_ROOT, signal })).stdout.trim()
      if (branch !== 'master') throw new Error(`托管主仓库当前分支是 ${JSON.stringify(branch)}，拒绝清理；预期 master`)
      const tracked = await runOrThrow(
        'git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: HARNESS_ROOT, signal },
      )
      if (tracked.stdout !== '') throw new Error('托管主仓库存在 tracked 或 staged 修改，拒绝 git clean；请先处理这些修改')
      const before = await currentHead(HARNESS_ROOT)
      for (const step of HARNESS_RECONFIGURE_STEPS) {
        await runOrThrow(step.command, [...step.args], {
          cwd: HARNESS_ROOT,
          signal,
          ...('timeoutMs' in step ? { timeoutMs: step.timeoutMs } : {}),
        })
      }
      const current = await currentHead(HARNESS_ROOT)
      const summary = `已清理并从头配置 master ${before.slice(0, 8)} → ${current.slice(0, 8)}`
      this.#store.state.update.lastAt = now()
      this.#store.state.update.lastStatus = 'succeeded'
      this.#store.state.update.lastMessage = summary
      this.#recomputeNextUpdate()
      this.#finishJob(job, 'succeeded', summary)
      this.#store.event('info', 'update', summary)
      await this.#store.changed()
    } catch (error) {
      const detail = messageOf(error)
      this.#store.state.update.lastAt = now()
      this.#store.state.update.lastStatus = 'failed'
      this.#store.state.update.lastMessage = detail
      this.#recomputeNextUpdate()
      this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', detail)
      this.#store.event('error', 'update', `从头配置失败：${detail}`)
      await this.#store.changed()
      throw error
    } finally {
      this.#runningUpdate = false
      await this.#refreshHarnessRepository()
      this.#broadcast()
    }
  }

  async #refreshHarnessRepository(fetchRemote = false): Promise<void> {
    this.#harnessRepository = await readHarnessRepositoryStatus(fetchRemote)
  }

  async #refreshDshwRepository(fetchRemote: boolean): Promise<void> {
    if (this.#dshwRepositoryRefreshPromise !== undefined) return await this.#dshwRepositoryRefreshPromise
    const promise = (async () => {
      this.#dshwRepository = await readDshwRepositoryStatus(fetchRemote)
      this.#broadcast()
    })()
    this.#dshwRepositoryRefreshPromise = promise
    try {
      await promise
    } finally {
      if (this.#dshwRepositoryRefreshPromise === promise) this.#dshwRepositoryRefreshPromise = undefined
    }
  }

  async #updateDshw(): Promise<void> {
    this.#updatingDshw = true
    const job = this.#beginJob('update-dshw', '更新 dshw 并重启服务')
    const signal = this.#jobSignal(job)
    this.#broadcast()
    try {
      if (this.#dshwRepositoryRefreshPromise !== undefined) await this.#dshwRepositoryRefreshPromise
      const branch = (await runOrThrow('git', ['branch', '--show-current'], { cwd: DSHW_ROOT, signal })).stdout.trim()
      if (branch === '') throw new Error('dshw 仓库处于 detached HEAD，无法一键更新')
      await runOrThrow('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: DSHW_ROOT, signal })
      const status = await runOrThrow('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: DSHW_ROOT, signal })
      if (status.stdout !== '') throw new Error('dshw 仓库存在本地修改，拒绝自动更新；请先提交、stash 或清理这些修改')
      const before = await currentHead(DSHW_ROOT)
      for (const step of DSHW_UPDATE_STEPS) {
        await runOrThrow(step.command, [...step.args], { cwd: DSHW_ROOT, signal, timeoutMs: step.timeoutMs })
      }
      const current = await currentHead(DSHW_ROOT)
      const summary = current === before
        ? `dshw 已是最新，已重新构建并准备重启服务`
        : `dshw 已更新 ${before.slice(0, 8)} → ${current.slice(0, 8)}，准备重启服务`
      this.#finishJob(job, 'succeeded', summary)
      this.#store.event('info', 'update', summary)
      await this.#store.changed()
    } catch (error) {
      const detail = messageOf(error)
      this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', detail)
      this.#store.event('error', 'update', `dshw 更新失败：${detail}`)
      await this.#store.changed()
      throw error
    } finally {
      this.#updatingDshw = false
      await this.#refreshDshwRepository(false)
    }
  }

  async #ensureHarnessUpdated(): Promise<void> {
    if (this.#updatePromise !== undefined) return await this.#updatePromise
    const promise = this.#updateHarness()
    this.#updatePromise = promise
    try {
      await promise
    } finally {
      if (this.#updatePromise === promise) this.#updatePromise = undefined
    }
  }

  #recomputeNextUpdate(): void {
    const pending = this.#store.state.syncs
      .map(sync => sync.pendingBaseCheckAt)
      .filter((value): value is string => value !== undefined)
      .sort()[0]
    this.#store.state.update.nextAt = pending
  }

  #beginJob(type: JobRecord['type'], summary: string, syncId?: string): JobRecord {
    const job = this.#store.job(type, summary, syncId)
    job.status = 'running'
    job.startedAt = now()
    this.#jobControllers.set(job.id, new AbortController())
    this.#broadcast()
    return job
  }

  #jobSignal(job: JobRecord): AbortSignal {
    const controller = this.#jobControllers.get(job.id)
    if (controller === undefined) throw new Error(`任务 ${job.id} 缺少取消控制器`)
    return controller.signal
  }

  #finishJob(job: JobRecord, status: 'succeeded' | 'blocked' | 'failed' | 'cancelled', summary: string): void {
    job.status = status
    job.finishedAt = now()
    job.nextAgentSteerAt = undefined
    job.summary = summary
    this.#jobControllers.delete(job.id)
  }

  async #drainAndExit(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    this.#feishu.stop()
    this.#store.event('info', 'service', '开始重启：独立 dsh worker 将继续运行，仅等待短任务安全结束')
    await this.#store.changed()
    if (this.#timer !== undefined) clearInterval(this.#timer)
    while (this.#runningUpdate || this.#updatingDshw || [...this.#syncLocks].some(syncId => !this.#externalDshSyncs.has(syncId))) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    for (const response of this.#sse) response.end()
    this.#sse.clear()
    await new Promise<void>(resolve => this.#server?.close(() => resolve()))
    process.exit(0)
  }

  #broadcast(): void {
    void this.#snapshot().then(snapshot => {
      const event = `data: ${JSON.stringify(snapshot)}\n\n`
      for (const response of this.#sse) response.write(event)
    })
  }

  #acceptWorkerProgress(body: Record<string, unknown>): void {
    const runId = bodyString(body, 'runId')
    const phase = bodyString(body, 'phase')
    const message = bodyString(body, 'message')
    const startedAt = bodyString(body, 'startedAt')
    const line = bodyString(body, 'line')
    if (runId === undefined || message === undefined || startedAt === undefined) {
      throw new Error('worker progress 缺少 runId、message 或 startedAt')
    }
    if (phase !== 'starting' && phase !== 'running' && phase !== 'cancelling' && phase !== 'paused' && phase !== 'finishing') {
      throw new Error(`worker progress phase 无效：${String(phase)}`)
    }
    const previous = this.#workerProgress.get(runId)
    const outputTail = line === undefined
      ? previous?.outputTail ?? ''
      : `${previous?.outputTail ?? ''}${line}\n`.slice(-48_000)
    this.#workerProgress.set(runId, { runId, phase, message, startedAt, updatedAt: now(), outputTail })
    this.#broadcastProgress()
  }

  #readJobProgress(): Record<string, DshWorkerProgress> {
    const entries = this.#store.state.jobs.flatMap(job => {
      const runId = job.dshWorker?.handle.runId
      const progress = runId === undefined ? undefined : this.#workerProgress.get(runId)
      return progress === undefined ? [] : [[job.id, progress] as const]
    })
    return Object.fromEntries(entries)
  }

  #broadcastProgress(): void {
    const progress = this.#readJobProgress()
    const fingerprint = JSON.stringify(progress)
    if (fingerprint === this.#progressFingerprint) return
    this.#progressFingerprint = fingerprint
    const event = `event: progress\ndata: ${fingerprint}\n\n`
    for (const response of this.#sse) response.write(event)
  }

  #json(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(`${JSON.stringify(value)}\n`)
  }
}

async function readBody(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('请求 body 必须是对象')
  return value as Record<string, unknown>
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

/** Parse `/api/reviews/<owner>/<name>/<number>/<diff|viewed>` into its review identity. */
function parseReviewPath(pathname: string): { repoSlug: string; prNumber: number; action: 'diff' | 'viewed' | 'content' } | undefined {
  const prefix = '/api/reviews/'
  if (!pathname.startsWith(prefix)) return undefined
  const parts = pathname.slice(prefix.length).split('/')
  if (parts.length !== 4) return undefined
  const repoSlug = `${parts[0]}/${parts[1]}`
  const prNumber = Number(parts[2])
  const action = parts[3]
  if (parts[0] === '' || parts[1] === '' || !Number.isSafeInteger(prNumber) || prNumber <= 0) return undefined
  if (action !== 'diff' && action !== 'viewed' && action !== 'content') return undefined
  return { repoSlug, prNumber, action }
}

async function findClone(name: string | undefined): Promise<CloneRecord> {
  if (name === undefined) throw new Error('内部请求缺少 clone name')
  const clone = (await listClones()).find(candidate => candidate.name === name)
  if (clone === undefined) throw new Error(`找不到 clone：${name}`)
  return clone
}
