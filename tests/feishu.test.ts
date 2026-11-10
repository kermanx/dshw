import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  FeishuStore, FeishuService, isUserMessage, messageText, parseFeishuCommand, renderFixReply,
  renderReviewReply, renderTopicOpener, severityLine,
} from '../src/feishu.ts'
import type { AutoReviewRecord } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function store(): Promise<FeishuStore> {
  const root = await mkdtemp(join(tmpdir(), 'dshw-feishu-'))
  roots.push(root)
  return await FeishuStore.open(join(root, 'feishu.json'))
}

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
    summary: '新增 percentile() 辅助函数，按字符串排序会算错。',
    comments: [
      { file: 'stats.ts', line: 6, lineType: 'new', severity: 'critical', message: 'sort() 按字典序排序，应用数值比较器', locationValid: true },
      { file: 'stats.ts', lineStart: 7, lineEnd: 8, lineType: 'new', severity: 'warning', message: 'p=1 时越界', locationValid: true },
    ],
    counts: { critical: 1, warning: 1, suggestion: 0 },
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('parseFeishuCommand', () => {
  it('parses explicit commands with and without arguments', () => {
    assert.deepEqual(parseFeishuCommand('/review'), { kind: 'review' })
    assert.deepEqual(parseFeishuCommand('  /STATUS '), { kind: 'status' })
    assert.deepEqual(parseFeishuCommand('/open'), { kind: 'open' })
    assert.deepEqual(parseFeishuCommand('/fix'), { kind: 'fix' })
    assert.deepEqual(parseFeishuCommand('/fix 只处理 critical'), { kind: 'fix', instruction: '只处理 critical' })
    assert.deepEqual(parseFeishuCommand('/nope'), { kind: 'help' })
  })

  it('treats free text as an instruction and ignores empty messages', () => {
    assert.deepEqual(parseFeishuCommand('顺便把测试补上'), { kind: 'steer', instruction: '顺便把测试补上' })
    assert.equal(parseFeishuCommand('   '), undefined)
  })
})

describe('message extraction', () => {
  it('reads text and post payloads', () => {
    assert.equal(messageText({ body: { content: '{"text":"/status"}' } }), '/status')
    const post = { body: { content: JSON.stringify({ title: '标题', content: [[{ tag: 'text', text: '第一段' }, { tag: 'text', text: '补' }], [{ tag: 'text', text: '第二行' }]] }) } }
    assert.equal(messageText(post), '标题\n第一段补\n第二行')
    assert.equal(messageText({ body: { content: 'not json' } }), '')
    assert.equal(messageText({}), '')
  })

  it('recognizes messages written by a person', () => {
    assert.equal(isUserMessage({ sender: { sender_type: 'user' } }), true)
    assert.equal(isUserMessage({ sender: { sender_type: 'app' } }), false)
    assert.equal(isUserMessage({}), false)
  })
})

describe('message rendering', () => {
  it('summarizes severities and findings', () => {
    assert.equal(severityLine(record()), '1 critical · 1 warning')
    const reply = renderReviewReply(record(), 'http://127.0.0.1:3079')
    assert.match(reply, /评审完成/u)
    assert.match(reply, /1 critical · 1 warning/u)
    assert.match(reply, /`critical` `stats\.ts:6`/u)
    assert.match(reply, /`warning` `stats\.ts:7`/u)
    assert.match(reply, /开始修复/u)
    assert.match(reply, /看板：http:\/\/127\.0\.0\.1:3079/u)
  })

  it('does not advertise /fix when there is nothing to fix', () => {
    const clean = record({ comments: [], counts: { critical: 0, warning: 0, suggestion: 1 } })
    assert.doesNotMatch(renderReviewReply(clean), /开始修复/u)
  })

  it('describes the topic and fix outcomes', () => {
    const opener = renderTopicOpener(record(), 'http://127.0.0.1:3079')
    assert.match(opener.title, /PR #41 · demo\/repo/u)
    assert.match(opener.body, /`master` ← `feature\/percentile`/u)
    assert.match(opener.body, /都会更新在这张卡片上/u)
    const fix = renderFixReply(record({
      fix: { jobId: 'job-1', status: 'blocked', startedAt: '2026-01-01T00:00:00.000Z', headOid: 'c'.repeat(40), blockedReason: '需要产品决策' },
    }), 'blocked')
    assert.match(fix, /无法完成/u)
    assert.match(fix, /需要产品决策/u)
    assert.match(renderFixReply(record(), 'succeeded'), /已完成/u)
  })
})

describe('FeishuStore', () => {
  it('starts disabled and validates incoming settings', async () => {
    const settings = await store()
    assert.equal(settings.config().enabled, false)
    assert.equal(settings.config().pollSeconds, 10)
    await assert.rejects(settings.updateConfig({ chatId: 'group-1' }), /oc_/u)
    await assert.rejects(settings.updateConfig({ pollSeconds: 1 }), /轮询间隔/u)
    await assert.rejects(settings.updateConfig({ webBaseUrl: 'ftp://x' }), /看板地址/u)
    await assert.rejects(settings.updateConfig({ proxy: 'socks://x' }), /代理/u)
  })

  it('persists settings and threads across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshw-feishu-'))
    roots.push(root)
    const file = join(root, 'feishu.json')
    const first = await FeishuStore.open(file)
    await first.updateConfig({
      enabled: true, chatId: 'oc_abc123', chatName: 'dshw · PR 进展', pollSeconds: 30,
      notify: { review: false }, webBaseUrl: 'http://127.0.0.1:3079/', proxy: 'http://proxy:3128',
    })
    await first.saveThread({
      key: 'demo/repo#41', title: 'PR #41 · demo/repo', rootMessageId: 'om_root', threadId: 'omt_1',
      seenMessageIds: ['om_a', 'om_b'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const second = await FeishuStore.open(file)
    const config = second.config()
    assert.equal(config.enabled, true)
    assert.equal(config.chatId, 'oc_abc123')
    assert.equal(config.pollSeconds, 30)
    assert.equal(config.notify.review, false)
    assert.equal(config.notify.fix, true)
    assert.equal(config.webBaseUrl, 'http://127.0.0.1:3079')
    assert.equal(second.thread('demo/repo#41')?.threadId, 'omt_1')
    assert.deepEqual(second.thread('demo/repo#41')?.seenMessageIds, ['om_a', 'om_b'])
  })

  it('never returns the stored proxy to the panel', async () => {
    const settings = await store()
    const host = {
      record: () => undefined,
      runReview: async () => {},
      startFix: async () => {},
      steerFix: async () => false,
      interpret: async () => ({ action: 'fix' as const, reply: '' }),
      pushFix: async () => {},
      fixHint: () => undefined,
      event: () => {},
    }
    const service = new FeishuService(settings, host)
    await service.updateConfig({ proxy: 'http://user:secret@proxy:3128' })
    assert.equal(service.publicConfig().hasProxy, true)
    assert.equal(service.publicConfig().proxy, undefined)
    // A masked echo from the panel keeps the stored proxy instead of clearing it.
    const before = service.publicConfig().hasProxy
    await service.updateConfig({ proxy: '***' })
    assert.equal(service.publicConfig().hasProxy, before)
  })
})
