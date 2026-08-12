import type { CiCheck, CiStatus, MyPullRequestSummary, PullRequestCheck, PullRequestInfo, ReviewerCommentProgress, ReviewRequestRecord } from './types.ts'
import { run, runOrThrow } from './util.ts'

const PR_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'mergeable', 'mergeStateStatus',
  'baseRefName', 'baseRefOid', 'headRefName', 'headRefOid',
  'reviewDecision', 'reviewRequests', 'latestReviews', 'statusCheckRollup',
].join(',')

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
  const result = await runOrThrow(
    'gh',
    ['pr', 'list', '--repo', repoSlug, '--author', '@me', '--state', 'open', '--limit', '100', '--json', PR_FIELDS],
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

export async function myOpenPullRequests(cwd: string, repoSlug: string, signal?: AbortSignal): Promise<MyPullRequestSummary[]> {
  const result = await runOrThrow(
    'gh',
    [
      'pr', 'list', '--repo', repoSlug, '--author', '@me', '--state', 'open', '--limit', '100',
      '--json', 'number,title,url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid',
    ],
    { cwd, timeoutMs: 30_000, signal },
  )
  return JSON.parse(result.stdout) as MyPullRequestSummary[]
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
  const parsed = JSON.parse(result.stdout) as Array<Omit<ReviewRequestRecord, 'author'> & { author?: { login?: string } }>
  return parsed.map(pr => ({ ...pr, author: pr.author?.login ?? 'unknown' }))
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

export function selectCiAutoFixChecks(
  checks: readonly CiCheck[],
  failingBaseChecks: ReadonlyArray<Pick<CiCheck, 'name' | 'workflow'>>,
): CiAutoFixAssessment {
  const failedChecks = checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel')
  const failingBaseCheckSet = new Set(failingBaseChecks.map(check => `${check.workflow}\n${check.name}`))
  return {
    actionableChecks: failedChecks.filter(check => (
      check.workflow.trim() === '' || !failingBaseCheckSet.has(`${check.workflow.trim()}\n${check.name}`)
    )),
    failingBaseChecks: [...failingBaseChecks],
  }
}

/**
 * A failed PR check is not actionable when the latest decisive result for the
 * same Actions job on the base branch is also a failure. Running, cancelled,
 * and skipped jobs do not supersede the latest success/failure result.
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
    const runs = (await Promise.all(['success', 'failure'].map(async status => {
      const result = await execute('gh', [
        'run', 'list', '--repo', repoSlug,
        '--branch', baseBranch,
        '--workflow', workflow,
        '--all',
        '--status', status,
        '--limit', '50',
        '--json', 'databaseId,createdAt',
      ], { cwd, timeoutMs: 30_000, signal })
      return JSON.parse(result.stdout) as Array<{ databaseId: number; createdAt: string }>
    }))).flat().sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    const unresolvedNames = new Set(workflowChecks.map(check => check.name))
    const failedNames = new Set<string>()
    for (const run of runs) {
      if (unresolvedNames.size === 0) break
      const result = await execute('gh', [
        'run', 'view', String(run.databaseId), '--repo', repoSlug, '--json', 'jobs',
      ], { cwd, timeoutMs: 30_000, signal })
      const parsed = JSON.parse(result.stdout) as {
        jobs?: Array<{ name?: string; status?: string; conclusion?: string }>
      }
      for (const job of parsed.jobs ?? []) {
        const name = job.name ?? ''
        if (!unresolvedNames.has(name) || job.status?.toUpperCase() !== 'COMPLETED') continue
        const conclusion = job.conclusion?.toUpperCase()
        if (conclusion !== 'SUCCESS' && conclusion !== 'FAILURE') continue
        unresolvedNames.delete(name)
        if (conclusion === 'FAILURE') failedNames.add(name)
      }
    }
    return workflowChecks
      .filter(check => failedNames.has(check.name))
      .map(check => ({ name: check.name, workflow }))
  }))).flat()
  return selectCiAutoFixChecks(checks, failingBaseChecks)
}
