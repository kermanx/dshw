/**
 * PR Auto Reviewer: persisted settings + records, and the commit-observation
 * rules that decide when a pull request is due for a fresh review.
 *
 * The daemon owns the clock: {@link observePrCommits} only updates records from
 * a fresh dashboard snapshot, and {@link dueReviews} is what the 5 s tick asks
 * for. Keeping both pure makes the debounce rules testable without a daemon.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { AUTO_REVIEW_DEBOUNCE_MAX_SECONDS, AUTO_REVIEW_DEBOUNCE_SECONDS, AUTO_REVIEW_FILE, AUTO_REVIEW_SECRET_FILE } from './config.ts'
import type {
  ApiKeyMode, AutoReviewComment, AutoReviewConfig, AutoReviewConfigInput, AutoReviewFix, AutoReviewRecord,
  AutoReviewSeverity, CredentialSource, JobStatus, PrDashboardRecord,
} from './types.ts'
import { now, readJson, writeJsonAtomic } from './util.ts'

/** Secret file key holding the review model key (one key for the feature). */
const SECRET_NAME = 'AUTO_REVIEW_API_KEY'
/** Records kept on disk; older ones are dropped so the file cannot grow forever. */
const MAX_RECORDS = 50
/** Consecutive automatic fix sessions allowed for one PR before dshw stops. */
export const MAX_AUTO_FIX_ROUNDS = 3
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u

interface AutoReviewDocument {
  version: 1
  config?: StoredAutoReviewConfig
  records?: AutoReviewRecord[]
}

type StoredAutoReviewConfig = Omit<AutoReviewConfig, 'hasApiKey' | 'credentialSource' | 'apiKeyMode'> & { apiKeyMode?: ApiKeyMode }

/** The review models cc_bot runs by default, mapped to gateway ids. */
export const RECOMMENDED_REVIEW_MODELS = [
  'anthropic/claude-opus-5.5',
  'openai/gpt-6-astra',
  'deepseek-flash',
  'anthropic/claude-fable-5.1',
  'gemini-4-argon',
  'anthropic/claude-opus-5',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.6',
  'gpt-5.6-sol',
] as const

/** The three reviewers cc_bot runs in parallel, mapped to gateway ids. */
export const DEFAULT_REVIEW_MODELS: readonly string[] = [
  'anthropic/claude-opus-5.5',
  'openai/gpt-6-astra',
  'deepseek-flash',
]

/** Primary model, matching cc_bot's first default (`pi/opus-5.5`). */
export const DEFAULT_REVIEW_MODEL: string = DEFAULT_REVIEW_MODELS[0]!

/** Defaults shown on a fresh install; the model block mirrors cc_bot's default policy. */
export function defaultAutoReviewConfig(): StoredAutoReviewConfig {
  return {
    enabled: false,
    scope: 'mine',
    debounceSeconds: AUTO_REVIEW_DEBOUNCE_SECONDS,
    debounceMaxSeconds: AUTO_REVIEW_DEBOUNCE_MAX_SECONDS,
    models: [...DEFAULT_REVIEW_MODELS],
    model: DEFAULT_REVIEW_MODEL,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://llm.modelhub.online/v1',
    apiKeyMode: 'environment',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    engineVersion: '0.85.1',
    timeoutSeconds: 900,
    autoFix: true,
    fixSeverity: 'warning',
    instructions: '',
  }
}

/** Identity of the single record a PR owns. */
export function autoReviewId(repoSlug: string, number: number): string {
  return `${repoSlug}#${String(number)}`
}

/** Severity totals used by the list view and the auto-fix gate. */
export function countSeverities(comments: readonly AutoReviewComment[]): AutoReviewRecord['counts'] {
  const counts = { critical: 0, warning: 0, suggestion: 0 }
  for (const comment of comments) counts[comment.severity] += 1
  return counts
}

/**
 * Whether a review should start/drive an automatic fix session.
 *
 * A fix is started at most once per reviewed head (a rerun of the same head
 * does not restart it) and at most {@link MAX_AUTO_FIX_ROUNDS} times per PR.
 */
export function shouldAutoFix(record: AutoReviewRecord, config: AutoReviewConfig): boolean {
  if (!config.enabled || !config.autoFix || record.status !== 'reviewed') return false
  if ((record.fixRounds ?? 0) >= MAX_AUTO_FIX_ROUNDS) return false
  if (record.fix !== undefined && record.fix.headOid === record.reviewedHeadOid && record.fix.status === 'running') return false
  if (record.fix !== undefined && record.fix.headOid === record.reviewedHeadOid) return false
  const counts = record.counts
  return config.fixSeverity === 'critical' ? counts.critical > 0 : counts.critical + counts.warning > 0
}

/** Scope check for "which PRs does this feature watch". */
export function inAutoReviewScope(pr: PrDashboardRecord, config: AutoReviewConfig): boolean {
  if (config.scope === 'all') return true
  if (config.scope === 'assigned') return pr.assignedToMe === true
  return pr.assignedToMe !== true
}

/**
 * Fold a fresh dashboard snapshot into the records.
 *
 * The first sighting of a PR only records its head: enabling the feature does
 * not start a burst of reviews for branches that already existed. Later heads
 * enter a debounce cycle whose deadline is pushed forward by each new commit
 * but never past `debounceMaxSeconds` after the first one.
 *
 * @returns the records whose state changed (callers persist/broadcast once).
 */
export function observePrCommits(
  records: Map<string, AutoReviewRecord>,
  prs: readonly PrDashboardRecord[],
  config: AutoReviewConfig,
  nowMs: number,
): AutoReviewRecord[] {
  if (!config.enabled) return []
  const changed: AutoReviewRecord[] = []
  for (const pr of prs) {
    if (pr.headOid === undefined || pr.headOid === '' || pr.isDraft) continue
    if (!inAutoReviewScope(pr, config)) continue
    const id = autoReviewId(pr.repoSlug, pr.number)
    const head = pr.headOid
    const timestamp = new Date(nowMs).toISOString()
    let record = records.get(id)
    if (record === undefined) {
      record = {
        id,
        repoSlug: pr.repoSlug,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        branch: pr.branch,
        baseRefName: pr.baseRefName,
        ...(pr.author === undefined ? {} : { author: pr.author }),
        headOid: head,
        baseOid: pr.baseOid ?? '',
        observedHeadOid: head,
        status: 'idle',
        trigger: 'auto',
        summary: '',
        comments: [],
        counts: { critical: 0, warning: 0, suggestion: 0 },
        updatedAt: timestamp,
      }
      records.set(id, record)
      changed.push(record)
      continue
    }
    let dirty = false
    if (record.observedHeadOid !== head) {
      record.observedHeadOid = head
      record.title = pr.title
      record.url = pr.url
      record.branch = pr.branch
      record.baseRefName = pr.baseRefName
      if (pr.baseOid !== undefined) record.baseOid = pr.baseOid
      dirty = true
      if (record.status !== 'running') {
        const firstPending = record.pendingSince === undefined ? nowMs : Date.parse(record.pendingSince)
        record.pendingSince = new Date(firstPending).toISOString()
        const deadline = Math.min(nowMs + config.debounceSeconds * 1000, firstPending + config.debounceMaxSeconds * 1000)
        record.dueAt = new Date(deadline).toISOString()
        record.status = 'pending'
        record.trigger = 'auto'
        record.skippedReason = undefined
      }
    }
    if (dirty) {
      record.updatedAt = timestamp
      changed.push(record)
    }
  }
  return changed
}

/** Records whose debounce deadline has passed and that are not already running. */
export function dueReviews(records: Iterable<AutoReviewRecord>, nowMs: number): AutoReviewRecord[] {
  const due: AutoReviewRecord[] = []
  for (const record of records) {
    if (record.status !== 'pending') continue
    if (record.dueAt === undefined || Date.parse(record.dueAt) > nowMs) continue
    due.push(record)
  }
  return due
}

/** Render the findings handed to the fix session (markdown, grouped by file). */
export function formatFindings(record: AutoReviewRecord): string {
  const lines: string[] = []
  if (record.summary.trim() !== '') lines.push(record.summary.trim(), '')
  if (record.comments.length === 0) return lines.join('\n')
  const byFile = new Map<string, AutoReviewComment[]>()
  for (const comment of record.comments) {
    byFile.set(comment.file, [...(byFile.get(comment.file) ?? []), comment])
  }
  const order: Record<AutoReviewSeverity, number> = { critical: 0, warning: 1, suggestion: 2 }
  for (const [file, comments] of [...byFile.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### \`${file}\``)
    for (const comment of [...comments].sort((left, right) => (left.line ?? left.lineStart ?? 0) - (right.line ?? right.lineStart ?? 0))) {
      const line = comment.line ?? comment.lineStart ?? comment.fallbackLine
      const range = comment.lineStart !== undefined && comment.lineEnd !== undefined
      const where = line === undefined ? '' : range ? `:${String(line)}-${String(comment.lineEnd)}` : `:${String(line)}`
      const side = comment.lineType === 'old' ? '（删除行）' : ''
      const anchor = comment.locationValid ? '' : '（模型未能定位到 diff，行号仅供参考）'
      lines.push(`- [${comment.severity}] ${file}${where}${side}${anchor}`)
      for (const row of comment.message.trim().split('\n')) lines.push(`  ${row}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** Persisted settings plus the review records of every tracked PR. */
export class AutoReviewStore {
  #config: StoredAutoReviewConfig
  #records = new Map<string, AutoReviewRecord>()
  #secret: string | undefined
  #harnessUserEnv: Record<string, string> = {}
  readonly #file: string
  readonly #secretFile: string

  private constructor(file: string, secretFile: string, config: StoredAutoReviewConfig) {
    this.#file = file
    this.#secretFile = secretFile
    this.#config = config
  }

  static async open(paths: { file?: string, secretFile?: string, userEnvFile?: string } = {}): Promise<AutoReviewStore> {
    const file = paths.file ?? AUTO_REVIEW_FILE
    const secretFile = paths.secretFile ?? AUTO_REVIEW_SECRET_FILE
    const document = await readJson<AutoReviewDocument>(file)
    if (document !== undefined && document.version !== 1) throw new Error('auto-review 配置文件版本无效')
    const config = validateStoredConfig(document?.config)
    const store = new AutoReviewStore(file, secretFile, config)
    for (const record of document?.records ?? []) {
      if (typeof record?.id === 'string' && typeof record.repoSlug === 'string' && typeof record.number === 'number') {
        store.#records.set(record.id, validateRecord(record))
      }
    }
    const secrets = await readSecrets(secretFile)
    store.#secret = secrets[SECRET_NAME]
    store.#harnessUserEnv = await readSecrets(paths.userEnvFile ?? join(homedir(), '.dsh', '.env'))
    return store
  }

  /** Public view of the settings, with credential source resolved. */
  config(): AutoReviewConfig {
    return {
      ...this.#config,
      apiKeyMode: this.#config.apiKeyMode ?? 'environment',
      hasApiKey: this.apiKey() !== undefined,
      credentialSource: this.#credentialSource(),
    }
  }

  /** Resolve the model key: saved value, then process env, then the harness user env. */
  apiKey(): string | undefined {
    if (this.#config.apiKeyMode === 'value') return this.#secret === undefined || this.#secret === '' ? undefined : this.#secret
    const name = this.#config.apiKeyEnv
    if (name === undefined) return undefined
    const fromEnv = process.env[name]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    const fromHarness = this.#harnessUserEnv[name]
    return fromHarness === undefined || fromHarness === '' ? undefined : fromHarness
  }

  async updateConfig(input: AutoReviewConfigInput): Promise<AutoReviewConfig> {
    const next: StoredAutoReviewConfig = {
      ...this.#config,
      ...optionalBoolean('enabled', input.enabled),
      ...optionalScope(input.scope),
      ...optionalNumber('debounceSeconds', input.debounceSeconds, 10, 3_600),
      ...optionalNumber('debounceMaxSeconds', input.debounceMaxSeconds, 10, 24 * 3_600),
      ...optionalModels(input),
      ...optionalModelProfile(input.modelProfile),
      ...optionalUrl('baseUrl', input.baseUrl),
      ...optionalNumber('timeoutSeconds', input.timeoutSeconds, 30, 24 * 3_600),
      ...optionalBoolean('autoFix', input.autoFix),
      ...optionalFixSeverity(input.fixSeverity),
      ...optionalWorker(input.workerConfigId),
      ...(input.instructions === undefined ? {} : { instructions: cleanText(input.instructions) }),
      ...optionalEngineVersion(input.engineVersion),
    }
    next.apiKeyMode = apiKeyMode(input.apiKeyMode ?? (typeof input.apiKey === 'string' && input.apiKey.trim() !== '' ? 'value' : next.apiKeyMode ?? 'environment'))
    const envName = input.apiKeyEnv === undefined ? undefined : cleanEnv(input.apiKeyEnv)
    if (envName !== undefined) {
      if (envName === '') delete next.apiKeyEnv
      else next.apiKeyEnv = envName
    }
    if (next.debounceMaxSeconds < next.debounceSeconds) next.debounceMaxSeconds = next.debounceSeconds
    if (next.apiKeyMode === 'environment' && next.apiKeyEnv === undefined) next.apiKeyEnv = 'DEEPSEEK_API_KEY'
    const value = input.apiKey?.trim()
    if (next.apiKeyMode === 'value' && value !== undefined && value !== '') {
      this.#secret = value
      await this.#saveSecrets()
    }
    if (next.apiKeyMode === 'environment') {
      this.#secret = undefined
      await this.#saveSecrets()
    }
    this.#config = next
    await this.#save()
    return this.config()
  }

  records(): AutoReviewRecord[] {
    return [...this.#records.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id))
  }

  record(id: string): AutoReviewRecord | undefined {
    return this.#records.get(id)
  }

  /** Insert or replace one record (the scheduler mutates objects in place, then calls this). */
  async saveRecord(record: AutoReviewRecord): Promise<void> {
    this.#records.set(record.id, record)
    await this.#save()
  }

  /** Drop a record and its history (the PR itself is untouched). */
  async removeRecord(id: string): Promise<boolean> {
    const removed = this.#records.delete(id)
    if (removed) await this.#save()
    return removed
  }

  /** Reset every review record, keeping the settings. */
  async clearRecords(): Promise<void> {
    this.#records.clear()
    await this.#save()
  }

  /** Attach or replace the fix session of a record. */
  async attachFix(id: string, fix: AutoReviewFix | undefined, options: { incrementRound?: boolean } = {}): Promise<AutoReviewRecord | undefined> {
    const record = this.#records.get(id)
    if (record === undefined) return undefined
    if (fix === undefined) delete record.fix
    else record.fix = fix
    if (options.incrementRound === true) record.fixRounds = (record.fixRounds ?? 0) + 1
    record.updatedAt = now()
    await this.#save()
    return record
  }

  #credentialSource(): CredentialSource {
    if (this.#config.apiKeyMode === 'value') return this.#secret === undefined || this.#secret === '' ? 'missing' : 'saved'
    const name = this.#config.apiKeyEnv
    if (name === undefined) return 'missing'
    if ((process.env[name] ?? '') !== '') return 'environment'
    if ((this.#harnessUserEnv[name] ?? '') !== '') return 'local'
    return 'missing'
  }

  async #save(): Promise<void> {
    const records = [...this.#records.values()]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, MAX_RECORDS)
    this.#records = new Map(records.map(record => [record.id, record]))
    await writeJsonAtomic(this.#file, { version: 1, config: this.#config, records } satisfies AutoReviewDocument)
  }

  async #saveSecrets(): Promise<void> {
    const lines = this.#secret === undefined || this.#secret === '' ? [] : [`${SECRET_NAME}=${this.#secret}`]
    await writeFile(this.#secretFile, `${lines.join('\n')}${lines.length === 0 ? '' : '\n'}`, { mode: 0o600 })
    await chmod(this.#secretFile, 0o600)
  }
}

/* ── validation helpers ─────────────────────────────────────────────────── */

function optionalBoolean<K extends string>(key: K, value: boolean | undefined): Partial<Record<K, boolean>> {
  return value === undefined ? {} : { [key]: value } as Partial<Record<K, boolean>>
}

function optionalNumber<K extends string>(key: K, value: number | undefined, minimum: number, maximum: number): Partial<Record<K, number>> {
  if (value === undefined) return {}
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${key} 必须在 ${String(minimum)} 到 ${String(maximum)} 之间`)
  }
  return { [key]: Math.round(value) } as Partial<Record<K, number>>
}

/** Accept `models: string[]` (parallel) or `model: string` (legacy single). */
function optionalModels(input: AutoReviewConfigInput): Partial<StoredAutoReviewConfig> {
  const source = input.models ?? (input.model === undefined ? undefined : [input.model])
  if (source === undefined) return {}
  const models: string[] = []
  for (const entry of source) {
    if (typeof entry !== 'string') throw new Error('模型列表格式无效')
    const value = entry.trim().slice(0, 200)
    if (value === '') throw new Error('评审模型不能为空')
    if (!models.includes(value)) models.push(value)
  }
  if (models.length === 0) throw new Error('至少需要一个评审模型')
  if (models.length > 4) throw new Error('最多同时使用 4 个评审模型')
  return { models, model: models[0]! }
}

function optionalModelProfile(value: AutoReviewConfigInput['modelProfile']): Partial<StoredAutoReviewConfig> {
  if (value === undefined) return {}
  if (value === 'auto') return { modelProfile: undefined }
  if (value !== 'deepseek' && value !== 'anthropic' && value !== 'openai' && value !== 'glm') throw new Error('modelProfile 无效')
  return { modelProfile: value }
}

function optionalEngineVersion(value: string | undefined): Partial<StoredAutoReviewConfig> {
  if (value === undefined) return {}
  if (!/^\d+\.\d+\.\d+$/u.test(value.trim())) throw new Error('评审引擎版本必须是 x.y.z')
  return { engineVersion: value.trim() }
}

function optionalScope(value: AutoReviewConfigInput['scope']): Partial<StoredAutoReviewConfig> {
  if (value === undefined) return {}
  if (value !== 'mine' && value !== 'assigned' && value !== 'all') throw new Error('scope 无效')
  return { scope: value }
}

function optionalFixSeverity(value: AutoReviewConfigInput['fixSeverity']): Partial<StoredAutoReviewConfig> {
  if (value === undefined) return {}
  if (value !== 'critical' && value !== 'warning') throw new Error('fixSeverity 必须是 critical 或 warning')
  return { fixSeverity: value }
}

function optionalWorker(value: string | undefined): Partial<StoredAutoReviewConfig> {
  if (value === undefined) return {}
  const trimmed = value.trim()
  return trimmed === '' ? { workerConfigId: undefined } : { workerConfigId: trimmed }
}

function optionalUrl<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  if (value === undefined) return {}
  const trimmed = value.trim()
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${key} 必须是 HTTP(S) URL`)
  if (url.username !== '' || url.password !== '') throw new Error(`${key} 不能包含账号密码`)
  return { [key]: trimmed.replace(/\/+$/u, '') } as Partial<Record<K, string>>
}

function cleanEnv(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (!ENV_NAME.test(trimmed)) throw new Error('环境变量名只能包含大写字母、数字和下划线')
  return trimmed
}

function cleanText(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length > 4_000) throw new Error('额外审查指令不能超过 4000 个字符')
  return trimmed
}

function apiKeyMode(value: string): ApiKeyMode {
  if (value === 'value' || value === 'environment') return value
  throw new Error('apiKeyMode 无效')
}

/** Reject a corrupted settings file loudly instead of silently resetting it. */
function validateStoredConfig(config: StoredAutoReviewConfig | undefined): StoredAutoReviewConfig {
  if (config === undefined) return defaultAutoReviewConfig()
  const defaults = defaultAutoReviewConfig()
  const merged: StoredAutoReviewConfig = { ...defaults, ...config }
  // Old files only carry `model`; migrate them to the parallel list.
  const rawModels = (config as { models?: unknown }).models
  const models = Array.isArray(rawModels)
    ? rawModels.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : []
  merged.models = models.length > 0 ? models : [typeof merged.model === 'string' && merged.model !== '' ? merged.model : defaults.model]
  merged.model = merged.models[0]!
  if (typeof merged.enabled !== 'boolean') throw new Error('auto-review.enabled 无效')
  if (!['mine', 'assigned', 'all'].includes(merged.scope)) throw new Error('auto-review.scope 无效')
  if (!Number.isFinite(merged.debounceSeconds) || merged.debounceSeconds < 10) merged.debounceSeconds = defaults.debounceSeconds
  if (!Number.isFinite(merged.debounceMaxSeconds) || merged.debounceMaxSeconds < merged.debounceSeconds) {
    merged.debounceMaxSeconds = Math.max(defaults.debounceMaxSeconds, merged.debounceSeconds)
  }
  if (typeof merged.model !== 'string' || merged.model.trim() === '') merged.model = defaults.model
  if (typeof merged.baseUrl !== 'string' || merged.baseUrl.trim() === '') merged.baseUrl = defaults.baseUrl
  if (merged.apiKeyMode !== 'value' && merged.apiKeyMode !== 'environment' && merged.apiKeyMode !== undefined) {
    throw new Error('auto-review.apiKeyMode 无效')
  }
  return merged
}

function validateRecord(record: AutoReviewRecord): AutoReviewRecord {
  return {
    ...record,
    comments: Array.isArray(record.comments) ? record.comments : [],
    counts: {
      critical: record.counts?.critical ?? 0,
      warning: record.counts?.warning ?? 0,
      suggestion: record.counts?.suggestion ?? 0,
    },
    status: (['idle', 'pending', 'running', 'reviewed', 'failed'] as readonly string[]).includes(record.status) ? record.status : 'idle',
    trigger: record.trigger === 'manual' ? 'manual' : 'auto',
    summary: typeof record.summary === 'string' ? record.summary : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now(),
  }
}

/** Attach the live job status to a record's fix session (jobs age out faster than records). */
export function withLiveFixStatus(record: AutoReviewRecord, jobs: readonly { id: string, status: JobStatus }[]): AutoReviewRecord {
  if (record.fix === undefined) return record
  const job = jobs.find(candidate => candidate.id === record.fix!.jobId)
  if (job === undefined || job.status === record.fix.status) return record
  return { ...record, fix: { ...record.fix, status: job.status } }
}

async function readSecrets(filename: string): Promise<Record<string, string>> {
  try {
    return parseEnv(await readFile(filename, 'utf8')) as Record<string, string>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}
