/**
 * Run the cc_bot review agent locally.
 *
 * dsh-dev-bench runs this reviewer inside a disposable DSec container
 * (`src/support/code-review/remote.ts`). dshw reviews pull requests that are
 * already cloned on this machine, so the same procedure runs in a throwaway
 * Git clone under the dshw data root instead:
 *
 *   clone (shared objects) → checkout the PR head → tag `cc_bot_base` at the
 *   merge base → install/locate Pi → run Pi with the review prompt and the
 *   read-only extension → collect `mr_review_result.json` → anchor comments
 *   against the captured diff.
 *
 * Everything the reviewer can see is this clone; the model key only travels in
 * the child environment. The run directory keeps the log and prompt after the
 * clone is removed, so a failed review stays diagnosable.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AUTO_REVIEW_ROOT } from '../config.ts'
import type { AutoReviewComment, AutoReviewModelProfile } from '../types.ts'
import { run, runOrThrow } from '../util.ts'
import { reviewExtensionSource } from './extension.ts'
import { piReviewPrompt } from './prompt.ts'
import { parseCodeReview } from './result.ts'

export type ReviewModelProfile = AutoReviewModelProfile

/**
 * Pick the protocol preset for a model id. The gateway serves every family
 * behind one OpenAI-compatible endpoint, but the per-family quirks (thinking
 * field, limits) still differ, so the id prefix decides the preset.
 */
export function modelProfileFor(model: string): ReviewModelProfile {
  const id = model.toLowerCase()
  if (id.includes('claude') || id.includes('anthropic/')) return 'anthropic'
  if (id.includes('gemini') || id.includes('gpt-') || id.includes('o3') || id.includes('o4')) return 'openai'
  if (id.includes('glm') || id.includes('zai')) return 'glm'
  return 'deepseek'
}

/** The `models.json` entry Pi needs for one model of the review gateway. */
export function piModelEntry(model: string, profile: ReviewModelProfile): Record<string, unknown> {
  const common = { id: model, name: model, input: ['text'] }
  if (profile === 'deepseek') {
    return {
      ...common,
      reasoning: true,
      contextWindow: 1_024_000,
      maxTokens: 131_072,
      compat: {
        supportsDeveloperRole: false,
        supportsLongCacheRetention: true,
        sendSessionAffinityHeaders: true,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek',
        supportsReasoningEffort: false,
      },
    }
  }
  if (profile === 'anthropic') {
    // cc_bot's config/pi/models.json declares 1M context / 128k output for the
    // opus/fable family; keep the same ceilings here.
    return {
      ...common,
      reasoning: false,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: {},
    }
  }
  if (profile === 'glm') {
    return {
      ...common,
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 32_000,
      compat: { thinkingFormat: 'zai' },
    }
  }
  return {
    ...common,
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 32_000,
    compat: { supportsDeveloperRole: false },
  }
}

/** Environment variable carrying the review model key into Pi. */
export const REVIEW_KEY_ENV = 'DSHW_REVIEW_API_KEY'
/** File the review agent must deliver (see the prompt and extension). */
const RESULT_FILE = 'mr_review_result.json'
/** Most log text kept in memory (the full log is always on disk). */
const LOG_TAIL_BYTES = 64 * 1024

/** Fixed instruction block describing a dshw pull request to the reviewer. */
export interface ReviewRequestContext {
  readonly repoSlug: string
  readonly prNumber: number
  readonly title: string
  readonly description: string
  /** User-supplied extra review instructions from the settings panel. */
  readonly instructions: string
}

/** Price per million tokens (USD), as Pi expects in `models.json`. */
export interface ReviewPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** Token + cost totals of one review run. */
export interface ReviewUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  /** Estimated cost in USD, from the configured prices. */
  costUsd: number
  /** Assistant turns (model calls) the run made. */
  steps: number
}

/** Everything one review run needs; assembled by the service. */
export interface ReviewRunInput extends ReviewRequestContext {
  /** Local dshw clone whose object database backs the review checkout. */
  readonly clonePath: string
  readonly baseOid: string
  readonly headOid: string
  /** Directory reserved for this run (log, prompt, checkout). */
  readonly runDir: string
  readonly model: string
  /** Gateway protocol preset; inferred from the model id when omitted. */
  readonly modelProfile?: ReviewModelProfile
  readonly baseUrl: string
  readonly apiKey: string
  readonly engineVersion: string
  readonly pricing?: ReviewPricing
  readonly timeoutSeconds: number
  readonly signal?: AbortSignal
  readonly onLog?: (chunk: string) => void
}

export interface ReviewRunResult {
  readonly status: 'completed' | 'error'
  readonly summary: string
  readonly comments: AutoReviewComment[]
  readonly error: string | null
  readonly elapsedMs: number
  readonly model: string
  readonly engineVersion: string
  readonly logTail: string
  /** Token usage and estimated cost; absent when the engine wrote no session. */
  readonly usage?: ReviewUsage
  /** Run log kept for diagnosis. */
  readonly logPath?: string
}

/** Everything a parallel review batch needs; `runDir` holds one sub-run per model. */
export interface ReviewBatchInput extends Omit<ReviewRunInput, 'model' | 'pricing'> {
  readonly models: string[]
  /** Prices per model (the gateway has no pricing endpoint). */
  readonly pricingFor?: (model: string) => ReviewPricing | undefined
}

/** Merged result of reviewing one PR with several models in parallel. */
export interface ReviewBatchResult {
  readonly status: 'completed' | 'error'
  readonly summary: string
  readonly comments: AutoReviewComment[]
  readonly error: string | null
  /** Models that failed, while at least one other model succeeded. */
  readonly failures: Array<{ model: string, error: string }>
  readonly elapsedMs: number
  readonly models: string[]
  readonly engineVersion: string
  readonly logTail: string
  readonly usage?: ReviewUsage
  readonly logPath?: string
}

/** Checkout directory reserved for one review run. */
function checkoutDir(runDir: string): string {
  return join(runDir, 'checkout')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Redact the model key from anything that may leave the process. */
function redactor(key: string): (text: string) => string {
  return (text: string) => (key === '' ? text : text.split(key).join('[REDACTED]'))
}

/**
 * Locate the pinned Pi runtime for the reviewer, installing it once.
 *
 * `DSHW_REVIEW_ENGINE_DIR` points at an existing installation (useful offline,
 * or to reuse the cache dsh-dev-bench already created); otherwise the package
 * is installed into the dshw data root.
 */
export async function ensureReviewEngine(engineVersion: string, onLog?: (chunk: string) => void): Promise<string> {
  const override = process.env.DSHW_REVIEW_ENGINE_DIR
  if (override !== undefined && override !== '') {
    const root = resolve(override)
    const cli = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (!await exists(cli)) throw new Error(`DSHW_REVIEW_ENGINE_DIR 中没有 @earendil-works/pi-coding-agent：${root}`)
    return root
  }
  return await installReviewEngine(engineVersion, onLog)
}

async function installReviewEngine(engineVersion: string, onLog?: (chunk: string) => void): Promise<string> {
  const root = join(AUTO_REVIEW_ROOT, 'engine', `pi-${engineVersion}`)
  const cli = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
  if (await exists(cli)) return root
  onLog?.(`正在安装评审引擎 @earendil-works/pi-coding-agent@${engineVersion}…\n`)
  await mkdir(root, { recursive: true })
  const result = await run('npm', [
    'install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund',
    `@earendil-works/pi-coding-agent@${engineVersion}`,
  ], { timeoutMs: 10 * 60 * 1000 })
  if (result.code !== 0) {
    throw new Error(`评审引擎安装失败（需要能访问 npm registry，或用 DSHW_REVIEW_ENGINE_DIR 指定已有安装）：${result.stderr.slice(-600)}`)
  }
  if (!await exists(cli)) throw new Error(`评审引擎安装后缺少入口：${cli}`)
  return root
}

/** Expand the review prompt with the pull-request context. */
export function renderReviewPrompt(input: ReviewRequestContext): string {
  const context = [
    `**仓库**: ${input.repoSlug}`,
    `**标题**: ${input.title}`,
    `**描述**:\n${input.description === '' ? '（PR 没有描述）' : input.description}`,
    `这是一次针对 Pull Request #${String(input.prNumber)} 的自动评审。只评审 \`cc_bot_base..HEAD\` 的改动。`,
    input.instructions.trim() === '' ? '' : `## 额外审查指令\n${input.instructions.trim()}`,
  ].filter(Boolean).join('\n\n')
  return piReviewPrompt
    .replace(/^---\n[\s\S]*?\n---\n/u, '')
    .replace('$ARGUMENTS', () => context)
}

/**
 * Collect repository instructions that scope the reviewed files.
 *
 * Mirrors the benchmark worker: `AGENTS.md`/`REVIEW.md` files from the changed
 * files' directories (deepest first) constrain their own subtree only, and the
 * whole block is capped so it cannot dominate the prompt.
 */
export async function scopedReviewInstructions(workspace: string, changedFiles: readonly string[]): Promise<string> {
  const directories = new Set<string>()
  for (const file of changedFiles) {
    let directory = dirname(file)
    while (true) {
      directories.add(directory)
      if (directory === '.') break
      directory = dirname(directory)
    }
  }
  const root = await realpath(workspace)
  const parts: string[] = []
  let size = 0
  for (const directory of [...directories].sort((left, right) => right.split('/').length - left.split('/').length || left.localeCompare(right))) {
    for (const name of ['AGENTS.md', 'REVIEW.md']) {
      const path = join(workspace, directory, name)
      if (!await exists(path)) continue
      const real = await realpath(path)
      if (!real.startsWith(root + '/') || !(await lstat(real)).isFile()) continue
      const content = await readFile(real)
      const text = content.subarray(0, 16 * 1024).toString('utf8').trim()
      if (text === '') continue
      const section = `#### 目录 \`${directory}\` — \`${join(directory, name)}\`\n${text}${content.length > 16 * 1024 ? '\n... (truncated)' : ''}`
      size += Buffer.byteLength(section)
      if (size > 32 * 1024) return parts.join('\n\n') + '\n... (additional instruction files truncated)'
      parts.push(section)
    }
  }
  return parts.length === 0
    ? ''
    : '以下仓库规则仅约束所标目录及其子目录；更深目录优先，同目录共同生效。\n' + parts.join('\n\n')
}

/** Create the isolated review checkout and tag its base commit. */
export async function prepareReviewCheckout(input: ReviewRunInput, workspace: string, onLog?: (chunk: string) => void): Promise<{ mergeBase: string, patch: string }> {
  await mkdir(dirname(workspace), { recursive: true })
  onLog?.('正在准备评审工作区…\n')
  await runOrThrow('git', ['clone', '--quiet', '--shared', '--no-checkout', input.clonePath, workspace], { timeoutMs: 5 * 60 * 1000 })
  await runOrThrow('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', input.headOid], { cwd: workspace })
  const mergeBase = (await runOrThrow('git', ['merge-base', input.baseOid, input.headOid], { cwd: workspace })).stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(mergeBase)) throw new Error('无法确定评审基准提交')
  await runOrThrow('git', ['tag', '--force', 'cc_bot_base', mergeBase], { cwd: workspace })
  // The result file must never round-trip through the checkout.
  await writeFile(join(workspace, '.git', 'info', 'exclude'), `${RESULT_FILE}\n`)
  const patch = (await runOrThrow('git', [
    'diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', mergeBase, input.headOid, '--',
  ], { cwd: workspace, timeoutMs: 5 * 60 * 1000 })).stdout
  return { mergeBase, patch }
}

/**
 * Review one PR with several models in parallel and merge the findings.
 *
 * Mirrors cc_bot's default policy (`pi/opus-5.5` + `codex/gpt-6-astra` +
 * `pi/deepseek-flash`): each model gets its own directory and its own checkout,
 * then the findings are de-duplicated by location, keeping the most severe.
 */
export async function runReviews(input: ReviewBatchInput): Promise<ReviewBatchResult> {
  const startedAt = Date.now()
  const models = input.models.length > 0 ? input.models : ['deepseek-flash']
  const settled = await Promise.allSettled(models.map(async (model, index) => {
    const runDir = join(input.runDir, `${String(index + 1)}-${model.replace(/[^a-zA-Z0-9]+/gu, '-')}`)
    const pricing = input.pricingFor?.(model)
    return await runReview({ ...input, model, runDir, ...(pricing === undefined ? {} : { pricing }) })
  }))
  const results: ReviewRunResult[] = []
  const failures: Array<{ model: string, error: string }> = []
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') results.push(entry.value)
    else failures.push({ model: models[index]!, error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) })
  })
  for (const result of results) {
    if (result.status === 'error') failures.push({ model: result.model, error: result.error ?? '未知错误' })
  }
  const merged = mergeReviewResults(results)
  const logTail = [
    ...results.map(result => `=== ${result.model} ===\n${result.logTail}`),
    ...failures.map(failure => `=== ${failure.model} (失败) ===\n${failure.error}`),
  ].join('\n')
  const usage = merged.usage
  const status = results.some(result => result.status === 'completed') ? 'completed' : 'error'
  const error = status === 'completed'
    ? (failures.length === 0 ? null : `部分模型失败：${failures.map(failure => `${failure.model}（${failure.error}）`).join('；')}`)
    : (failures[0]?.error ?? '全部评审模型失败')
  return {
    status,
    summary: merged.summary,
    comments: merged.comments,
    error,
    failures,
    elapsedMs: Date.now() - startedAt,
    models,
    engineVersion: results[0]?.engineVersion ?? input.engineVersion,
    logTail,
    ...(usage === undefined ? {} : { usage }),
    logPath: await writeLog(input.runDir, [logTail], text => text),
  }
}

/**
 * Merge per-model results: one summary section per model, findings de-duplicated
 * by location with the most severe wording kept.
 */
export function mergeReviewResults(results: readonly ReviewRunResult[]): {
  summary: string
  comments: AutoReviewComment[]
  usage?: ReviewUsage
} {
  const successes = results.filter(result => result.status === 'completed')
  const rank: Record<string, number> = { suggestion: 0, warning: 1, critical: 2 }
  const byLocation = new Map<string, AutoReviewComment>()
  for (const result of successes) {
    for (const comment of result.comments) {
      const key = `${comment.file}#${comment.lineType}#${String(comment.line ?? '')}-${String(comment.lineEnd ?? '')}`
      const previous = byLocation.get(key)
      if (previous === undefined) {
        byLocation.set(key, { ...comment, models: [result.model] })
        continue
      }
      const models = [...(previous.models ?? []), result.model].filter((model, index, all) => all.indexOf(model) === index)
      if ((rank[comment.severity] ?? 0) > (rank[previous.severity] ?? 0)) {
        byLocation.set(key, { ...comment, models })
      } else {
        previous.models = models
      }
    }
  }
  const summary = successes.length === 0
    ? ''
    : successes.length === 1
      ? successes[0]!.summary
      : successes.map(result => `### ${result.model}\n${result.summary.trim()}`).join('\n\n').slice(0, 4_000)
  const usage = successes.reduce<ReviewUsage | undefined>((total, result) => {
    if (result.usage === undefined) return total
    if (total === undefined) return { ...result.usage }
    return {
      input: total.input + result.usage.input,
      output: total.output + result.usage.output,
      cacheRead: total.cacheRead + result.usage.cacheRead,
      cacheWrite: total.cacheWrite + result.usage.cacheWrite,
      totalTokens: total.totalTokens + result.usage.totalTokens,
      costUsd: total.costUsd + result.usage.costUsd,
      steps: total.steps + result.usage.steps,
    }
  }, undefined)
  return {
    summary,
    comments: [...byLocation.values()],
    ...(usage === undefined ? {} : { usage }),
  }
}

/** Run the review agent once and return its anchored findings. */
export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const startedAt = Date.now()
  const redact = redactor(input.apiKey)
  let logTail = ''
  let summary = ''
  let comments: AutoReviewComment[] = []
  let usage: ReviewUsage | undefined
  let error: string | null = null
  const workspace = checkoutDir(input.runDir)
  const log: string[] = []
  const append = (chunk: string): void => {
    log.push(chunk)
    logTail = (logTail + chunk).slice(-LOG_TAIL_BYTES)
    input.onLog?.(chunk)
  }
  try {
    if (!/^\S+$/u.test(input.apiKey)) throw new Error('缺少评审模型 API Key')
    await mkdir(input.runDir, { recursive: true })
    const { patch } = await prepareReviewCheckout(input, workspace, append)
    if (patch.trim() === '') {
      const finishedAt = Date.now() - startedAt
      append('本次 PR 没有代码改动，未调用评审模型。\n')
      return {
        status: 'completed', summary: '本次 PR 没有代码改动，未调用评审模型。', comments: [], error: null,
        elapsedMs: finishedAt, model: input.model, engineVersion: input.engineVersion, logTail: redact(logTail),
        logPath: await writeLog(input.runDir, log, redact),
      }
    }
    const changed = (await runOrThrow('git', ['diff', '--name-only', 'cc_bot_base..HEAD'], { cwd: workspace })).stdout
      .split('\n').filter(Boolean)
    const instructions = await scopedReviewInstructions(workspace, changed)
    await writeReviewRuntime(input, workspace, instructions, redact, append)

    const engineRoot = await ensureReviewEngine(input.engineVersion, append)
    const cli = join(engineRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    if (!await exists(cli)) throw new Error(`找不到评审引擎入口：${cli}`)
    append(`正在运行评审引擎 ${input.engineVersion}（模型 ${input.model}）…\n`)
    const exitCode = await runPiReview({
      cli, workspace, input, redact, append,
    })
    const resultPath = join(workspace, RESULT_FILE)
    let raw: string | null = null
    if (await exists(resultPath)) {
      const state = await lstat(resultPath)
      if (!state.isFile() || state.isSymbolicLink()) throw new Error('评审结果必须是普通文件')
      if (state.size > 8 * 1024 * 1024) throw new Error('评审结果超过 8 MiB')
      raw = redact(await readFile(resultPath, 'utf8'))
    }
    usage = await readSessionUsage(join(input.runDir, 'sessions'))
    if (exitCode !== 0) throw new Error(`评审引擎退出码 ${String(exitCode)}`)
    if (raw === null || raw.trim() === '') throw new Error('评审引擎没有写出 mr_review_result.json')
    const parsed = parseCodeReview(raw, patch)
    summary = parsed.summary
    comments = parsed.comments
  } catch (cause) {
    error = redact(cause instanceof Error ? cause.message : String(cause))
    append(`\n评审失败：${error}\n`)
  } finally {
    if (process.env.DSHW_REVIEW_KEEP !== '1') await rm(workspace, { force: true, recursive: true })
  }
  return {
    status: error === null ? 'completed' : 'error',
    summary,
    comments,
    error,
    elapsedMs: Date.now() - startedAt,
    model: input.model,
    engineVersion: input.engineVersion,
    logTail: redact(logTail),
    ...(usage === undefined ? {} : { usage }),
    logPath: await writeLog(input.runDir, log, redact),
  }
}

/**
 * Sum the usage Pi recorded in its session log.
 *
 * Pi writes one JSONL per run under `--session-dir`; assistant messages carry
 * `usage` with token counts and the cost it computed from `models.json`.
 * Reading the newest file after the exit keeps this out of the model's output.
 */
export async function readSessionUsage(sessionDir: string): Promise<ReviewUsage | undefined> {
  let newest: { path: string, mtime: number } | undefined
  try {
    for (const entry of await readdir(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(sessionDir, entry.name)
      const mtime = (await stat(path)).mtimeMs
      if (newest === undefined || mtime > newest.mtime) newest = { path, mtime }
    }
  } catch {
    return undefined
  }
  if (newest === undefined) return undefined
  const usage: ReviewUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0, steps: 0 }
  let text: string
  try {
    text = await readFile(newest.path, 'utf8')
  } catch {
    return undefined
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row: { type?: unknown, message?: { role?: unknown, usage?: Record<string, unknown>, cost?: Record<string, unknown> } }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }
    if (row.type !== 'message' || row.message?.role !== 'assistant') continue
    const entry = row.message.usage
    if (entry === undefined || entry === null) continue
    const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    usage.input += number(entry.input)
    usage.output += number(entry.output)
    usage.cacheRead += number(entry.cacheRead)
    usage.cacheWrite += number(entry.cacheWrite)
    usage.totalTokens += number(entry.totalTokens)
    const cost = entry.cost as Record<string, unknown> | undefined
    usage.costUsd += number(cost?.total)
    usage.steps += 1
  }
  return usage.totalTokens === 0 && usage.costUsd === 0 ? undefined : usage
}

/** Persist the run log next to the run directory (best effort). */
async function writeLog(runDir: string, log: readonly string[], redact: (text: string) => string): Promise<string | undefined> {
  try {
    const path = join(runDir, 'review.log')
    await writeFile(path, redact(log.join('')))
    return path
  } catch {
    return undefined
  }
}

/** Write the Pi configuration, prompt and extension for one run. */
async function writeReviewRuntime(
  input: ReviewRunInput,
  workspace: string,
  instructions: string,
  redact: (text: string) => string,
  append: (chunk: string) => void,
): Promise<void> {
  const piHome = join(input.runDir, 'pi')
  await mkdir(piHome, { recursive: true })
  // Protocol settings copied from cc_bot's config/pi/models.json.
  const models = {
    providers: {
      'dshw-review': {
        baseUrl: input.baseUrl,
        api: 'openai-completions',
        apiKey: `$${REVIEW_KEY_ENV}`,
        compat: {
          supportsDeveloperRole: false,
          supportsLongCacheRetention: true,
          sendSessionAffinityHeaders: true,
          requiresReasoningContentOnAssistantMessages: true,
        },
        models: [{
          ...piModelEntry(input.model, input.modelProfile ?? modelProfileFor(input.model)),
          ...(input.pricing === undefined ? {} : {
            cost: {
              input: input.pricing.input,
              output: input.pricing.output,
              cacheRead: input.pricing.cacheRead ?? input.pricing.input,
              cacheWrite: input.pricing.cacheWrite ?? input.pricing.input,
            },
          }),
        }],
      },
    },
  }
  await writeFile(join(piHome, 'models.json'), JSON.stringify(models))
  const extension = await reviewExtensionSource()
  const extensionPath = join(input.runDir, 'review-extension.mjs')
  await writeFile(extensionPath, extension)
  const prompt = renderReviewPrompt({ ...input, instructions })
  await writeFile(join(input.runDir, 'prompt.txt'), prompt)
  const report = [
    `workspace=${workspace}`,
    `extension=${extensionPath}`,
    `instructions=${instructions === '' ? '(none)' : String(Buffer.byteLength(instructions)) + ' bytes'}`,
  ].join('\n')
  append(`评审上下文：\n${redact(report)}\n`)
}

/** Spawn Pi for one review; resolves with its exit code. */
async function runPiReview(options: {
  cli: string
  workspace: string
  input: ReviewRunInput
  redact: (text: string) => string
  append: (chunk: string) => void
}): Promise<number | null> {
  const { cli, workspace, input, redact, append } = options
  const child = spawn(process.execPath, [
    cli,
    '--print', '--mode', 'text',
    '--provider', 'dshw-review',
    '--model', input.model,
    '--tools', 'read,grep,bash,find,ls,edit,write',
    '--approve',
    '--no-extensions', '--no-prompt-templates',
    '--extension', join(input.runDir, 'review-extension.mjs'),
    '--session-dir', join(input.runDir, 'sessions'),
  ], {
    cwd: workspace,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(input.runDir, 'pi'),
      [REVIEW_KEY_ENV]: input.apiKey,
      NODE_USE_ENV_PROXY: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const record = (data: Buffer): void => { append(redact(data.toString('utf8'))) }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  child.stdin.on('error', () => { /* an early CLI failure surfaces through the exit status */ })
  child.stdin.end(await readFile(join(input.runDir, 'prompt.txt')))
  const kill = (): void => {
    try {
      if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { /* already exited */ }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, input.timeoutSeconds * 1000)
  const abort = (): void => { kill() }
  input.signal?.addEventListener('abort', abort, { once: true })
  try {
    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', code => resolvePromise(code))
    })
    if (timedOut) throw new Error(`评审超过 ${String(input.timeoutSeconds)} 秒，已终止`)
    if (input.signal?.aborted === true) throw new Error('评审已取消')
    return exitCode
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
  }
}
