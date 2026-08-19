import type { CiCheck, CiStatus, MyPullRequestSummary, PullRequestCheck, PullRequestInfo, ReviewerCommentProgress, ReviewRequestRecord } from './types.ts'
import { run, runOrThrow } from './util.ts'

const PR_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'author', 'mergeable', 'mergeStateStatus',
  'baseRefName', 'baseRefOid', 'headRefName', 'headRefOid',
  'reviewDecision', 'reviewRequests', 'latestReviews', 'statusCheckRollup',
].join(',')

async function listOpenPullRequests(
  cwd: string,
  repoSlug: string,
  flags: readonly string[],
  fields: string,
  signal?: AbortSignal,
): Promise<PullRequestInfo[]> {
  const result = await runOrThrow(
    'gh',
    ['pr', 'list', '--repo', repoSlug, ...flags, '--state', 'open', '--limit', '100', '--json', fields],
    { cwd, timeoutMs: 30_000, signal },
  )
  const parsed = JSON.parse(result.stdout) as PullRequestInfo[]
  for (const pr of parsed) {
    pr.latestReviews ??= []
    pr.reviewRequests ??= []
    pr.statusCheckRollup ??= []
    pr.reviewDecision ??= ''
  }
  return parsed
}

export async function pullRequest(
  cwd: string,
  repoSlug?: string,
  number?: number,
  branch?: string,
  signal?: AbortSignal,
): Promise<PullRequestInfo> {
  const args = ['pr', 'view']
  if (number !== undefined) args.push(String(number))
  else if (branch !== undefined) args.push(branch)
  args.push('--json', PR_FIELDS)
  if (repoSlug !== undefined) args.push('--repo', repoSlug)
  const result = await runOrThrow('gh', args, { cwd, timeoutMs: 30_000, signal })
  const parsed = JSON.parse(result.stdout) as PullRequestInfo
  parsed.latestReviews ??= []
  parsed.reviewRequests ??= []
  parsed.statusCheckRollup ??= []
  parsed.reviewDecision ??= ''
  return parsed
}

export async function openPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<PullRequestInfo[]> {
  // 只查自己的 open PR：全仓库带 statusCheckRollup/mergeable 的重字段查询会让 GraphQL 504
  return listOpenPullRequests(cwd, repoSlug, ['--author', '@me'], PR_FIELDS, signal)
}

export async function assignedOpenPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<PullRequestInfo[]> {
  return listOpenPullRequests(cwd, repoSlug, ['--assignee', '@me'], PR_FIELDS, signal)
}

export interface DashboardOpenPullRequests {
  /** 我创建的 open PR ∪ assign 给我的 open PR（按 number 去重）。 */
  prs: PullRequestInfo[]
  /** 只看板里 assign 给我、但不是由我创建的 PR number。 */
  assignedOnlyNumbers: ReadonlySet<number>
}

/** 看板展示范围：我创建的 open PR ∪ assign 给我的 open PR。 */
export async function dashboardOpenPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<DashboardOpenPullRequests> {
  const [authored, assigned] = await Promise.all([
    openPullRequests(cwd, repoSlug, signal),
    assignedOpenPullRequests(cwd, repoSlug, signal),
  ])
  const authoredNumbers = new Set(authored.map(pr => pr.number))
  const seen = new Set<number>()
  const prs: PullRequestInfo[] = []
  for (const pr of [...authored, ...assigned]) {
    if (seen.has(pr.number)) continue
    seen.add(pr.number)
    prs.push(pr)
  }
  return {
    prs,
    assignedOnlyNumbers: new Set(assigned.filter(pr => !authoredNumbers.has(pr.number)).map(pr => pr.number)),
  }
}

const MY_PR_SUMMARY_FIELDS = 'number,title,url,isDraft,author,baseRefName,baseRefOid,headRefName,headRefOid'

async function listMyOpenPullRequests(
  cwd: string,
  repoSlug: string,
  flags: readonly string[],
  signal?: AbortSignal,
): Promise<MyPullRequestSummary[]> {
  const result = await runOrThrow(
    'gh',
    ['pr', 'list', '--repo', repoSlug, ...flags, '--state', 'open', '--limit', '100', '--json', MY_PR_SUMMARY_FIELDS],
    { cwd, timeoutMs: 30_000, signal },
  )
  return JSON.parse(result.stdout) as MyPullRequestSummary[]
}

export async function myOpenPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<MyPullRequestSummary[]> {
  return listMyOpenPullRequests(cwd, repoSlug, ['--author', '@me'], signal)
}

export async function assignedMyOpenPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<MyPullRequestSummary[]> {
  return listMyOpenPullRequests(cwd, repoSlug, ['--assignee', '@me'], signal)
}

/** 自动追踪范围：我创建的 open PR ∪ assign 给我的 open PR（按 number 去重）。 */
export async function trackedOpenPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<MyPullRequestSummary[]> {
  const [authored, assigned] = await Promise.all([
    myOpenPullRequests(cwd, repoSlug, signal),
    assignedMyOpenPullRequests(cwd, repoSlug, signal),
  ])
  const seen = new Set<number>()
  const combined: MyPullRequestSummary[] = []
  for (const pr of [...authored, ...assigned]) {
    if (seen.has(pr.number)) continue
    seen.add(pr.number)
    combined.push(pr)
  }
  return combined
}

export async function reviewRequestedPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<ReviewRequestRecord[]> {
  const result = await runOrThrow(
    'gh',
    [
      'pr', 'list', '--repo', repoSlug, '--search', 'review-requested:@me', '--state', 'open', '--limit', '100',
      '--json', 'number,title,url,isDraft,author,headRefName,baseRefName,updatedAt',
    ],
    { cwd, timeoutMs: 30_000, signal },
  )
  const parsed = JSON.parse(result.stdout) as Array<Omit<ReviewRequestRecord, 'repoSlug' | 'author'> & { author?: { login?: string } }>
  return parsed.map(pr => ({ ...pr, repoSlug, author: pr.author?.login ?? 'unknown' }))
}

/** 列出当前用户有权限（owner / collaborator / organization member）的所有 GitHub 仓库。 */
export async function listUserRepos(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const result = await runOrThrow(
    'gh',
    [
      'api', '--paginate',
      'user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=full_name',
      '--jq', '.[].full_name',
    ],
    { cwd, timeoutMs: 60_000, signal },
  )
  return [...new Set(result.stdout.split('\n').map(line => line.trim()).filter(Boolean))]
}

/** 一次 GraphQL 调用批量取多个 PR 的 review thread，并按发起 thread 的 reviewer 汇总解决进度。 */
export async function reviewerCommentProgress(
  cwd: string,
  repoSlug: string,
  numbers: readonly number[],
  signal?: AbortSignal,
): Promise<Map<number, Record<string, ReviewerCommentProgress>>> {
  const progress = new Map<number, Record<string, ReviewerCommentProgress>>()
  if (numbers.length === 0) return progress
  const [owner, name] = repoSlug.split('/')
  const selections = numbers.map((number, index) => (
    `pr${index}: pullRequest(number: ${number}) { reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } } }`
  )).join(' ')
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${selections} } }`
  const result = await runOrThrow('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd, timeoutMs: 30_000, signal })
  const data = JSON.parse(result.stdout) as {
    data?: { repository?: Record<string, {
      reviewThreads: { nodes: Array<{ isResolved: boolean; comments: { nodes: Array<{ author?: { login?: string } }> } }> }
    } | null> }
  }
  numbers.forEach((number, index) => {
    const pr = data.data?.repository?.[`pr${index}`]
    if (pr !== null && pr !== undefined) {
      const reviewers: Record<string, ReviewerCommentProgress> = {}
      for (const thread of pr.reviewThreads.nodes) {
        const login = thread.comments.nodes[0]?.author?.login
        if (login === undefined) continue
        const current = reviewers[login] ?? { total: 0, resolved: 0 }
        current.total += 1
        if (thread.isResolved) current.resolved += 1
        reviewers[login] = current
      }
      progress.set(number, reviewers)
    }
  })
  return progress
}

export async function ciChecks(cwd: string, repoSlug: string, number: number, signal?: AbortSignal): Promise<CiCheck[]> {  const result = await run(
    'gh',
    ['pr', 'checks', String(number), '--repo', repoSlug, '--json', 'name,bucket,state,workflow,link'],
    { cwd, timeoutMs: 30_000, signal },
  )
  if (result.stdout.trim().startsWith('[')) return JSON.parse(result.stdout) as CiCheck[]
  if (result.code !== 0 && /no checks reported/i.test(result.stderr)) return []
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'gh pr checks failed')
  return []
}

export function rollupChecks(checks: readonly PullRequestCheck[]): CiCheck[] {
  return checks.map(check => {
    const state = (check.status ?? check.state ?? check.conclusion ?? '').toUpperCase()
    const conclusion = (check.conclusion ?? check.state ?? '').toUpperCase()
    const pending = !['', 'COMPLETED'].includes((check.status ?? '').toUpperCase())
      || ['PENDING', 'EXPECTED'].includes((check.state ?? '').toUpperCase())
    const passed = ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(conclusion)
    const cancelled = ['CANCELLED', 'CANCELED'].includes(conclusion)
    return {
      name: check.name ?? check.context ?? 'unnamed check',
      bucket: pending ? 'pending' : passed ? 'pass' : cancelled ? 'cancel' : 'fail',
      state,
      workflow: check.workflowName ?? '',
      link: check.detailsUrl ?? check.targetUrl ?? '',
    }
  })
}

export function summarizeChecks(checks: readonly CiCheck[]): { status: CiStatus; summary: string } {
  if (checks.length === 0) return { status: 'none', summary: '尚无 CI checks' }
  const pending = checks.filter(check => check.bucket === 'pending')
  if (pending.length > 0) return { status: 'pending', summary: `${pending.length}/${checks.length} 个 checks 仍在运行` }
  const failed = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel')
  if (failed.length > 0) {
    return { status: 'failed', summary: `失败：${failed.map(check => check.name).join('、')}` }
  }
  return { status: 'passed', summary: `${checks.length} 个 checks 已通过或跳过` }
}

export interface CiAutoFixAssessment {
  actionableChecks: CiCheck[]
  failingBaseChecks: Array<Pick<CiCheck, 'name' | 'workflow'>>
}

const CI_LANE_ALIASES = new Map([
  // Both jobs execute `pnpm run check:ci:windows-complete`; the PR and master
  // workflow paths intentionally expose different display names.
  ['CI\nwindows node 24 / native complete', 'CI\nwindows-complete'],
  ['CI\nserial / windows (self-hosted standby)', 'CI\nwindows-complete'],
])

export function ciLaneKey(workflow: string, name: string): string {
  const exact = `${workflow.trim()}\n${name}`
  return CI_LANE_ALIASES.get(exact) ?? exact
}

export function selectCiAutoFixChecks(
  checks: readonly CiCheck[],
  failingBaseChecks: ReadonlyArray<Pick<CiCheck, 'name' | 'workflow'>>,
): CiAutoFixAssessment {
  const failedChecks = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel')
  const failingBaseLaneSet = new Set(failingBaseChecks.map(check => ciLaneKey(check.workflow, check.name)))
  return {
    actionableChecks: failedChecks.filter(check => (
      check.workflow.trim() === '' || !failingBaseLaneSet.has(ciLaneKey(check.workflow, check.name))
    )),
    failingBaseChecks: [...failingBaseChecks],
  }
}

/**
 * A failed PR check is not actionable when the same logical lane's latest
 * decisive base result is also a failure. Completed workflow runs are inspected
 * job-by-job because a cancelled workflow can contain an already completed job;
 * cancelled and skipped lane results do not supersede success/failure.
 */
export async function assessCiAutoFix(
  cwd: string,
  repoSlug: string,
  checks: readonly CiCheck[],
  baseBranch: string,
  signal?: AbortSignal,
  execute: typeof runOrThrow = runOrThrow,
): Promise<CiAutoFixAssessment> {
  const failedChecks = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel')
  const checksByWorkflow = new Map<string, CiCheck[]>()
  for (const check of failedChecks) {
    const workflow = check.workflow.trim()
    if (workflow === '') continue
    const workflowChecks = checksByWorkflow.get(workflow) ?? []
    workflowChecks.push(check)
    checksByWorkflow.set(workflow, workflowChecks)
  }
  const failingBaseChecks = (await Promise.all([...checksByWorkflow].map(async ([workflow, workflowChecks]) => {
    const listResult = await execute('gh', [
      'run', 'list', '--repo', repoSlug,
      '--branch', baseBranch,
      '--workflow', workflow,
      '--all',
      '--status', 'completed',
      '--limit', '50',
      '--json', 'databaseId,createdAt',
    ], { cwd, timeoutMs: 30_000, signal })
    const runs = (JSON.parse(listResult.stdout) as Array<{ databaseId: number; createdAt: string }>)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    const unresolvedLanes = new Set(workflowChecks.map(check => ciLaneKey(workflow, check.name)))
    const failedLanes = new Set<string>()
    const batchSize = 10
    for (let offset = 0; offset < runs.length && unresolvedLanes.size > 0; offset += batchSize) {
      const batch = runs.slice(offset, offset + batchSize)
      const views = await Promise.all(batch.map(async run => {
        const viewResult = await execute('gh', [
          'run', 'view', String(run.databaseId), '--repo', repoSlug, '--json', 'jobs',
        ], { cwd, timeoutMs: 30_000, signal })
        return JSON.parse(viewResult.stdout) as {
          jobs?: Array<{ name?: string; status?: string; conclusion?: string }>
        }
      }))
      for (const parsed of views) {
        for (const job of parsed.jobs ?? []) {
          const lane = ciLaneKey(workflow, job.name ?? '')
          if (!unresolvedLanes.has(lane) || job.status?.toUpperCase() !== 'COMPLETED') continue
          const conclusion = job.conclusion?.toUpperCase()
          if (conclusion !== 'SUCCESS' && conclusion !== 'FAILURE') continue
          unresolvedLanes.delete(lane)
          if (conclusion === 'FAILURE') failedLanes.add(lane)
        }
      }
      if (unresolvedLanes.size === 0) break
    }
    return workflowChecks
      .filter(check => failedLanes.has(ciLaneKey(workflow, check.name)))
      .map(check => ({ name: check.name, workflow }))
  }))).flat()
  return selectCiAutoFixChecks(checks, failingBaseChecks)
}
