/**
 * Development-only demo project for PR Auto Reviewer.
 *
 * The daemon needs GitHub to see real pull requests, so an offline development
 * box (no network, no PRs) would only ever show empty states. When
 * `DSHW_DEV_MODE=1` and `DSHW_DEMO=1` are set, the daemon seeds one local Git
 * repository plus synthetic dashboard/review records so the list, the badge,
 * the detail panel and the diff view can be exercised end to end. Nothing here
 * runs in a normal install: the caller gates it on both variables.
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_ROOT } from './config.ts'
import type { AutoReviewRecord, PrDashboardRecord } from './types.ts'
import { now, runOrThrow } from './util.ts'

/** One seeded scenario: the dashboard PR row, its review record and its commits. */
export interface DemoScenario {
  pr: PrDashboardRecord
  record: AutoReviewRecord
}

const REPO_SLUG = 'demo/dshw-auto-review'
const BASE_STATS = `export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
`
const FEAT_STATS = `export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function percentile(values: number[], p: number): number {
  const sorted = values.sort()
  const index = Math.floor(sorted.length * p)
  return sorted[index]!
}
`
const FIX_STATS = `export function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0 || p < 0 || p > 1) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index]
}
`

/** Commit a file and return the resulting commit id. */
async function commit(repo: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(join(repo, file), content)
  await runOrThrow('git', ['add', '--', file], { cwd: repo })
  await runOrThrow('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], { cwd: repo })
  return (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Create (or reuse) `.dshw/dev/demo/dshw-auto-review.git` and return its commit ids. */
async function ensureDemoRepository(): Promise<{ repo: string, base: string, feature: string, fix: string }> {
  const root = join(DATA_ROOT, 'demo')
  const repo = join(root, 'dshw-auto-review')
  if (!await exists(join(repo, '.git'))) {
    await mkdir(repo, { recursive: true })
    await runOrThrow('git', ['init', '-q', '-b', 'feature/percentile'], { cwd: repo })
    await runOrThrow('git', ['config', 'user.email', 'demo@dshw.local'], { cwd: repo })
    await runOrThrow('git', ['config', 'user.name', 'dshw demo'], { cwd: repo })
    const base = await commit(repo, 'stats.ts', BASE_STATS, 'chore: seed stats helper')
    const feature = await commit(repo, 'stats.ts', FEAT_STATS, 'feat: add percentile helper')
    const fix = await commit(repo, 'stats.ts', FIX_STATS, 'fix: sort numerically and clamp the percentile index')
    return { repo, base, feature, fix }
  }
  const head = (await runOrThrow('git', ['rev-list', '--reverse', 'HEAD'], { cwd: repo })).stdout.trim().split('\n')
  if (head.length < 3) throw new Error('demo 仓库缺少预期的提交，请删除 .dshw/dev/demo 后重启')
  return { repo, base: head[0]!, feature: head[1]!, fix: head[2]! }
}

/** Build the dashboard row for the demo PR (open, reviewable, no CI). */
function demoPr(repo: string, base: string, head: string): PrDashboardRecord {
  return {
    cloneName: 'dshw-auto-review',
    clonePath: repo,
    repoSlug: REPO_SLUG,
    number: 41,
    title: '[演示] feat: add percentile helper',
    url: 'https://github.com/demo/dshw-auto-review/pull/41',
    state: 'OPEN',
    isDraft: false,
    branch: 'feature/percentile',
    baseRefName: 'master',
    author: 'demo',
    headOid: head,
    baseOid: base,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    reviewRequests: [],
    reviews: [],
    reviewerComments: {},
    ciStatus: 'none',
    ciSummary: '无检查',
    checks: [],
    updatedAt: now(),
  }
}

/** Seed the demo PRs: one waiting for a fix, one whose fix session finished. */
export async function seedDemoScenarios(): Promise<DemoScenario[]> {
  return [await seedDemoScenario(), await seedDemoFixedScenario()]
}

/** Seed the second demo PR: a finished fix session on the same repository. */
export async function seedDemoFixedScenario(): Promise<DemoScenario> {
  const { repo, base, feature, fix } = await ensureDemoRepository()
  const pr = demoPr(repo, base, fix)
  pr.number = 42
  pr.title = '[演示] refactor: 把看板筛选状态提到 URL 里'
  pr.url = 'https://github.com/demo/dshw-auto-review/pull/42'
  pr.cloneName = 'dshw-auto-review-42'
  const timestamp = now()
  const record: AutoReviewRecord = {
    id: `${REPO_SLUG}#42`,
    repoSlug: REPO_SLUG,
    number: 42,
    title: pr.title,
    url: pr.url,
    branch: pr.branch,
    baseRefName: pr.baseRefName,
    author: 'demo',
    headOid: feature,
    baseOid: base,
    observedHeadOid: fix,
    reviewedHeadOid: feature,
    status: 'reviewed',
    trigger: 'auto',
    summary: '筛选状态提到 URL 的改动整体没问题，边界上还有几处要收。',
    comments: [
      { file: 'stats.ts', line: 6, lineType: 'new', severity: 'critical', message: '排序仍会算错', locationValid: true },
      { file: 'stats.ts', lineStart: 7, lineEnd: 8, lineType: 'new', severity: 'warning', message: '索引越界', locationValid: true },
      { file: 'stats.ts', line: 9, lineType: 'new', severity: 'warning', message: '缺少 p 范围校验', locationValid: true },
      { file: 'stats.ts', line: 14, lineType: 'new', severity: 'suggestion', message: '可以补一个边界用例', locationValid: true },
    ],
    counts: { critical: 1, warning: 2, suggestion: 1 },
    model: 'deepseek-v4-flash',
    engine: '0.85.1',
    usage: { input: 8_240, output: 5_120, cacheRead: 41_000, cacheWrite: 0, totalTokens: 54_360, costUsd: 0.0123, steps: 9 },
    fix: { jobId: 'demo-fix-42', status: 'succeeded', startedAt: timestamp, finishedAt: timestamp, headOid: feature, producedHeadOid: fix },
    startedAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
  }
  return { pr, record }
}

/** Seed one reviewed PR (with findings and a follow-up fix commit). */
export async function seedDemoScenario(): Promise<DemoScenario> {
  const { repo, base, feature, fix } = await ensureDemoRepository()
  const pr = demoPr(repo, base, fix)
  const id = `${REPO_SLUG}#${String(pr.number)}`
  const reviewedAt = now()
  const record: AutoReviewRecord = {
    id,
    repoSlug: REPO_SLUG,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.branch,
    baseRefName: pr.baseRefName,
    author: 'demo',
    headOid: feature,
    baseOid: base,
    observedHeadOid: fix,
    reviewedHeadOid: feature,
    status: 'reviewed',
    trigger: 'auto',
    summary: '新增 percentile() 辅助函数，供报表看板使用。实现上有两个会直接影响结果的问题：默认排序是字符串字典序，且原地修改调用方数组；下标也没有做边界处理。',
    comments: [
      {
        file: 'stats.ts',
        line: 6,
        lineType: 'new',
        severity: 'critical',
        message: '`values.sort()` 未传比较器时按字符串字典序排序（[10, 9, 100] 会变成 [10, 100, 9]），并且会原地打乱调用方数组。建议 `[...values].sort((a, b) => a - b)`。',
        fallbackLine: 6,
        locationValid: true,
      },
      {
        file: 'stats.ts',
        lineStart: 7,
        lineEnd: 8,
        lineType: 'new',
        severity: 'warning',
        message: 'p = 1 时 `Math.floor(n * 1) === n`，`sorted[n]` 为 undefined；空数组同样越界，而签名声明返回 number。建议校验 p ∈ [0, 1] 与数组非空，并把下标 clamp 到 [0, n-1]。',
        fallbackLine: 7,
        locationValid: true,
      },
    ],
    counts: { critical: 1, warning: 1, suggestion: 0 },
    model: 'deepseek-v4-flash',
    engine: '0.85.1',
    startedAt: reviewedAt,
    finishedAt: reviewedAt,
    updatedAt: reviewedAt,
  }
  return { pr, record }
}
