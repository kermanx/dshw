import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { escapeHtml, renderReviewPage, renderReviewPageMissing } from '../src/review-page.ts'
import type { AutoReviewRecord } from '../src/types.ts'
import type { ReviewUsage } from '../src/review/engine.ts'

const USAGE: ReviewUsage = { input: 4972, output: 4732, cacheRead: 65_920, cacheWrite: 0, totalTokens: 75_624, costUsd: 0.0218, steps: 7 }

function record(overrides: Partial<AutoReviewRecord> = {}): AutoReviewRecord {
  return {
    id: 'demo/repo#41',
    repoSlug: 'demo/repo',
    number: 41,
    title: 'feat: add percentile helper',
    url: 'https://github.com/demo/repo/pull/41',
    branch: 'feature/percentile',
    baseRefName: 'master',
    headOid: 'a'.repeat(40),
    baseOid: 'b'.repeat(40),
    observedHeadOid: 'c'.repeat(40),
    reviewedHeadOid: 'c'.repeat(40),
    status: 'reviewed',
    trigger: 'auto',
    summary: '新增 percentile()，存在排序与边界问题。',
    comments: [
      { file: 'stats.ts', line: 6, lineType: 'new', severity: 'critical', message: 'sort() 按字典序排序', locationValid: true },
      { file: 'stats.ts', line: 8, lineType: 'new', severity: 'warning', message: '索引越界', locationValid: true },
    ],
    counts: { critical: 1, warning: 1, suggestion: 0 },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('review page', () => {
  it('carries the cost line the card leaves out', () => {
    const html = renderReviewPage(record({ usage: USAGE }), undefined)
    assert.match(html, /本次评审开销/u)
    assert.match(html, /≈ \$0\.02/u)
    assert.match(html, /4\.7k 输出/u)
    assert.doesNotMatch(renderReviewPage(record(), undefined), /本次评审开销/u)
  })

  it('lists the findings and the verdict', () => {
    const html = renderReviewPage(record(), undefined)
    assert.match(html, /1 必须 · 1 建议/u)
    assert.match(html, /sort\(\) 按字典序排序/u)
    assert.match(html, /评审意见/u)
  })

  it('offers a one-click fix form when an action path is given', () => {
    const html = renderReviewPage(record(), undefined, { actionPath: '/api/dshw/review/demo%2Frepo/41' })
    assert.match(html, /<form class="actions" method="post" action="\/api\/dshw\/review\/demo%2Frepo\/41\/fix">/u)
    assert.match(html, /开始修复/u)
  })

  it('shows the fix session state when one exists', () => {
    const html = renderReviewPage(record({
      fix: { jobId: 'j', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', headOid: 'c'.repeat(40), producedHeadOid: 'd'.repeat(40) },
    }), undefined)
    assert.match(html, /修复会话/u)
    assert.match(html, /已完成/u)
    assert.match(html, /ccccccc → ddddddd/u)
  })

  it('escapes model output', () => {
    const html = renderReviewPage(record({
      title: '<script>alert(1)</script>',
      summary: '<img src=x onerror=alert(1)>',
      comments: [{ file: 'a.ts', line: 1, lineType: 'new', severity: 'warning', message: '<b>x</b>', locationValid: true }],
    }), undefined)
    assert.doesNotMatch(html, /<script>alert/u)
    assert.match(html, /&lt;script&gt;/u)
    assert.equal(escapeHtml('a & b "c"'), 'a &amp; b &quot;c&quot;')
  })

  it('renders a 404 body for a missing record', () => {
    assert.match(renderReviewPageMissing('没有找到 demo/repo #9'), /没有找到 demo\/repo #9/u)
  })
})
