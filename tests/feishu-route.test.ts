import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRoute, routeContext, routePrompt } from '../src/feishu-route.ts'
import type { AutoReviewRecord } from '../src/types.ts'

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
    summary: '新增 percentile()，边界有问题。',
    comments: [
      { file: 'stats.ts', line: 8, lineType: 'new', severity: 'critical', message: '浮点误差导致取错分位', locationValid: true },
    ],
    counts: { critical: 1, warning: 0, suggestion: 0 },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('feishu natural-language routing', () => {
  it('parses a plain JSON route', () => {
    const route = parseRoute('{"action":"review","reply":"好，重新跑一遍"}', 'fallback')
    assert.equal(route.action, 'review')
    assert.equal(route.reply, '好，重新跑一遍')
  })

  it('parses a fenced JSON route and keeps the instruction', () => {
    const route = parseRoute('```json\n{"action":"fix","instruction":"只修 critical","reply":"收到"}\n```', 'fallback')
    assert.equal(route.action, 'fix')
    assert.equal(route.instruction, '只修 critical')
  })

  it('falls back to a fix instruction when the model rambles', () => {
    const route = parseRoute('我觉得应该修一下 stats.ts', '我觉得应该修一下 stats.ts')
    assert.equal(route.action, 'fix')
    assert.equal(route.instruction, '我觉得应该修一下 stats.ts')
  })

  it('keeps question routes as answers', () => {
    const route = parseRoute('{"action":"answer","reply":"因为 100*0.07 有浮点误差"}', '为什么')
    assert.equal(route.action, 'answer')
    assert.equal(route.reply, '因为 100*0.07 有浮点误差')
  })

  it('builds a compact context with counts, findings and fix state', () => {
    const context = routeContext(record(), false)
    assert.match(context, /PR #41/u)
    assert.match(context, /1 必须修复/u)
    assert.match(context, /stats\.ts:8/u)
    assert.match(context, /修复会话：未启动/u)
    const prompt = routePrompt(record(), '重新评审', true)
    assert.match(prompt.system, /只输出 JSON/u)
    assert.match(prompt.user, /用户消息：重新评审/u)
  })
})
