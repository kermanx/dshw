import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  autoReviewId, countSeverities, defaultAutoReviewConfig, dueReviews, formatFindings, MAX_AUTO_FIX_ROUNDS,
  observePrCommits, shouldAutoFix,
} from '../src/auto-review.ts'
import type { AutoReviewComment, AutoReviewConfig, AutoReviewRecord, PrDashboardRecord } from '../src/types.ts'

/** Minimal dashboard row; only the fields the scheduler reads are meaningful. */
function pr(overrides: Partial<PrDashboardRecord> & { number: number, headOid: string }): PrDashboardRecord {
  return {
    cloneName: `pr-${String(overrides.number)}`,
    clonePath: `/tmp/pr-${String(overrides.number)}`,
    repoSlug: 'demo/repo',
    title: `PR ${String(overrides.number)}`,
    url: `https://github.com/demo/repo/pull/${String(overrides.number)}`,
    state: 'OPEN',
    isDraft: false,
    branch: `feature-${String(overrides.number)}`,
    baseRefName: 'master',
    baseOid: 'b'.repeat(40),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    reviewRequests: [],
    reviews: [],
    reviewerComments: {},
    ciStatus: 'none',
    ciSummary: '',
    checks: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as PrDashboardRecord
}

function config(overrides: Partial<AutoReviewConfig> = {}): AutoReviewConfig {
  return { ...defaultAutoReviewConfig(), hasApiKey: true, credentialSource: 'environment', ...overrides } as AutoReviewConfig
}

function comment(overrides: Partial<AutoReviewComment> = {}): AutoReviewComment {
  return {
    file: 'stats.ts',
    line: 3,
    lineType: 'new',
    severity: 'warning',
    message: 'sort() 按字典序排序',
    locationValid: true,
    ...overrides,
  }
}

function record(overrides: Partial<AutoReviewRecord> = {}): AutoReviewRecord {
  return {
    id: autoReviewId('demo/repo', 1),
    repoSlug: 'demo/repo',
    number: 1,
    title: 'PR 1',
    url: 'https://github.com/demo/repo/pull/1',
    branch: 'feature-1',
    baseRefName: 'master',
    headOid: 'a'.repeat(40),
    baseOid: 'b'.repeat(40),
    observedHeadOid: 'a'.repeat(40),
    status: 'idle',
    trigger: 'auto',
    summary: '',
    comments: [],
    counts: { critical: 0, warning: 0, suggestion: 0 },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('observePrCommits', () => {
  it('records the first sighting without scheduling a review', () => {
    const records = new Map<string, AutoReviewRecord>()
    const changed = observePrCommits(records, [pr({ number: 1, headOid: 'c'.repeat(40) })], config({ enabled: true }), Date.parse('2026-01-01T00:00:00Z'))
    assert.equal(changed.length, 1)
    const created = records.get('demo/repo#1')
    assert.ok(created !== undefined)
    assert.equal(created.status, 'idle')
    assert.equal(created.dueAt, undefined)
    assert.equal(created.observedHeadOid, 'c'.repeat(40))
  })

  it('debounces each new commit and keeps postponing the deadline forward', () => {
    const records = new Map<string, AutoReviewRecord>()
    const now = Date.parse('2026-01-01T00:00:00Z')
    const cfg = config({ enabled: true, debounceSeconds: 60, debounceMaxSeconds: 300 })
    observePrCommits(records, [pr({ number: 1, headOid: '1'.repeat(40) })], cfg, now)
    observePrCommits(records, [pr({ number: 1, headOid: '2'.repeat(40) })], cfg, now + 10_000)
    const first = records.get('demo/repo#1')
    assert.ok(first !== undefined)
    assert.equal(first.status, 'pending')
    assert.equal(first.dueAt, new Date(now + 10_000 + 60_000).toISOString())

    observePrCommits(records, [pr({ number: 1, headOid: '3'.repeat(40) })], cfg, now + 20_000)
    assert.equal(first.dueAt, new Date(now + 20_000 + 60_000).toISOString())
    assert.equal(first.pendingSince, new Date(now + 10_000).toISOString())
  })

  it('caps the wait at debounceMaxSeconds however many commits arrive', () => {
    const records = new Map<string, AutoReviewRecord>()
    const now = Date.parse('2026-01-01T00:00:00Z')
    const cfg = config({ enabled: true, debounceSeconds: 120, debounceMaxSeconds: 300 })
    observePrCommits(records, [pr({ number: 1, headOid: '1'.repeat(40) })], cfg, now)
    observePrCommits(records, [pr({ number: 1, headOid: '2'.repeat(40) })], cfg, now)
    const record = records.get('demo/repo#1')!
    observePrCommits(records, [pr({ number: 1, headOid: '3'.repeat(40) })], cfg, now + 280_000)
    assert.equal(record.dueAt, new Date(now + 300_000).toISOString())
  })

  it('does nothing while disabled, for drafts, and for PRs outside the scope', () => {
    const records = new Map<string, AutoReviewRecord>()
    const now = Date.now()
    assert.deepEqual(observePrCommits(records, [pr({ number: 1, headOid: '1'.repeat(40) })], config({ enabled: false }), now), [])
    assert.deepEqual(observePrCommits(records, [pr({ number: 1, headOid: '1'.repeat(40), isDraft: true })], config({ enabled: true }), now), [])
    assert.deepEqual(
      observePrCommits(records, [pr({ number: 2, headOid: '2'.repeat(40), assignedToMe: true })], config({ enabled: true, scope: 'mine' }), now),
      [],
    )
    assert.equal(observePrCommits(records, [pr({ number: 3, headOid: '3'.repeat(40) })], config({ enabled: true, scope: 'all' }), now).length, 1)
  })

  it('leaves a running review alone and reschedules after it finishes', () => {
    const records = new Map<string, AutoReviewRecord>()
    const now = Date.parse('2026-01-01T00:00:00Z')
    const cfg = config({ enabled: true, debounceSeconds: 30 })
    observePrCommits(records, [pr({ number: 1, headOid: '1'.repeat(40) })], cfg, now)
    const record = records.get('demo/repo#1')!
    record.status = 'running'
    observePrCommits(records, [pr({ number: 1, headOid: '2'.repeat(40) })], cfg, now + 5_000)
    assert.equal(record.status, 'running')
    assert.equal(record.dueAt, undefined)
    record.status = 'reviewed'
    observePrCommits(records, [pr({ number: 1, headOid: '3'.repeat(40) })], cfg, now + 9_000)
    assert.equal(record.status, 'pending')
    assert.equal(record.dueAt, new Date(now + 9_000 + 30_000).toISOString())
  })
})

describe('dueReviews', () => {
  it('returns only pending records whose deadline passed', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    const due = record({ status: 'pending', dueAt: new Date(now - 1).toISOString() })
    const early = record({ id: 'demo/repo#2', status: 'pending', dueAt: new Date(now + 60_000).toISOString() })
    const running = record({ id: 'demo/repo#3', status: 'running' })
    assert.deepEqual(dueReviews([due, early, running], now).map(entry => entry.id), ['demo/repo#1'])
  })
})

describe('countSeverities / formatFindings', () => {
  it('counts each severity and groups findings by file', () => {
    const comments = [
      comment({ severity: 'critical', line: 6 }),
      comment({ severity: 'warning', line: undefined, lineStart: 7, lineEnd: 8 }),
      comment({ file: 'other.ts', severity: 'suggestion', line: 2, message: '命名可以更清晰' }),
    ]
    assert.deepEqual(countSeverities(comments), { critical: 1, warning: 1, suggestion: 1 })
    const text = formatFindings(record({ summary: '有一个排序问题', comments }))
    assert.match(text, /有一个排序问题/u)
    assert.match(text, /### `stats\.ts`/u)
    assert.match(text, /### `other\.ts`/u)
    assert.match(text, /\[critical\] stats\.ts:6/u)
    assert.match(text, /\[warning\] stats\.ts:7-8/u)
  })

  it('marks comments the model could not anchor', () => {
    const text = formatFindings(record({ comments: [comment({ locationValid: false })] }))
    assert.match(text, /未能定位/u)
  })
})

describe('shouldAutoFix', () => {
  it('requires the feature, findings at the configured level, and a fresh head', () => {
    const reviewed = record({
      status: 'reviewed',
      reviewedHeadOid: 'a'.repeat(40),
      observedHeadOid: 'a'.repeat(40),
      counts: { critical: 0, warning: 1, suggestion: 0 },
    })
    const on = config({ enabled: true, autoFix: true })
    assert.equal(shouldAutoFix(reviewed, config({ autoFix: false })), false)
    assert.equal(shouldAutoFix(reviewed, { ...on, enabled: false }), false)
    assert.equal(shouldAutoFix(reviewed, { ...on, fixSeverity: 'critical' }), false)
    assert.equal(shouldAutoFix(reviewed, on), true)
    assert.equal(shouldAutoFix({ ...reviewed, counts: { critical: 0, warning: 0, suggestion: 2 } }, on), false)
    assert.equal(shouldAutoFix({ ...reviewed, fix: { jobId: 'job-1', status: 'running', startedAt: '2026-01-01T00:00:00Z', headOid: 'a'.repeat(40) } }, on), false)
    assert.equal(shouldAutoFix({ ...reviewed, fixRounds: MAX_AUTO_FIX_ROUNDS }, on), false)
  })
})
