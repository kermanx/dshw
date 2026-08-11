import type { CiCheck, CiStatus, MyPullRequestSummary, PullRequestCheck, PullRequestInfo, ReviewRequestRecord } from './types.ts'
import { run, runOrThrow } from './util.ts'

const PR_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'mergeable', 'mergeStateStatus',
  'baseRefName', 'baseRefOid', 'headRefName', 'headRefOid',
  'reviewDecision', 'latestReviews', 'statusCheckRollup',
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
