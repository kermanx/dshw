import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { AutoReviewStore, autoReviewId } from '../src/auto-review.ts'
import { mergeReviewResults, modelProfileFor, piModelEntry } from '../src/review/engine.ts'
import { DEFAULT_REVIEW_MODEL, RECOMMENDED_REVIEW_MODELS } from '../src/auto-review.ts'
import { reviewExtensionSource } from '../src/review/extension.ts'
import { diffLineSets, parseCodeReview } from '../src/review/result.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshw-auto-review-'))
  roots.push(root)
  return root
}

/** One two-line hunk on stats.ts (new lines 1..3, old line 1). */
const PATCH = [
  'diff --git a/stats.ts b/stats.ts',
  '--- a/stats.ts',
  '+++ b/stats.ts',
  '@@ -1,1 +1,3 @@',
  ' const keep = 1',
  '+export function percentile(values: number[]): number {',
  '+  return values.sort()[0]!',
  '',
].join('\n')

describe('parseCodeReview', () => {
  it('anchors comments that land on changed lines', () => {
    const raw = JSON.stringify({
      summary: '一个排序问题',
      comments: [{ file: 'stats.ts', line: 2, line_type: 'new', severity: 'critical', message: 'sort 按字典序' }],
    })
    const parsed = parseCodeReview(raw, PATCH)
    assert.equal(parsed.summary, '一个排序问题')
    assert.equal(parsed.comments.length, 1)
    assert.equal(parsed.comments[0]?.locationValid, true)
    assert.equal(parsed.comments[0]?.line, 2)
  })

  it('keeps findings whose line is not in the diff, marked unverified', () => {
    const raw = JSON.stringify({
      summary: 's',
      comments: [{ file: 'stats.ts', line: 99, line_type: 'new', severity: 'warning', message: 'm' }],
    })
    const parsed = parseCodeReview(raw, PATCH)
    assert.equal(parsed.comments[0]?.locationValid, false)
  })

  it('accepts fenced JSON and fails malformed payloads', () => {
    const fenced = '```json\n' + JSON.stringify({ summary: 'ok', comments: [] }) + '\n```'
    assert.equal(parseCodeReview(fenced, PATCH).summary, 'ok')
    assert.throws(() => parseCodeReview('{"summary":"x","comments":[{"file":"../x"}]}', PATCH), /comments\[0\]/u)
    assert.throws(() => parseCodeReview('not json', PATCH))
  })

  it('collects the line numbers each diff side touches', () => {
    const sets = diffLineSets(PATCH)
    assert.deepEqual([...(sets.get('stats.ts')?.new ?? [])], [1, 2, 3])
    assert.deepEqual([...(sets.get('stats.ts')?.old ?? [])], [1])
  })
})

describe('reviewExtensionSource', () => {
  it('inlines the validator and emits runnable JavaScript', async () => {
    const source = await reviewExtensionSource()
    assert.match(source, /function validateReviewResult/u)
    assert.doesNotMatch(source, /__VALIDATION_SOURCE__/u)
    assert.doesNotMatch(source, /import type /u)
    assert.doesNotMatch(source, /: Promise<void>/u)
    // The module must parse as JavaScript (and keep its default export).
    assert.match(source, /export default function/u)
    const root = await temporary()
    const path = join(root, 'review-extension.mjs')
    await writeFile(path, source)
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' })
  })
})

describe('AutoReviewStore', () => {
  it('starts disabled with the benchmark reviewer defaults', async () => {
    const root = await temporary()
    const store = await AutoReviewStore.open({ file: join(root, 'auto-review.json'), secretFile: join(root, 'secrets.env'), userEnvFile: join(root, 'missing.env') })
    const config = store.config()
    assert.equal(config.enabled, false)
    assert.equal(config.scope, 'mine')
    assert.equal(config.model, 'anthropic/claude-opus-5.5')
    assert.equal(config.engineVersion, '0.85.1')
    assert.equal(config.autoFix, true)
  })

  it('validates and persists settings, including a saved key', async () => {
    const root = await temporary()
    const file = join(root, 'auto-review.json')
    const secretFile = join(root, 'secrets.env')
    const store = await AutoReviewStore.open({ file, secretFile, userEnvFile: join(root, 'missing.env') })
    const updated = await store.updateConfig({
      enabled: true, scope: 'all', debounceSeconds: 30, debounceMaxSeconds: 10,
      model: 'deepseek-v4-flash', baseUrl: 'https://example.test/v1/', apiKeyMode: 'value', apiKey: 'sk-test',
      autoFix: true, fixSeverity: 'critical', instructions: '  关注并发  ',
    })
    assert.equal(updated.enabled, true)
    assert.equal(updated.debounceMaxSeconds, 30)
    assert.equal(updated.baseUrl, 'https://example.test/v1')
    assert.equal(updated.instructions, '关注并发')
    assert.equal(updated.credentialSource, 'saved')
    assert.equal(store.apiKey(), 'sk-test')

    const reopened = await AutoReviewStore.open({ file, secretFile, userEnvFile: join(root, 'missing.env') })
    assert.equal(reopened.config().enabled, true)
    assert.equal(reopened.apiKey(), 'sk-test')

    await assert.rejects(reopened.updateConfig({ debounceSeconds: 1 }), /debounceSeconds/u)
    await assert.rejects(reopened.updateConfig({ baseUrl: 'ftp://x' }), /baseUrl/u)
    await assert.rejects(reopened.updateConfig({ apiKeyEnv: 'bad name' }), /环境变量名/u)
  })

  it('round-trips records and keeps only the newest ones', async () => {
    const root = await temporary()
    const store = await AutoReviewStore.open({ file: join(root, 'auto-review.json'), secretFile: join(root, 'secrets.env'), userEnvFile: join(root, 'missing.env') })
    const id = autoReviewId('demo/repo', 7)
    await store.saveRecord({
      id, repoSlug: 'demo/repo', number: 7, title: 'PR 7', url: 'https://github.com/demo/repo/pull/7',
      branch: 'feature', baseRefName: 'master', headOid: 'a'.repeat(40), baseOid: 'b'.repeat(40),
      observedHeadOid: 'a'.repeat(40), status: 'reviewed', trigger: 'auto', summary: 'ok',
      comments: [], counts: { critical: 0, warning: 0, suggestion: 0 }, updatedAt: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(store.records().length, 1)
    assert.equal(store.record(id)?.title, 'PR 7')
    assert.equal(await store.removeRecord(id), true)
    assert.equal(store.records().length, 0)
  })

  it('rejects a corrupted document instead of silently resetting it', async () => {
    const root = await temporary()
    const file = join(root, 'auto-review.json')
    await writeFile(file, JSON.stringify({ version: 1, config: { enabled: 'yes' } }))
    await assert.rejects(
      AutoReviewStore.open({ file, secretFile: join(root, 'secrets.env'), userEnvFile: join(root, 'missing.env') }),
      /enabled/u,
    )
  })
})

describe('parallel review merge', () => {
  const base = {
    status: 'completed' as const,
    engineVersion: '0.85.1',
    logTail: '',
    elapsedMs: 1,
    error: null,
  }
  const comment = (severity: 'critical' | 'warning' | 'suggestion', line: number, message: string) =>
    ({ file: 'stats.ts', line, lineType: 'new' as const, severity, message, locationValid: true })

  it('runs cc_bot\'s three default models', async () => {
    const { DEFAULT_REVIEW_MODELS } = await import('../src/auto-review.ts')
    assert.deepEqual(DEFAULT_REVIEW_MODELS, ['anthropic/claude-opus-5.5', 'openai/gpt-6-astra', 'deepseek-flash'])
  })

  it('de-duplicates the same location and keeps the most severe wording', () => {
    const merged = mergeReviewResults([
      { ...base, model: 'opus', summary: 'opus 的看法', comments: [comment('warning', 8, '边界问题')] },
      { ...base, model: 'gpt', summary: 'gpt 的看法', comments: [comment('critical', 8, '会抛异常'), comment('suggestion', 12, '可读性')] },
    ])
    assert.equal(merged.comments.length, 2)
    const atEight = merged.comments.find(entry => entry.line === 8)
    assert.equal(atEight?.severity, 'critical')
    assert.equal(atEight?.message, '会抛异常')
    assert.deepEqual(atEight?.models, ['opus', 'gpt'])
  })

  it('keeps one summary section per model', () => {
    const merged = mergeReviewResults([
      { ...base, model: 'opus', summary: 'A', comments: [] },
      { ...base, model: 'gpt', summary: 'B', comments: [] },
    ])
    assert.match(merged.summary, /### opus\nA/u)
    assert.match(merged.summary, /### gpt\nB/u)
    assert.equal(mergeReviewResults([{ ...base, model: 'opus', summary: 'A', comments: [] }]).summary, 'A')
  })

  it('adds up token usage across models', () => {
    const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 12, costUsd: 0.5, steps: 1 }
    const merged = mergeReviewResults([
      { ...base, model: 'opus', summary: '', comments: [], usage },
      { ...base, model: 'gpt', summary: '', comments: [], usage: { ...usage, costUsd: 0.25, steps: 2 } },
    ])
    assert.equal(merged.usage?.costUsd, 0.75)
    assert.equal(merged.usage?.steps, 3)
  })
})

describe('review model profiles', () => {
  it('ships the cc_bot default model menu', () => {
    assert.equal(RECOMMENDED_REVIEW_MODELS[0], 'anthropic/claude-opus-5.5')
    assert.ok(RECOMMENDED_REVIEW_MODELS.includes('openai/gpt-6-astra'))
    assert.ok(RECOMMENDED_REVIEW_MODELS.includes('deepseek-flash'))
    assert.equal(DEFAULT_REVIEW_MODEL, 'anthropic/claude-opus-5.5')
  })

  it('infers the gateway preset from the model id', () => {
    assert.equal(modelProfileFor('deepseek-v4-flash'), 'deepseek')
    assert.equal(modelProfileFor('anthropic/claude-opus-5'), 'anthropic')
    assert.equal(modelProfileFor('claude-opus-5'), 'anthropic')
    assert.equal(modelProfileFor('glm-5.3'), 'glm')
    assert.equal(modelProfileFor('gpt-5.1'), 'openai')
    assert.equal(modelProfileFor('gemini-2.5-pro'), 'openai')
  })

  it('keeps the DeepSeek protocol flags for the DeepSeek family', () => {
    const entry = piModelEntry('deepseek-v4-flash', 'deepseek') as { reasoning?: boolean, contextWindow?: number, compat?: Record<string, unknown> }
    assert.equal(entry.reasoning, true)
    assert.equal(entry.contextWindow, 1_024_000)
    assert.equal(entry.compat?.thinkingFormat, 'deepseek')
    assert.equal(entry.compat?.requiresReasoningContentOnAssistantMessages, true)
  })

  it('gives the Claude family cc_bot\'s 1M context and 128k output ceilings', () => {
    const entry = piModelEntry('anthropic/claude-opus-5.5', 'anthropic') as { contextWindow?: number, maxTokens?: number, compat?: Record<string, unknown> }
    assert.equal(entry.contextWindow, 1_000_000)
    assert.equal(entry.maxTokens, 128_000)
    assert.deepEqual(entry.compat, {})
  })

  it('drops the DeepSeek-specific compat for other families', () => {
    for (const [model, profile] of [['anthropic/claude-opus-5', 'anthropic'], ['glm-5.3', 'glm'], ['gpt-5.1', 'openai']] as const) {
      const entry = piModelEntry(model, profile) as { compat?: Record<string, unknown>, contextWindow?: number }
      assert.notEqual(entry.compat?.thinkingFormat, 'deepseek', `${profile} must not claim the deepseek thinking format`)
      assert.equal(entry.contextWindow, profile === 'anthropic' ? 1_000_000 : 200_000)
    }
    const claude = piModelEntry('claude-opus-5', 'anthropic') as { compat?: Record<string, unknown> }
    assert.deepEqual(claude.compat, {})
  })
})
