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

test('linear stack becomes consecutive with all descendants indented once, unrelated PRs keep their order', () => {
  const a = pr({ number: 10, branch: 'feature/a', baseRefName: 'master' })
  const b = pr({ number: 11, branch: 'feature/b', baseRefName: 'feature/a' })
  const c = pr({ number: 12, branch: 'feature/c', baseRefName: 'feature/b' })
  const x = pr({ number: 13, branch: 'feature/x', baseRefName: 'master' })
  const rows = orderStackedPrs([a, b, x, c])
  assert.deepEqual(
    rows.map(row => [row.pr.number, row.depth, row.hasChild]),
    [[10, 0, true], [11, 1, true], [12, 1, false], [13, 0, false]],
  )
})

test('two independent stacks stay separate and consecutive', () => {
  const a1 = pr({ number: 20, branch: 's1/a', baseRefName: 'master' })
  const b1 = pr({ number: 21, branch: 's1/b', baseRefName: 's1/a' })
  const a2 = pr({ number: 30, branch: 's2/a', baseRefName: 'master' })
  const b2 = pr({ number: 31, branch: 's2/b', baseRefName: 's2/a' })
  const rows = orderStackedPrs([b1, b2, a2, a1])
  assert.deepEqual(
    rows.map(row => [row.pr.number, row.depth, row.hasChild]),
    [[20, 0, true], [21, 1, false], [30, 0, true], [31, 1, false]],
  )
})

test('a lone PR targeting master is not stacked', () => {
  const lone = pr({ number: 40, branch: 'feature/only', baseRefName: 'master' })
  const rows = orderStackedPrs([lone])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[40, 0, false]])
})

test('a chain based on an untracked branch stays at the top level in its original order', () => {
  // a's base branch is not tracked (no PR has head == "feature/untracked")
  const a = pr({ number: 50, branch: 'feature/a', baseRefName: 'feature/untracked' })
  const b = pr({ number: 51, branch: 'feature/b', baseRefName: 'feature/a' })
  const c = pr({ number: 52, branch: 'feature/c', baseRefName: 'feature/b' })
  const rows = orderStackedPrs([c, a, b])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[52, 0, false], [50, 0, false], [51, 0, false]])
})

test('all forks join the stack in depth-first order with one level of indentation', () => {
  const a = pr({ number: 60, branch: 'feature/a', baseRefName: 'master' })
  const b1 = pr({ number: 61, branch: 'feature/b1', baseRefName: 'feature/a' })
  const b2 = pr({ number: 62, branch: 'feature/b2', baseRefName: 'feature/a' })
  const c1 = pr({ number: 63, branch: 'feature/c1', baseRefName: 'feature/b1' })
  const c2 = pr({ number: 64, branch: 'feature/c2', baseRefName: 'feature/b1' })
  const d = pr({ number: 65, branch: 'feature/d', baseRefName: 'feature/c1' })
  const c3 = pr({ number: 66, branch: 'feature/c3', baseRefName: 'feature/b2' })
  const rows = orderStackedPrs([c3, b1, b2, a, c1, c2, d])
  assert.deepEqual(
    rows.map(row => [row.pr.number, row.depth, row.hasChild]),
    [[60, 0, true], [61, 1, true], [63, 1, true], [65, 1, false], [64, 1, false], [62, 1, true], [66, 1, false]],
  )
})

test('a draft child listed before its root still yields a root-first consecutive stack', () => {
  const a = pr({ number: 70, branch: 'feature/a', baseRefName: 'master' })
  const b = pr({ number: 71, branch: 'feature/b', baseRefName: 'feature/a', isDraft: true })
  const rows = orderStackedPrs([b, a])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[70, 0, true], [71, 1, false]])
})

test('a cycle between two PR bases degrades to non-stacked rows without hanging', () => {
  const a = pr({ number: 80, branch: 'feature/a', baseRefName: 'feature/b' })
  const b = pr({ number: 81, branch: 'feature/b', baseRefName: 'feature/a' })
  const c = pr({ number: 82, branch: 'feature/c', baseRefName: 'feature/b' })
  const rows = orderStackedPrs([a, b, c])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[80, 0, false], [81, 0, false], [82, 0, false]])
})

test('PRs targeting master remain roots even when a tracked PR has master as its head', () => {
  const a = pr({ number: 90, branch: 'feature/a', baseRefName: 'master' })
  const master = pr({ number: 91, branch: 'master', baseRefName: 'feature/a' })
  const b = pr({ number: 92, branch: 'feature/b', baseRefName: 'master' })
  const rows = orderStackedPrs([master, b, a])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[90, 0, true], [91, 1, false], [92, 0, false]])
})

test('a chain targeting main stays at the top level because only master anchors a stack', () => {
  const a = pr({ number: 100, branch: 'feature/a', baseRefName: 'main' })
  const b = pr({ number: 101, branch: 'feature/b', baseRefName: 'feature/a' })
  const rows = orderStackedPrs([b, a])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[101, 0, false], [100, 0, false]])
})

test('a self-referencing PR and its child stay at the top level', () => {
  const a = pr({ number: 110, branch: 'feature/a', baseRefName: 'feature/a' })
  const b = pr({ number: 111, branch: 'feature/b', baseRefName: 'feature/a' })
  const rows = orderStackedPrs([a, b])
  assert.deepEqual(rows.map(row => [row.pr.number, row.depth, row.hasChild]), [[110, 0, false], [111, 0, false]])
})
