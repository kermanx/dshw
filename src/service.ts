import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BASE_DEBOUNCE_MS,
  BASE_DEBOUNCE_MAX_MS,
  CI_WATCH_INTERVAL_MS,
  CLONES_ROOT,
  DEV_MODE,
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
import { createPrClone, listClones } from './clone.ts'
import { cancelDshWorker, inspectDshWorker, startDshWorker, steerDshWorker, waitForDshWorker } from './dsh.ts'
import { cloneGitStatus, commitOid, currentHead, fetchBranch, fetchRemoteBranchTip, gitCommonDir, isAncestor, isDocumentationConflictPath, mergeConflictPaths, originUrl, remoteBranchOid, repoSlugFromRemote } from './git.ts'
import { ciChecks, myOpenPullRequests, openPullRequests, pullRequest, reviewerCommentProgress, reviewRequestedPullRequests, rollupChecks, summarizeChecks } from './github.ts'
import { StateStore } from './state.ts'
import type { CloneRecord, DshWorkerProgress, JobRecord, PrDashboardRecord, PrDashboardStatus, PullRequestInfo, ReviewRequestRecord, SyncRecord } from './types.ts'
import { after, id, isTaskCancelled, messageOf, now, run, runOrThrow, TaskCancelledError } from './util.ts'
import { refreshCodeWorkspace } from './workspace.ts'
import { serveUiAsset } from './ui-static.ts'
import { assertManagedHarnessOwned, ensureInstallation, ensureManagedHarness, requireDaemonInstallation, type InstallationRecord } from './install.ts'

const NO_CHECKS_GRACE_MS = 5 * 60 * 1000
const HISTORY_PAGE_SIZE = 35

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

export const HARNESS_RECONFIGURE_STEPS = [
  { command: 'git', args: ['clean', '-fdx'] },
  { command: 'git', args: ['pull', '--ff-only', 'origin', 'master'], timeoutMs: 5 * 60 * 1000 },
  { command: 'git', args: ['clean', '-fdx'] },
  { command: 'pnpm', args: ['install', '--frozen-lockfile'], timeoutMs: 10 * 60 * 1000 },
  { command: process.execPath, args: ['scripts/install-lefthook.mjs'] },
  { command: 'pnpm', args: ['run', 'typecheck'], timeoutMs: 10 * 60 * 1000 },
] as const

function clearPendingBaseCheck(sync: SyncRecord): void {
  sync.pendingBaseCheckStartedAt = undefined
  sync.pendingBaseCheckAt = undefined
}

export async function runService(): Promise<void> {
  const installation = DEV_MODE ? await ensureInstallation() : await requireDaemonInstallation()
  if (DEV_MODE) await ensureManagedHarness(installation)
  await mkdir(CLONES_ROOT, { recursive: true })
  const store = await StateStore.open()
  store.state.serviceStartedAt = now()
  store.event('info', 'service', `后台服务已启动，监听 http://${HOST}:${PORT}`)
  await store.changed()
  const service = new WorkflowService(store, installation)
  await service.start()
}

class WorkflowService {
  readonly #store: StateStore
  readonly #installation: InstallationRecord
  readonly #syncLocks = new Set<string>()
  readonly #externalDshSyncs = new Set<string>()
  readonly #jobControllers = new Map<string, AbortController>()
  readonly #sse = new Set<ServerResponse>()
  readonly #workerProgress = new Map<string, DshWorkerProgress>()
  readonly #conflictPathsCache = new Map<string, Promise<string[]>>()
  #server: Server | undefined
  #timer: NodeJS.Timeout | undefined
  #progressFingerprint = ''
  #runningUpdate = false
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
  #rateLimited = false
  #rateLimitResetAt: string | undefined
  #lastDiscoveryAt = 0
  #discoveryPromise: Promise<void> | undefined

  constructor(store: StateStore, installation: InstallationRecord) {
    this.#store = store
    this.#installation = installation
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
    store.onChange(() => this.#broadcast())
  }

  async start(): Promise<void> {
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
    await this.#tick()
  }

  async #route(
    method: string,
    url: string,
    request: NodeJS.ReadableStream,
    response: ServerResponse,
  ): Promise<void> {
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
    if (DEV_MODE && method === 'POST') {
      this.#json(response, 403, { error: 'dev kernel 是只读的；生产操作请使用正式服务' })
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
      this.#json(response, 200, { output: await this.#jobOutput(requestUrl.searchParams.get('jobId') ?? undefined) })
      return
    }
    if (method === 'GET' && new URL(url, `http://${HOST}:${PORT}`).pathname === '/api/jobs') {
      const requestUrl = new URL(url, `http://${HOST}:${PORT}`)
      this.#json(response, 200, this.#store.jobs(requestUrl.searchParams.get('before') ?? undefined, HISTORY_PAGE_SIZE))
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
    if (method === 'POST' && url === '/api/prs/refresh') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      this.#lastReviewProgressRefreshAt = 0
      await this.#discoverMyPrs()
      await this.#refreshPrDashboard()
      this.#json(response, 202, { accepted: true, prs: this.#prDashboard.length })
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
    if (method === 'POST' && url === '/api/pr-action') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      const body = await readBody(request)
      const name = bodyString(body, 'name')
      const action = bodyString(body, 'action')
      if (action !== 'merge-base' && action !== 'fix-ci' && action !== 'merge-base-direct' && action !== 'resolve-comments') throw new Error('未知 PR 操作')
      const clone = await findClone(name)
      const sync = await this.#manualSync(clone)
      if (action === 'merge-base-direct') this.#startDirectMergeBase(sync)
      else this.#startManualAction(sync, action)
      this.#json(response, 202, { accepted: true, syncId: sync.id })
      return
    }
    if (method === 'POST' && url === '/api/restart') {
      this.#json(response, 202, { draining: true })
      setImmediate(() => void this.#drainAndExit())
      return
    }
    if (method === 'POST' && url === '/api/update') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      // 失败状态已在 #updateHarness 内记录并广播，这里只需避免 unhandled rejection
      void this.#ensureHarnessUpdated().catch(() => {})
      this.#json(response, 202, { accepted: true })
      return
    }
    if (method === 'POST' && url === '/api/reconfigure') {
      if (this.#draining) throw new Error('服务正在排空并准备重启，请稍后重试')
      if (this.#updatePromise !== undefined) throw new Error('主仓库维护任务正在运行，请等待完成')
      const promise = this.#reconfigureHarness()
      this.#updatePromise = promise
      void promise.catch(() => {}).finally(() => {
        if (this.#updatePromise === promise) this.#updatePromise = undefined
      })
      this.#json(response, 202, { accepted: true })
      return
    }
    if (method === 'GET' && !url.startsWith('/api/')) {
      await serveUiAsset(url, response)
      return
    }
    this.#json(response, 404, { error: 'not found' })
  }

  async #snapshot(): Promise<object> {
    const { prDashboardCache: _prDashboardCache, reviewRequestsCache: _reviewRequestsCache, jobs, ...state } = this.#store.state
    const recentJobs = jobs.filter((job, index) => job.status === 'running' || index >= jobs.length - HISTORY_PAGE_SIZE)
    return {
      service: {
        startedAt: this.#store.state.serviceStartedAt,
        installationId: this.#installation.id,
        draining: this.#draining,
        activeJobs: this.#syncLocks.size + (this.#runningUpdate ? 1 : 0),
        port: PORT,
        devMode: DEV_MODE,
        rateLimited: this.#rateLimited,
        ...(this.#rateLimitResetAt === undefined ? {} : { rateLimitResetAt: this.#rateLimitResetAt }),
      },
      clones: await listClones(),
      prs: this.#prDashboard,
      prDashboard: this.#prDashboardStatus,
      reviewRequests: this.#reviewRequests,
      reviewRequestsStatus: this.#reviewRequestsStatus,
      jobProgress: this.#readJobProgress(),
      ...state,
      jobs: recentJobs,
    }
  }

  async #jobOutput(jobId: string | undefined): Promise<string> {
    if (jobId === undefined) throw new Error('缺少 jobId')
    const job = this.#store.state.jobs.find(candidate => candidate.id === jobId)
    if (job === undefined) throw new Error(`找不到任务：${jobId}`)
    const runId = job.dshWorker?.handle.runId
    if (runId === undefined) return job.output ?? ''
    if (!/^dsh-[a-z0-9-]+$/u.test(runId)) throw new Error('任务包含无效的 runId')
    try {
      const output = await readFile(join(LOG_ROOT, `${runId}.log`), 'utf8')
      return output.trimEnd() || job.output || ''
    } catch {
      return job.output ?? ''
    }
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

  /** 自动发现我在托管仓库上的所有 open PR：克隆并纳入追踪（sync 默认关闭），并清理已关闭 PR 的 sync。 */
  async #discoverMyPrs(): Promise<void> {
    if (this.#discoveryPromise !== undefined) return await this.#discoveryPromise
    this.#lastDiscoveryAt = Date.now()
    this.#discoveryPromise = (async () => {
      try {
        const repoSlug = repoSlugFromRemote(await originUrl(HARNESS_ROOT))
        const reviewRefresh = this.#refreshReviewRequests(repoSlug)
        const prs = await myOpenPullRequests(HARNESS_ROOT, repoSlug)
        await reviewRefresh
        const clones = await listClones()
        let tracked = 0
        let cloned = 0
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
            remoteUrl: clone.remoteUrl,
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
          this.#store.event('info', 'track', `发现我的 PR #${pr.number}「${pr.title}」，已克隆并纳入追踪（sync 默认关闭，可在 UI 打开）`)
          tracked += 1
        }
        const openNumbers = new Set(prs.map(pr => pr.number))
        const stale = this.#store.state.syncs.filter(sync => (
          sync.repoSlug === repoSlug && !openNumbers.has(sync.prNumber) && !this.#syncLocks.has(sync.id)
        ))
        if (stale.length > 0) {
          const staleIds = new Set(stale.map(sync => sync.id))
          this.#store.state.syncs = this.#store.state.syncs.filter(sync => !staleIds.has(sync.id))
          for (const sync of stale) this.#store.event('info', 'sync', `PR #${sync.prNumber} 已不再 open，停止追踪`)
        }
        if (tracked > 0 || stale.length > 0) await this.#store.changed()
        if (cloned > 0) {
          this.#lastWorkspaceRefreshAt = 0
          void this.#refreshWorkspace()
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

  async #refreshReviewRequests(repoSlug: string): Promise<void> {
    const attemptAt = now()
    this.#reviewRequestsStatus = {
      ...this.#reviewRequestsStatus,
      refreshing: true,
      lastAttemptAt: attemptAt,
    }
    this.#broadcast()
    try {
      const records = await reviewRequestedPullRequests(HARNESS_ROOT, repoSlug)
      const completedAt = now()
      this.#reviewRequests = records
      this.#reviewRequestsStatus = {
        state: 'ready',
        refreshing: false,
        stale: false,
        lastAttemptAt: attemptAt,
        lastSuccessAt: completedAt,
      }
      this.#store.state.reviewRequestsCache = { records, lastSuccessAt: completedAt }
    } catch (error) {
      this.#noteGhFailure(error)
      const detail = messageOf(error)
      this.#reviewRequestsStatus = {
        state: 'error',
        refreshing: false,
        stale: this.#reviewRequests.length > 0,
        lastAttemptAt: attemptAt,
        ...(this.#reviewRequestsStatus.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.#reviewRequestsStatus.lastSuccessAt }),
        error: detail,
      }
      this.#store.event('warning', 'reviews', `待 review PR 刷新失败，保留旧数据：${detail}`)
    }
    await this.#store.changed()
  }

  async #tick(): Promise<void> {
    if (this.#draining) return
    const currentTime = Date.now()
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
      // 一次 list 查询拿到所有 open PR，避免每个 clone 一次 gh pr view 烧 GraphQL 额度
      const clones = await listClones()
      const repoSlug = clones[0]?.repoSlug ?? 'deepseek-harness/deepseek-harness'
      const openPrs = await openPullRequests(HARNESS_ROOT, repoSlug)
      const byBranch = new Map(openPrs.map(pr => [pr.headRefName, pr]))
      const previousByClone = new Map(this.#prDashboard.map(record => [record.cloneName, record]))
      const refreshErrors: string[] = []
      const clonedBranches = new Set(clones.map(clone => `${clone.repoSlug}\n${clone.branch}`))
      const pendingClones = openPrs.filter(pr => !clonedBranches.has(`${repoSlug}\n${pr.headRefName}`))
      if (pendingClones.length > 0) refreshErrors.push(`${pendingClones.length} 个 open PR 的本地 clone 尚未准备完成`)
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
        // while the clone is actually a worktree of HARNESS_ROOT. Ask Git for the
        // true object database so shared worktrees never fetch the same ref at once.
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
      const records = await Promise.all(clones.map(async clone => {
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
              refreshErrors.push(detail)
              this.#noteGhFailure(error)
              this.#store.event('warning', 'conflict-paths', detail)
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
            mergeable: pr.mergeable,
            mergeStateStatus: pr.mergeStateStatus,
            ...(conflictPaths === undefined ? {} : { conflictPaths }),
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
          refreshErrors.push(detail)
          this.#noteGhFailure(error)
          this.#store.event('warning', 'pr-dashboard', detail)
          return previousByClone.get(clone.name)
        }
      }))
      const matched = records.filter((record): record is PrDashboardRecord => record !== undefined)
      this.#prDashboard = matched
        .sort((left, right) => Number(left.isDraft) - Number(right.isDraft) || left.number - right.number || left.cloneName.localeCompare(right.cloneName))
      // Do not hold the first visible PR rows behind the more expensive review-thread query.
      this.#broadcast()
      if (Date.now() - this.#lastReviewProgressRefreshAt >= PR_REVIEW_INTERVAL_MS) {
        this.#lastReviewProgressRefreshAt = Date.now()
        try {
          const progress = await reviewerCommentProgress(HARNESS_ROOT, repoSlug, matched.map(record => record.number))
          for (const record of matched) {
            record.reviewerComments = progress.get(record.number) ?? {}
            const unresolved = Object.values(record.reviewerComments)
              .reduce((count, reviewer) => count + reviewer.total - reviewer.resolved, 0)
            delete record.unresolvedComments
            if (unresolved > 0) record.unresolvedComments = unresolved
          }
        } catch (error) {
          const detail = `review 评论计数失败：${messageOf(error)}`
          refreshErrors.push(detail)
          this.#noteGhFailure(error)
          this.#store.event('warning', 'pr-dashboard', detail)
        }
      }
      const completedAt = now()
      const complete = refreshErrors.length === 0 && (openPrs.length === 0 || matched.length > 0)
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
      }
      this.#store.state.prDashboardCache = {
        records: this.#prDashboard,
        ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
      }
      if (complete) this.#clearRateLimited()
      await this.#store.changed()
      await this.#refreshWorkspace()
    })().catch(async (error: unknown) => {
      // 整体失败（如 GraphQL 限流）时保留旧 dashboard，不要清空列表
      this.#noteGhFailure(error)
      const detail = summarizePrDashboardErrors([messageOf(error)])
      this.#prDashboardStatus = {
        state: 'error',
        refreshing: false,
        stale: this.#prDashboard.length > 0,
        lastAttemptAt: attemptAt,
        ...(this.#prDashboardStatus.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.#prDashboardStatus.lastSuccessAt }),
        error: detail,
      }
      this.#store.event('warning', 'pr-dashboard', `PR 列表刷新失败，保留旧数据：${messageOf(error)}`)
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
        await fetchBranch(sync.clonePath, sync.baseRefName, signal)
        const conflictPaths = await mergeConflictPaths(sync.clonePath, 'HEAD', `origin/${sync.baseRefName}`, signal)
        if (conflictPaths.length > 0 && conflictPaths.every(isDocumentationConflictPath)) {
          mergeSummary += '（仅文档冲突，跳过自动合并）'
          this.#store.event(
            'info',
            'mergeability',
            `PR #${sync.prNumber} 仅有文档冲突，跳过自动合并：${conflictPaths.join('、')}`,
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
      await this.#runAgent(sync, 'fix-ci')
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
      if (sync.lastFixedHeadOid !== sync.headOid) await this.#runAgent(sync, 'fix-ci')
    } else {
      sync.nextCiCheckAt = undefined
      sync.ciMonitorHeadOid = undefined
      sync.noChecksSince = undefined
      this.#store.event('info', 'ci', `PR #${sync.prNumber}: ${summary.summary}`)
    }
    sync.updatedAt = now()
    await this.#store.changed()
  }

  async #runAgent(sync: SyncRecord, kind: 'merge-base' | 'fix-ci' | 'resolve-comments'): Promise<void> {
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
    const label = kind === 'merge-base' ? `合并 ${sync.baseRefName}` : kind === 'fix-ci' ? '修复 CI' : '解决 review 评论'
    const job = this.#beginJob(type, `${sync.cloneName} / PR #${sync.prNumber}: ${label}`, sync.id)
    const oldHead = sync.headOid
    try {
      if (kind === 'fix-ci') sync.lastFixedHeadOid = oldHead
      const handle = await startDshWorker(sync, kind)
      job.dshWorker = { handle, kind, sync: structuredClone(sync), oldHead, label }
      await this.#store.changed()
      await this.#completeDshJob(job, sync)
    } catch (error) {
      if (job.dshWorker === undefined) {
        this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', messageOf(error))
        await this.#store.changed()
      }
      throw error
    }
  }

  async #completeDshJob(job: JobRecord, sync: SyncRecord): Promise<void> {
    const worker = job.dshWorker
    if (worker === undefined) throw new Error(`任务 ${job.id} 缺少 dsh worker 状态`)
    const signal = this.#jobSignal(job)
    this.#externalDshSyncs.add(sync.id)
    try {
      const record = await waitForDshWorker(worker.handle, signal)
      if (!this.#store.state.dshRuns.some(candidate => candidate.id === record.id)) {
        this.#store.state.dshRuns.push(record)
      }
      job.output = record.finalOutput
      if (record.status === 'cancelled') throw new TaskCancelledError()
      if (record.status === 'failed') throw new Error(`dsh 调用失败：${record.finalOutput}`)
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
      void inspectDshWorker(worker.handle).then(progress => {
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
    const timestamp = now()
    return {
      id: `manual:${clone.path}`,
      cloneName: clone.name,
      clonePath: clone.path,
      remoteUrl: clone.remoteUrl,
      repoSlug: clone.repoSlug,
      prNumber: pr.number,
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

  #startManualAction(sync: SyncRecord, action: 'merge-base' | 'fix-ci' | 'resolve-comments'): void {
    if (this.#syncLocks.has(sync.id)) throw new Error(`${sync.cloneName} 已有任务执行中`)
    const label = action === 'merge-base' ? `手动合并最新 ${sync.baseRefName}` : action === 'fix-ci' ? '手动修复 CI' : '手动解决 review 评论'
    if (sync.agentPausedReason !== undefined) {
      this.#store.event('info', 'dsh-resumed', `${sync.cloneName} / PR #${sync.prNumber}: 手动操作恢复 dsh 任务`)
      sync.agentPausedAt = undefined
      sync.agentPausedReason = undefined
    }
    this.#store.event('info', 'manual', `${sync.cloneName} / PR #${sync.prNumber}: ${label}`)
    void this.#store.changed()
    void this.#withSyncLock(sync, async () => {
      await this.#runAgent(sync, action)
    })
  }

  /** 无冲突时的快速路径：直接 git merge + push，不启动 dsh agent。 */
  #startDirectMergeBase(sync: SyncRecord): void {
    if (this.#syncLocks.has(sync.id)) throw new Error(`${sync.cloneName} 已有任务执行中`)
    this.#store.event('info', 'manual', `${sync.cloneName} / PR #${sync.prNumber}: 直接合并最新 ${sync.baseRefName}（无冲突，不经模型）`)
    void this.#store.changed()
    const job = this.#beginJob('merge-base', `${sync.cloneName} / PR #${sync.prNumber}: 直接合并 ${sync.baseRefName}`, sync.id)
    const signal = this.#jobSignal(job)
    void this.#withSyncLock(sync, async () => {
      try {
        await fetchBranch(sync.clonePath, sync.baseRefName, signal)
        await runOrThrow('git', ['merge', '--no-edit', `origin/${sync.baseRefName}`], { cwd: sync.clonePath, signal })
        await runOrThrow('git', ['push'], { cwd: sync.clonePath, timeoutMs: 5 * 60 * 1000, signal })
        this.#finishJob(job, 'succeeded', `已合并 origin/${sync.baseRefName} 并 push`)
        this.#store.event('info', 'merge-base', `${sync.cloneName} / PR #${sync.prNumber}: 已合并 origin/${sync.baseRefName} 并 push`)
        await this.#store.changed()
      } catch (error) {
        this.#finishJob(job, isTaskCancelled(error) ? 'cancelled' : 'failed', messageOf(error))
        this.#store.event('error', 'merge-base', `${sync.cloneName} / PR #${sync.prNumber}: ${messageOf(error)}`)
        await this.#store.changed()
      }
    }).finally(() => {
      void this.#refreshPrDashboardAfterAction()
    })
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
      job.cancelRequestedAt = requestedAt
      this.#jobControllers.get(job.id)?.abort()
    }
    this.#store.event('warning', 'task', `已请求终止 ${related.length} 个关联任务：${requested.summary}`)
    await this.#store.changed()
    return related.map(job => job.id)
  }

  async #pauseDshJob(jobId: string | undefined): Promise<void> {
    const job = this.#activeDshJob(jobId)
    await cancelDshWorker(job.dshWorker!.handle)
    this.#store.event('warning', 'dsh-control', `已请求暂停：${job.summary}`)
    await this.#store.changed()
  }

  async #steerDshJob(jobId: string | undefined, prompt: string | undefined): Promise<void> {
    if (prompt === undefined || prompt.trim() === '') throw new Error('请输入要发送给 dsh 的内容')
    const job = this.#activeDshJob(jobId)
    await steerDshWorker(job.dshWorker!.handle, prompt.trim())
    this.#store.event('info', 'dsh-control', `已 steer：${job.summary}`)
    await this.#store.changed()
  }

  #activeDshJob(jobId: string | undefined): JobRecord & { dshWorker: NonNullable<JobRecord['dshWorker']> } {
    if (jobId === undefined) throw new Error('缺少 jobId')
    const job = this.#store.state.jobs.find(candidate => candidate.id === jobId)
    if (job === undefined) throw new Error(`找不到任务：${jobId}`)
    if (job.status !== 'running' || job.dshWorker === undefined) throw new Error('任务已结束或不是可控制的 dsh 任务')
    if (job.cancelRequestedAt !== undefined) throw new Error('任务正在终止')
    return job as JobRecord & { dshWorker: NonNullable<JobRecord['dshWorker']> }
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
    job.summary = summary
    this.#jobControllers.delete(job.id)
  }

  async #drainAndExit(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    this.#store.event('info', 'service', '开始重启：独立 dsh worker 将继续运行，仅等待短任务安全结束')
    await this.#store.changed()
    if (this.#timer !== undefined) clearInterval(this.#timer)
    while (this.#runningUpdate || [...this.#syncLocks].some(syncId => !this.#externalDshSyncs.has(syncId))) {
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

async function findClone(name: string | undefined): Promise<CloneRecord> {
  if (name === undefined) throw new Error('内部请求缺少 clone name')
  const clone = (await listClones()).find(candidate => candidate.name === name)
  if (clone === undefined) throw new Error(`找不到 clone：${name}`)
  return clone
}
