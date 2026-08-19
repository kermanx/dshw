import assert from 'node:assert/strict'
import test from 'node:test'
import { orderStackedPrs } from '../plugin/src/stack.ts'
import type { PrDashboardRecord } from '../src/types.ts'

/** Minimal dashboard record; `branch`/`baseRefName` are what matter for stacking. */
const pr = (overrides: Partial<PrDashboardRecord> & { number: number; branch: string; baseRefName: string }): PrDashboardRecord => ({
  cloneName: `clone-${overrides.number}`,
  clonePath: `/tmp/clone-${overrides.number}`,
  repoSlug: 'owner/repo',
  title: `PR #${overrides.number}`,
  url: `https://github.com/owner/repo/pull/${overrides.number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: [],
  reviews: [],
  reviewerComments: {},
  ciStatus: 'none',
  ciSummary: '',
  checks: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

test('linear stack becomes consecutive with depths 0/1/2, unrelated PRs keep their order', () => {
  const a = pr({ number: 10, branch: 'feature/a', baseRefName: 'main' })
  const b = pr({ number: 11, branch: 'feature/b', baseRefName: 'feature/a' })
  const c = pr({ number: 12, branch: 'feature/c', baseRefName: 'feature/b' })
  const x = pr({ number: 13, branch: 'feature/x', baseRefName: 'main' })
  const rows = orderStackedPrs([a, b, x, c])
  assert.deepEqual(
    rows.map(row => [row.pr.number, row.depth, row.hasChild]),
    [[10, 0, true], [11, 1, true], [12, 2, false], [13, 0, false]],
  )
})

test('two independent stacks stay separate and consecutive', () => {
  const a1 = pr({ number: 20, branch: 's1/a', baseRefName: 'main' })
  const b1 = pr({ number: 21, branch: 's1/b', baseRefName: 's1/a' })
  const a2 = pr({ number: 30, branch: 's2/a', baseRefName: 'main' })
  const b2 = pr({ number: 31, branch: 's2/b', baseRefName: 's2/a' })
  const rows = orderStackedPrs([a1, b1, a2, b2])
  assert.deepEqual(
    rows.map(row => [row.pr.number, row.depth, row.hasChild]),
    [[20, 0, true], [21, 1, false], [30, 0, true], [31, 1, false]],
  )
})

test('a lone PR (even with a stack-looking base) is not stacked', () => {
  const lone = pr({ number: 40, branch: 'feature/only', baseRefName: 'main' })
  const rows = orderStackedPrs([lone])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[40, 0, false]])
})

test('a PR basing on an untracked branch is a root; its child still stacks', () => {
  // a's base branch is not tracked (no PR has head == "feature/untracked")
  const a = pr({ number: 50, branch: 'feature/a', baseRefName: 'feature/untracked' })
  const b = pr({ number: 51, branch: 'feature/b', baseRefName: 'feature/a' })
  const rows = orderStackedPrs([a, b])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[50, 0, true], [51, 1, false]])
})

test('forked base (two PRs on the same parent branch) links only the first child', () => {
  const a = pr({ number: 60, branch: 'feature/a', baseRefName: 'main' })
  const b1 = pr({ number: 61, branch: 'feature/b1', baseRefName: 'feature/a' })
  const b2 = pr({ number: 62, branch: 'feature/b2', baseRefName: 'feature/a' })
  const rows = orderStackedPrs([a, b1, b2])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[60, 0, true], [61, 1, false], [62, 0, false]])
})

test('a draft child listed before its root still yields a root-first consecutive stack', () => {
  const a = pr({ number: 70, branch: 'feature/a', baseRefName: 'main' })
  const b = pr({ number: 71, branch: 'feature/b', baseRefName: 'feature/a', isDraft: true })
  const rows = orderStackedPrs([b, a])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[70, 0, true], [71, 1, false]])
})

test('a cycle between two PR bases degrades to non-stacked rows without hanging', () => {
  const a = pr({ number: 80, branch: 'feature/a', baseRefName: 'feature/b' })
  const b = pr({ number: 81, branch: 'feature/b', baseRefName: 'feature/a' })
  const rows = orderStackedPrs([a, b])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[80, 0, false], [81, 0, false]])
})
