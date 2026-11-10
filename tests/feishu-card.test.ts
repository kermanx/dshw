import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildFixCard, buildReviewCard, reviewHeader, reviewLink, summarizeProgress } from '../src/feishu-card.ts'
import { estimatePricing, formatCost, formatTokens } from '../src/review/pricing.ts'
import type { AutoReviewRecord } from '../src/types.ts'
import type { ReviewUsage } from '../src/review/engine.ts'

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
      { file: 'stats.ts', line: 6, lineType: 'new', severity: 'critical', message: 'sort() 按字典序排序，务必改成数值比较', locationValid: true },
      { file: 'stats.ts', line: 8, lineType: 'new', severity: 'warning', message: '索引越界', locationValid: true },
    ],
    counts: { critical: 1, warning: 1, suggestion: 0 },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const USAGE: ReviewUsage = { input: 4972, output: 4732, cacheRead: 65_920, cacheWrite: 0, totalTokens: 75_624, costUsd: 0.0218, steps: 7 }

/** Parse a card JSON string into its body elements for structural assertions. */
function body(card: string): { elements: Array<Record<string, unknown>>, header: Record<string, unknown> } {
  const parsed = JSON.parse(card) as { body: { elements: Array<Record<string, unknown>> }, header: Record<string, unknown> }
  return { elements: parsed.body.elements, header: parsed.header }
}

describe('review card layout', () => {
  it('shows a plain PR line (no bold) right under the header', () => {
    const { elements } = body(buildReviewCard(record(), 'http://127.0.0.1:3079'))
    const first = elements[0] as { tag: string, content: string }
    assert.equal(first.tag, 'markdown')
    assert.match(first.content, /\[#41\]\(https:\/\/github\.com\/demo\/repo\/pull\/41\)/u)
    assert.match(first.content, /feat: add percentile helper/u)
    assert.doesNotMatch(first.content, /\*\*/u, 'the PR title line must not be bold')
  })

  it('reduces the review to one compact counts line', () => {
    const { elements } = body(buildReviewCard(record(), 'http://127.0.0.1:3079'))
    const counts = elements[1] as { tag: string, content: string }
    assert.equal(counts.tag, 'markdown', 'counts are a single markdown line, not a metric grid')
    assert.match(counts.content, /1\*\*<\/font> 必须修复/u)
    assert.match(counts.content, /1\*\* 建议修复/u)
    assert.match(counts.content, /0\*\*<\/font> 建议/u)
    const card = buildReviewCard(record(), 'http://127.0.0.1:3079')
    // No finding detail, no collapsed panel, no metric grid.
    assert.doesNotMatch(card, /按字典序排序/u)
    assert.doesNotMatch(card, /collapsible_panel/u)
    assert.doesNotMatch(card, /## /u)
  })

  it('ends with one grey state line and the buttons, and carries no cost', () => {
    const card = buildReviewCard(record({ usage: USAGE }), 'http://x')
    const { elements } = body(card)
    const texts = elements.map(element => String(element.content ?? ''))
    const state = texts.find(text => text.includes('修复会话'))
    assert.ok(state !== undefined)
    assert.match(state, /未启动/u)
    assert.equal(elements.at(-1)?.tag, 'column_set', 'buttons close the card')
    assert.doesNotMatch(card, /本次评审开销|≈ \$/u, 'the cost lives on the review page, not the card')
  })

  it('explains a missing fix session inside the state line, not in its own block', () => {
    const { elements } = body(buildReviewCard(record(), 'http://x', undefined, '自动修复未开启'))
    const texts = elements.map(element => String(element.content ?? ''))
    assert.equal(texts.filter(text => text.includes('修复会话')).length, 1)
    assert.match(texts.find(text => text.includes('修复会话')) ?? '', /自动修复未开启/u)
  })

  it('shows the running fix state with the worker\'s latest step', () => {
    const running = record({ fix: { jobId: 'job-1', status: 'running', startedAt: '2026-01-01T00:00:00Z', headOid: 'c'.repeat(40) } })
    const { elements } = body(buildReviewCard(running, 'http://gui', { status: 'running', message: '步骤 3 开始' }))
    const state = elements.map(element => String(element.content ?? '')).find(text => text.includes('修复会话')) ?? ''
    assert.match(state, /进行中/u)
    assert.match(state, /步骤 3 开始/u)
  })

  it('compresses raw tool-call progress lines', () => {
    assert.equal(summarizeProgress('调用工具 write：{"path":"stats.ts","content":"…"}'), '调用工具 write：stats.ts')
    assert.equal(summarizeProgress('调用工具 bash：{"command":"pnpm test stats"}'), '调用工具 bash：pnpm test stats')
    assert.match(summarizeProgress('思考：先看看 percentile 的实现'), /^思考：/u)
    assert.ok(summarizeProgress('x'.repeat(400)).length <= 100)
  })

  it('reports the produced commit range when the session succeeded', () => {
    const done = record({ fix: { jobId: 'job-1', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', headOid: 'c'.repeat(40), producedHeadOid: 'd'.repeat(40) } })
    const { elements } = body(buildReviewCard(done, 'http://gui'))
    const state = elements.map(element => String(element.content ?? '')).find(text => text.includes('修复会话')) ?? ''
    assert.match(state, /已完成/u)
    assert.match(state, /ccccccc/u)
    assert.match(state, /ddddddd/u)
  })

  it('shows a waiting fix with its diff stats and a push button', () => {
    const ready = record({
      fix: {
        jobId: 'job-1',
        status: 'ready',
        startedAt: '2026-01-01T00:00:00Z',
        headOid: 'c'.repeat(40),
        diff: { stat: '2 files changed', patch: '', files: ['stats.ts', 'test.ts'], additions: 7, deletions: 2, truncated: false, capturedAt: '2026-01-01T00:00:00Z' },
        summary: '修了浮点误差。',
        notes: ['需要补测试'],
      },
    })
    const card = buildReviewCard(ready, 'http://gui')
    assert.match(card, /待你确认/u)
    assert.match(card, /2 个文件 · \+7 −2/u)
    assert.match(card, /修了浮点误差/u)
    assert.match(card, /"a":"push"/u)
    assert.match(card, /推送/u)
  })

  it('shows a pushed fix with the commit', () => {
    const pushed = record({ fix: { jobId: 'job-1', status: 'pushed', startedAt: '2026-01-01T00:00:00Z', headOid: 'c'.repeat(40), producedHeadOid: 'd'.repeat(40) } })
    const card = buildReviewCard(pushed, 'http://gui')
    assert.match(card, /已推送/u)
    assert.match(card, /ddddddd/u)
  })

  it('never uses red', () => {
    const cards = [
      buildReviewCard(record({ usage: USAGE }), 'http://x'),
      buildReviewCard(record({ status: 'failed', error: 'boom' }), 'http://x'),
      buildFixCard(record({ fix: { jobId: 'j', status: 'running', startedAt: '2026-01-01T00:00:00Z', headOid: 'c'.repeat(40) } }), { status: 'running' }, 'http://x'),
    ]
    for (const card of cards) assert.doesNotMatch(card, /red/iu)
  })

  it('offers actions as buttons and never as slash commands', () => {
    const card = buildReviewCard(record(), 'http://x')
    assert.doesNotMatch(card, /\/fix|`\//u)
    assert.match(card, /开始修复/u)
    assert.match(card, /重新评审/u)
    assert.match(card, /"type":"callback"/u)
  })

  it('uses a green header when nothing was found', () => {
    const clean = record({ comments: [], counts: { critical: 0, warning: 0, suggestion: 0 } })
    assert.equal(reviewHeader(clean).tone, 'green')
    assert.match(buildReviewCard(clean), /评审通过/u)
    assert.match(buildReviewCard(clean), /未发现问题/u)
  })

  it('keeps the failure header calm (orange, not red)', () => {
    assert.equal(reviewHeader(record({ status: 'failed', error: 'boom' })).tone, 'orange')
  })
})

describe('fix card', () => {
  it('labels running and finished sessions', () => {
    const running = buildFixCard(
      record({ fix: { jobId: 'j', status: 'running', startedAt: '2026-01-01T00:00:00Z', headOid: 'c'.repeat(40) } }),
      { status: 'running', message: '步骤 3：修改 stats.ts' },
      'http://gui',
    )
    assert.match(running, /修复进行中/u)
    assert.match(running, /步骤 3/u)
    const done = buildFixCard(
      record({ fix: { jobId: 'j', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', headOid: 'c'.repeat(40), producedHeadOid: 'd'.repeat(40) } }),
      { status: 'succeeded' },
      'http://gui',
    )
    assert.match(done, /修复完成/u)
  })
})

describe('links and pricing', () => {
  it('builds the review page link under the GUI origin', () => {
    assert.equal(reviewLink(record(), 'http://127.0.0.1:3079/'), 'http://127.0.0.1:3079/api/dshw/review/demo%2Frepo/41')
    assert.equal(reviewLink(record(), undefined), undefined)
  })

  it('picks a price family from the model id', () => {
    assert.equal(estimatePricing('deepseek-v4-flash').input, 0.28)
    assert.equal(estimatePricing('anthropic/claude-opus-5').input, 15)
    assert.equal(estimatePricing('anthropic/claude-haiku-4.5').input, 1)
    assert.equal(estimatePricing('glm-5.3').input, 0.6)
    assert.equal(estimatePricing('unknown-model').input, 1)
  })

  it('formats tokens and cost for the footer line', () => {
    assert.equal(formatTokens(950), '950')
    assert.equal(formatTokens(12_700), '12.7k')
    assert.equal(formatTokens(1_200_000), '1.2M')
    const line = formatCost(USAGE)
    assert.match(line, /≈ \$0\.02/u)
    assert.match(line, /4\.7k 输出/u)
    assert.match(line, /65\.9k 命中缓存/u)
  })
})
