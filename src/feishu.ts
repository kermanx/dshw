/**
 * Feishu bot: PR progress notifications into one topic chat, and topic replies
 * as commands back into dshw.
 *
 * Two design choices keep this small:
 *
 *  - All Feishu I/O goes through `lark-cli`, the same tool the user already
 *    authorizes. dshw never stores app secrets and works with any account the
 *    CLI is logged into.
 *  - Receiving instructions polls the topics we own instead of hosting a
 *    webhook. The daemon runs on a laptop/container behind NAT, so it has no
 *    public callback URL; polling needs no tunnel, no event subscription, and
 *    no console configuration.
 *
 * One topic thread per PR: the first notification opens the topic, later ones
 * (review finished, fix finished) are replies in it. Replies from the user are
 * read back and turned into `review` / `fix` / `steer` actions.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { FEISHU_FILE } from './config.ts'
import type {
  AutoReviewRecord, FeishuCliStatus, FeishuConfig, FeishuConfigInput, FeishuNotifyConfig, FeishuThread,
} from './types.ts'
import { buildFixCard, buildReviewCard, type FixProgress } from './feishu-card.ts'
import { parseRoute, type FeishuRoute } from './feishu-route.ts'
import { messageOf, now, readJson, run, writeJsonAtomic } from './util.ts'

/** Command names accepted at the start of a topic reply. */
const COMMANDS = new Set(['review', 'fix', 'status', 'open', 'help'])
/** Threads polled in one pass (the rest wait for the next tick). */
const MAX_THREADS_PER_POLL = 20
/** Message ids remembered per thread, enough to ignore history on restart. */
const MAX_SEEN_IDS = 100
/** Timeout for one lark-cli call. */
const CLI_TIMEOUT_MS = 60_000
/** Minimum gap between two progress patches of the same card. */
const PROGRESS_THROTTLE_MS = 10_000
/** Wait before restarting a dead card-event consumer. */
const EVENT_RETRY_MS = 30_000

export function defaultFeishuConfig(): FeishuConfig {
  return {
    enabled: false,
    command: 'lark-cli',
    pollSeconds: 10,
    notify: { review: true, fix: true, failure: true },
  }
}

/** A parsed topic instruction. */
export type FeishuCommand =
  | { kind: 'open' }
  | { kind: 'review' }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'fix', instruction?: string }
  | { kind: 'steer', instruction: string }

/**
 * Interpret one topic reply.
 *
 * `/cmd rest` is explicit; anything else is a free-form instruction for the
 * PR (steer a running fix session, otherwise start one).
 */
export function parseFeishuCommand(text: string): FeishuCommand | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/u.exec(trimmed)
  if (match === null) return { kind: 'steer', instruction: trimmed }
  const name = match[1]!.toLowerCase()
  const rest = (match[2] ?? '').trim()
  if (!COMMANDS.has(name)) return { kind: 'help' }
  if (name === 'review') return { kind: 'review' }
  if (name === 'status') return { kind: 'status' }
  if (name === 'open') return { kind: 'open' }
  if (name === 'fix') return rest === '' ? { kind: 'fix' } : { kind: 'fix', instruction: rest }
  return { kind: 'help' }
}

/** One-line severity summary used in messages. */
export function severityLine(record: Pick<AutoReviewRecord, 'counts'>): string {
  const parts: string[] = []
  if (record.counts.critical > 0) parts.push(`${String(record.counts.critical)} critical`)
  if (record.counts.warning > 0) parts.push(`${String(record.counts.warning)} warning`)
  if (record.counts.suggestion > 0) parts.push(`${String(record.counts.suggestion)} suggestion`)
  return parts.length === 0 ? '未发现问题' : parts.join(' · ')
}

/** Title + body of the message that opens a PR's topic. */
export function renderTopicOpener(record: AutoReviewRecord, link?: string): { title: string, body: string } {
  const lines = [
    record.title,
    '',
    `\`${record.baseRefName}\` ← \`${record.branch}\``,
    '',
    '这个 PR 的评审与修复进展都会更新在这张卡片上。',
    ...(link === undefined ? [] : ['', `看板：${link}`]),
  ]
  return { title: `PR #${String(record.number)} · ${record.repoSlug}`, body: lines.join('\n') }
}

/** Body of the "review finished" reply. */
export function renderReviewReply(record: AutoReviewRecord, link?: string): string {
  const lines = [`**评审完成** · ${severityLine(record)}`]
  const summary = record.summary.trim()
  if (summary !== '') lines.push('', summary.length > 600 ? `${summary.slice(0, 600)}…` : summary)
  const findings = record.comments.slice(0, 5)
  if (findings.length > 0) {
    lines.push('')
    for (const comment of findings) {
      const line = comment.line ?? comment.lineStart
      const where = line === undefined ? comment.file : `${comment.file}:${String(line)}`
      const message = comment.message.trim().split('\n')[0] ?? ''
      lines.push(`- \`${comment.severity}\` \`${where}\` ${message.length > 160 ? `${message.slice(0, 160)}…` : message}`)
    }
    if (record.comments.length > findings.length) lines.push(`- …还有 ${String(record.comments.length - findings.length)} 条，打开看板查看`)
  }
  if (record.fix === undefined && record.counts.critical + record.counts.warning > 0) {
    lines.push('', '可以用卡片上的「开始修复」让 dsh 会话逐条处理这些意见。')
  }
  if (link !== undefined) lines.push('', `看板：${link}`)
  return lines.join('\n')
}

/** Body of the "fix session finished" reply. */
export function renderFixReply(record: AutoReviewRecord, status: string, link?: string): string {
  const label = status === 'succeeded' ? '修复会话已完成'
    : status === 'blocked' ? '修复会话无法完成'
      : status === 'cancelled' ? '修复会话已终止'
        : status === 'failed' ? '修复会话失败' : `修复会话：${status}`
  const lines = [`**${label}**`]
  if (record.fix?.producedHeadOid !== undefined && record.fix.producedHeadOid !== record.fix.headOid) {
    lines.push('', `提交：\`${record.fix.headOid.slice(0, 7)}\` → \`${record.fix.producedHeadOid.slice(0, 7)}\``)
  }
  if (record.fix?.blockedReason !== undefined && record.fix.blockedReason !== '') {
    lines.push('', record.fix.blockedReason.slice(-500))
  }
  lines.push('', '回复话题可以继续给指令（例如「只保留必须修复的那条」）。')
  if (link !== undefined) lines.push('', `看板：${link}`)
  return lines.join('\n')
}

/** Extract the plain text of one Feishu message (text or post payload). */
export function messageText(message: Record<string, unknown>): string {
  const body = message.body as Record<string, unknown> | undefined
  const raw = typeof body?.content === 'string' ? body.content : undefined
  if (raw === undefined) return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.text === 'string') return parsed.text
    const content = parsed.content
    if (!Array.isArray(content)) return ''
    const lines: string[] = []
    for (const row of content) {
      if (!Array.isArray(row)) continue
      const parts = row.map(cell => (cell !== null && typeof cell === 'object' && typeof (cell as { text?: unknown }).text === 'string'
        ? (cell as { text: string }).text
        : '')).filter(Boolean)
      if (parts.length > 0) lines.push(parts.join(''))
    }
    if (typeof parsed.title === 'string' && parsed.title !== '') lines.unshift(parsed.title)
    return lines.join('\n')
  } catch {
    return ''
  }
}

/** True for messages written by a person (bot echoes are ignored). */
export function isUserMessage(message: Record<string, unknown>): boolean {
  const sender = message.sender as { sender_type?: unknown } | undefined
  return sender?.sender_type === 'user'
}

/** Persisted settings, topic threads and the ids already handled. */
export class FeishuStore {
  #config: FeishuConfig
  #threads = new Map<string, FeishuThread>()
  readonly #file: string

  private constructor(file: string, config: FeishuConfig) {
    this.#file = file
    this.#config = config
  }

  static async open(file = FEISHU_FILE): Promise<FeishuStore> {
    const document = await readJson<{ version?: number, config?: FeishuConfig, threads?: FeishuThread[] }>(file)
    if (document !== undefined && document.version !== 1) throw new Error('feishu 配置文件版本无效')
    const config: FeishuConfig = { ...defaultFeishuConfig(), ...document?.config }
    config.notify = { ...defaultFeishuConfig().notify, ...config.notify }
    if (typeof config.pollSeconds !== 'number' || config.pollSeconds < 5) config.pollSeconds = 10
    const store = new FeishuStore(file, config)
    for (const thread of document?.threads ?? []) {
      if (typeof thread?.key === 'string' && typeof thread.threadId === 'string') store.#threads.set(thread.key, thread)
    }
    return store
  }

  config(): FeishuConfig {
    return { ...this.#config, notify: { ...this.#config.notify } }
  }

  async updateConfig(input: FeishuConfigInput): Promise<FeishuConfig> {
    const next: FeishuConfig = { ...this.#config }
    if (input.enabled !== undefined) next.enabled = input.enabled
    if (input.command !== undefined) {
      const command = input.command.trim()
      if (command === '') throw new Error('lark-cli 命令不能为空')
      next.command = command
    }
    if (input.proxy !== undefined) {
      const proxy = input.proxy.trim()
      if (proxy === '') delete next.proxy
      else if (proxy === '***') { /* masked echo from the panel: keep the stored value */ }
      else {
        const url = new URL(proxy)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('代理必须是 HTTP(S) URL')
        next.proxy = proxy
      }
    }
    if (input.chatId !== undefined) {
      const chatId = input.chatId.trim()
      if (chatId === '') {
        delete next.chatId
        delete next.chatName
      } else {
        if (!/^oc_[0-9a-zA-Z]+$/u.test(chatId)) throw new Error('飞书群 ID 应以 oc_ 开头')
        next.chatId = chatId
      }
    }
    if (input.chatName !== undefined) next.chatName = input.chatName.trim() === '' ? undefined : input.chatName.trim()
    if (input.webBaseUrl !== undefined) {
      const base = input.webBaseUrl.trim().replace(/\/+$/u, '')
      if (base === '') delete next.webBaseUrl
      else {
        const url = new URL(base)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('看板地址必须是 HTTP(S) URL')
        next.webBaseUrl = base
      }
    }
    if (input.pollSeconds !== undefined) {
      if (!Number.isFinite(input.pollSeconds) || input.pollSeconds < 5 || input.pollSeconds > 3600) throw new Error('轮询间隔必须在 5 到 3600 秒之间')
      next.pollSeconds = Math.round(input.pollSeconds)
    }
    if (input.notify !== undefined) next.notify = { ...next.notify, ...input.notify }
    this.#config = next
    await this.#save()
    return this.config()
  }

  /** Remember the last lark-cli probe so the panel shows it without re-running. */
  async setStatus(status: FeishuCliStatus): Promise<void> {
    this.#config = { ...this.#config, status }
    await this.#save()
  }

  threads(): FeishuThread[] {
    return [...this.#threads.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  }

  thread(key: string): FeishuThread | undefined {
    return this.#threads.get(key)
  }

  async saveThread(thread: FeishuThread): Promise<void> {
    this.#threads.set(thread.key, thread)
    await this.#save()
  }

  async removeThread(key: string): Promise<void> {
    if (this.#threads.delete(key)) await this.#save()
  }

  async #save(): Promise<void> {
    await writeJsonAtomic(this.#file, {
      version: 1,
      config: this.#config,
      threads: [...this.#threads.values()],
    })
  }
}

/** One lark-cli invocation result. */
interface LarkResult {
  ok: boolean
  data?: Record<string, unknown>
  error?: string
}

/** Environment for a lark-cli child: the optional proxy applies to every call. */
function larkEnv(proxy: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (proxy !== undefined) {
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
    env.https_proxy = proxy
    env.http_proxy = proxy
  }
  return env
}

/** Thin wrapper over the lark-cli CLI (one process per call). */
class LarkCli {
  readonly #command: string
  readonly #proxy: string | undefined

  constructor(command: string, proxy: string | undefined) {
    this.#command = command
    this.#proxy = proxy
  }

  async call(args: readonly string[]): Promise<LarkResult> {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (this.#proxy !== undefined) {
      env.HTTPS_PROXY = this.#proxy
      env.HTTP_PROXY = this.#proxy
      env.https_proxy = this.#proxy
      env.http_proxy = this.#proxy
    }
    const result = await run(this.#command, args, { env, timeoutMs: CLI_TIMEOUT_MS })
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim().slice(-600) === '' ? `lark-cli 退出码 ${String(result.code)}` : result.stderr.trim().slice(-600) }
    }
    try {
      const parsed = JSON.parse(result.stdout) as { ok?: boolean, data?: Record<string, unknown>, error?: { message?: string } }
      if (parsed.ok !== true) return { ok: false, error: parsed.error?.message ?? 'lark-cli 调用失败' }
      return { ok: true, data: parsed.data }
    } catch {
      return { ok: false, error: `无法解析 lark-cli 输出：${result.stdout.slice(0, 300)}` }
    }
  }

  /** Send one interactive card into a chat. */
  async sendCard(chatId: string, card: string): Promise<{ ok: boolean, messageId?: string, error?: string }> {
    const result = await this.call(['im', '+messages-send', '--chat-id', chatId, '--as', 'bot', '--msg-type', 'interactive', '--content', card])
    return { ok: result.ok, messageId: typeof result.data?.message_id === 'string' ? result.data.message_id : undefined, error: result.error }
  }

  /** Reply with a card inside a topic thread. */
  async replyCard(messageId: string, card: string): Promise<{ ok: boolean, messageId?: string, error?: string }> {
    const result = await this.call(['im', '+messages-reply', '--message-id', messageId, '--reply-in-thread', '--as', 'bot', '--msg-type', 'interactive', '--content', card])
    return { ok: result.ok, messageId: typeof result.data?.message_id === 'string' ? result.data.message_id : undefined, error: result.error }
  }

  /** Replace the content of a card this bot sent earlier. */
  async patchCard(messageId: string, card: string): Promise<{ ok: boolean, error?: string }> {
    const result = await this.call(['im', 'messages', 'patch', '--message-id', messageId, '--as', 'bot', '--data', JSON.stringify({ content: card })])
    return { ok: result.ok, error: result.error }
  }

  async status(): Promise<FeishuCliStatus> {
    const checkedAt = now()
    const version = await run(this.#command, ['--version'], { env: this.#env(), timeoutMs: 20_000 })
    if (version.code !== 0) {
      return { available: false, checkedAt, error: version.stderr.trim().slice(-400) || `无法执行 ${this.#command}` }
    }
    const auth = await run(this.#command, ['auth', 'status'], { env: this.#env(), timeoutMs: CLI_TIMEOUT_MS })
    if (auth.code !== 0) {
      return { available: true, version: version.stdout.trim().split('\n')[0], botReady: false, userReady: false, checkedAt, error: auth.stderr.trim().slice(-400) }
    }
    try {
      const parsed = JSON.parse(auth.stdout) as {
        identities?: { bot?: { status?: string }, user?: { status?: string, openId?: string } }
      }
      const bot = parsed.identities?.bot?.status === 'ready'
      const userStatus = parsed.identities?.user?.status ?? 'missing'
      const userOpenId = parsed.identities?.user?.openId
      return {
        available: true,
        version: version.stdout.trim().split('\n')[0],
        botReady: bot,
        userReady: userStatus !== 'missing',
        userNeedsRefresh: userStatus === 'needs_refresh',
        ...(userOpenId === undefined ? {} : { userOpenId }),
        checkedAt,
      }
    } catch {
      return { available: true, botReady: false, userReady: false, checkedAt, error: '无法解析 lark-cli auth status' }
    }
  }

  #env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (this.#proxy !== undefined) {
      env.HTTPS_PROXY = this.#proxy
      env.HTTP_PROXY = this.#proxy
      env.https_proxy = this.#proxy
      env.http_proxy = this.#proxy
    }
    return env
  }
}

/** What the daemon exposes to the bot (implemented by WorkflowService). */
export interface FeishuHost {
  record(key: string): AutoReviewRecord | undefined
  /** Run the automatic review now. */
  runReview(key: string): Promise<void>
  /** Start (or steer) the fix session; resolved text is answered in the topic. */
  startFix(key: string, instruction?: string): Promise<void>
  /** Steer a running fix session; false when no session is running. */
  steerFix(key: string, instruction: string): Promise<boolean>
  /** Route one natural-language topic message (review / fix / answer / status / stop). */
  interpret(key: string, message: string): Promise<FeishuRoute>
  /** Push a fix that is waiting in the working tree. */
  pushFix(key: string): Promise<void>
  /** Human-readable reason shown when a review has no fix session yet. */
  fixHint(record: AutoReviewRecord): string | undefined
  event(level: 'info' | 'warning' | 'error', message: string): void
}

/** Notification + command loop. */
export class FeishuService {
  readonly #store: FeishuStore
  readonly #host: FeishuHost
  #timer: NodeJS.Timeout | undefined
  #polling = false
  #stopped = true
  /** Last progress patch per record, for throttling. */
  readonly #lastProgress = new Map<string, { message: string, at: number }>()
  /** Long-lived `lark-cli event consume` child for card button clicks. */
  #events: ChildProcess | undefined
  #eventRetry: NodeJS.Timeout | undefined

  constructor(store: FeishuStore, host: FeishuHost) {
    this.#store = store
    this.#host = host
  }

  config(): FeishuConfig {
    return this.#store.config()
  }

  /**
   * Settings as the panel sees them: the proxy may embed credentials, so only
   * its presence is reported (empty input keeps the stored value).
   */
  publicConfig(): FeishuConfig {
    const { proxy, ...rest } = this.#store.config()
    return { ...rest, hasProxy: proxy !== undefined && proxy !== '' }
  }

  /** Topic threads owned by tracked PRs (for the settings panel). */
  threads(): FeishuThread[] {
    return this.#store.threads()
  }

  thread(key: string): FeishuThread | undefined {
    return this.#store.thread(key)
  }

  /** Persisted store, exposed for the thread bookkeeping routes. */
  store(): FeishuStore {
    return this.#store
  }

  async updateConfig(input: FeishuConfigInput): Promise<FeishuConfig> {
    const config = await this.#store.updateConfig(input)
    this.restart()
    return config
  }

  /** Probe lark-cli and remember the result. */
  async check(): Promise<FeishuCliStatus> {
    const config = this.#store.config()
    const status = await new LarkCli(config.command, config.proxy).status()
    await this.#store.setStatus(status)
    return status
  }

  /** Create a topic chat, invite the authorized user and store it. */
  async createTopicChat(name: string): Promise<{ chatId: string, chatName: string }> {
    const config = this.#store.config()
    const cli = new LarkCli(config.command, config.proxy)
    const userOpenId = config.status?.userOpenId
    const args = ['im', '+chat-create', '--name', name, '--chat-mode', 'topic', '--as', 'bot', '--set-bot-manager']
    if (userOpenId !== undefined && userOpenId !== '') args.push('--users', userOpenId)
    const created = await cli.call(args)
    if (!created.ok) throw new Error(created.error ?? '创建话题群失败')
    const chatId = typeof created.data?.chat_id === 'string' ? created.data.chat_id : undefined
    if (chatId === undefined) throw new Error('lark-cli 没有返回 chat_id')
    await this.#store.updateConfig({ chatId, chatName: name })
    return { chatId, chatName: name }
  }

  /** Send one message to the configured chat (used by the settings test button). */
  async sendTest(text: string): Promise<void> {
    const config = this.#store.config()
    if (config.chatId === undefined) throw new Error('还没有配置飞书群')
    const result = await new LarkCli(config.command, config.proxy).call([
      'im', '+messages-send', '--chat-id', config.chatId, '--as', 'bot', '--markdown', text,
    ])
    if (!result.ok) throw new Error(result.error ?? '发送失败')
  }

  /** Start the reply polling loop when the integration is enabled. */
  start(): void {
    this.#stopped = false
    this.restart()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#eventRetry !== undefined) clearTimeout(this.#eventRetry)
    this.#eventRetry = undefined
    this.#events?.kill('SIGTERM')
    this.#events = undefined
  }

  restart(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    if (this.#stopped) return
    const config = this.#store.config()
    if (!config.enabled || config.chatId === undefined) {
      this.#events?.kill('SIGTERM')
      this.#events = undefined
      return
    }
    this.#timer = setInterval(() => { void this.#poll() }, config.pollSeconds * 1000)
    this.#timer.unref()
    this.#ensureEvents()
  }

  /**
   * Keep one `lark-cli event consume card.action.trigger` child alive.
   *
   * Card buttons only work when the app subscribed the callback in the Feishu
   * console; without it the child exits immediately and we retry slowly instead
   * of spinning. The consumer is the only push channel dshw has, so it is
   * restarted with a backoff whenever it dies.
   */
  #ensureEvents(): void {
    if (this.#stopped || this.#events !== undefined) return
    const config = this.#store.config()
    if (!config.enabled || config.chatId === undefined) return
    // stdin must stay open: `event consume` treats EOF as "shut down", so a
    // child spawned with stdin=/dev/null would exit immediately.
    const child = spawn(config.command, ['event', 'consume', 'card.action.trigger', '--as', 'bot'], {
      env: larkEnv(config.proxy),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#events = child
    this.#host.event('info', '已订阅飞书卡片按钮事件（card.action.trigger）')
    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      let index = buffered.indexOf('\n')
      while (index >= 0) {
        const line = buffered.slice(0, index).trim()
        buffered = buffered.slice(index + 1)
        if (line !== '') void this.#handleCardEvent(line)
        index = buffered.indexOf('\n')
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (/not subscribed|requires callbacks|card\.action\.trigger/iu.test(text) && /error|requires|not subscribed/iu.test(text)) {
        this.#host.event('warning', '飞书卡片按钮需要先在开发者后台订阅 card.action.trigger 回调')
      }
    })
    child.on('exit', () => {
      this.#events = undefined
      if (this.#stopped) return
      this.#eventRetry = setTimeout(() => {
        this.#eventRetry = undefined
        this.#ensureEvents()
      }, EVENT_RETRY_MS)
      this.#eventRetry.unref()
    })
    child.on('error', (error) => {
      this.#host.event('warning', `飞书卡片事件订阅启动失败：${messageOf(error)}`)
    })
  }

  /** Handle one `card.action.trigger` payload: run the action, then repaint the card. */
  async #handleCardEvent(line: string): Promise<void> {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const raw = event.action_value
    if (typeof raw !== 'string') return
    let action: { a?: unknown, k?: unknown }
    try {
      action = JSON.parse(raw) as { a?: unknown, k?: unknown }
    } catch {
      return
    }
    if (typeof action.a !== 'string' || typeof action.k !== 'string') return
    const record = this.#host.record(action.k)
    if (record === undefined) return
    const config = this.#store.config()
    const cli = new LarkCli(config.command, config.proxy)
    try {
      if (action.a === 'fix') await this.#host.startFix(record.id)
      else if (action.a === 'review') await this.#host.runReview(record.id)
      else if (action.a === 'push') await this.#host.pushFix(record.id)
      else return
    } catch (error) {
      const message = messageOf(error)
      this.#host.event('warning', `飞书卡片操作失败：${message}`)
      const thread = this.#store.thread(record.id)
      if (thread !== undefined) {
        await cli.call(['im', '+messages-reply', '--message-id', thread.rootMessageId, '--reply-in-thread', '--as', 'bot', '--markdown', `操作没有完成：${message}`])
      }
      return
    }
    // Repaint the clicked card with the state the action left behind.
    const messageId = typeof event.message_id === 'string' ? event.message_id : this.#store.thread(record.id)?.reviewCardId
    if (messageId === undefined) return
    const latest = this.#host.record(record.id) ?? record
    const progress = latest.fix?.status === 'running' ? { status: 'running', message: '正在启动修复会话…' } : undefined
    const painted = await cli.patchCard(messageId, buildReviewCard(latest, this.#link(), progress))
    if (!painted.ok) this.#host.event('warning', `飞书卡片更新失败：${painted.error ?? '未知错误'}`)
  }

  /** Announce a finished review in its PR topic, as a card. */
  async notifyReview(record: AutoReviewRecord): Promise<void> {
    const config = this.#store.config()
    if (!config.enabled || config.chatId === undefined) return
    if (!config.notify.review && record.status === 'reviewed') return
    if (!config.notify.failure && record.status === 'failed') return
    const hint = record.fix === undefined ? this.#host.fixHint(record) : undefined
    const card = buildReviewCard(record, this.#link(), this.#fixProgress(record), hint)
    const existing = await this.#ensureThread(record, card)
    if (existing === undefined) return
    if (existing.created) return
    // One card per PR: a new review round repaints the same card instead of
    // stacking another message in the topic.
    const current = this.#store.thread(record.id) ?? existing.thread
    const cardId = current.reviewCardId ?? current.fixCardId
    if (cardId !== undefined) {
      const patched = await new LarkCli(config.command, config.proxy).patchCard(cardId, card)
      if (patched.ok) {
        await this.#store.saveThread({ ...current, updatedAt: now() })
        return
      }
      this.#host.event('warning', `飞书卡片更新失败，改为发送新卡片：${patched.error ?? '未知错误'}`)
    }
    const messageId = await this.#replyCard(existing.thread, card, renderReviewReply(record, this.#link()))
    if (messageId !== undefined) {
      await this.#store.saveThread({ ...(this.#store.thread(record.id) ?? existing.thread), reviewCardId: messageId, updatedAt: now() })
    }
  }

  /**
   * Show the fix session on the PR's card when it starts.
   *
   * One card per PR: the review card is patched in place, so the thread shows a
   * single message that turns from "评审完成" into "修复进行中" and then into the
   * final result. A second card is posted only when no review card is known.
   */
  async notifyFixStarted(record: AutoReviewRecord): Promise<void> {
    const config = this.#store.config()
    if (!config.enabled || config.chatId === undefined || !config.notify.fix) return
    const card = buildReviewCard(record, this.#link(), this.#fixProgress(record))
    const ensured = await this.#ensureThread(record, card)
    if (ensured === undefined) return
    if (ensured.created) {
      this.#lastProgress.set(record.id, { message: this.#fixProgress(record).message ?? '', at: Date.now() })
      return
    }
    const thread = ensured.thread
    const current = this.#store.thread(record.id) ?? thread
    const existing = current.reviewCardId ?? current.fixCardId
    if (existing !== undefined) {
      const patched = await new LarkCli(config.command, config.proxy).patchCard(existing, card)
      if (patched.ok) {
        this.#lastProgress.set(record.id, { message: this.#fixProgress(record).message ?? '', at: Date.now() })
        return
      }
      this.#host.event('warning', `飞书卡片更新失败：${patched.error ?? '未知错误'}`)
    }
    const messageId = await this.#replyCard(thread, card, renderFixReply(record, 'running', this.#link()))
    if (messageId === undefined) return
    await this.#store.saveThread({ ...current, fixCardId: messageId, updatedAt: now() })
    this.#lastProgress.set(record.id, { message: this.#fixProgress(record).message ?? '', at: Date.now() })
  }

  /**
   * Patch the fix card as the session progresses.
   *
   * Patches are throttled: the worker emits a message per step, and Feishu only
   * needs a readable cadence, so an unchanged or too-frequent update is skipped.
   */
  async syncFixProgress(record: AutoReviewRecord, progress: FixProgress): Promise<void> {
    const thread = this.#store.thread(record.id)
    const cardId = thread?.reviewCardId ?? thread?.fixCardId
    if (cardId === undefined) return
    const message = progress.message ?? ''
    const last = this.#lastProgress.get(record.id)
    if (progress.status === 'running' && last !== undefined) {
      const unchanged = last.message === message
      if (Date.now() - last.at < PROGRESS_THROTTLE_MS || unchanged) return
    }
    const result = await new LarkCli(this.#store.config().command, this.#store.config().proxy)
      .patchCard(cardId, buildReviewCard(record, this.#link(), progress))
    if (result.ok) this.#lastProgress.set(record.id, { message, at: Date.now() })
  }

  /** Final fix result: patch the running card when there is one. */
  async notifyFix(record: AutoReviewRecord, status: string): Promise<void> {
    const config = this.#store.config()
    if (!config.enabled || config.chatId === undefined) return
    const fixed = status === 'succeeded' || status === 'ready' || status === 'pushed'
    if (fixed && !config.notify.fix) return
    if (!fixed && !config.notify.failure) return
    const progress: FixProgress = { status }
    const thread = this.#store.thread(record.id)
    const cardId = thread?.reviewCardId ?? thread?.fixCardId
    if (cardId !== undefined) {
      const result = await new LarkCli(config.command, config.proxy).patchCard(cardId, buildReviewCard(record, this.#link(), progress))
      if (result.ok) return
      this.#host.event('warning', `飞书修复卡片更新失败：${result.error ?? '未知错误'}`)
    }
    const fallbackCard = buildReviewCard(record, this.#link(), progress)
    const ensured = thread === undefined ? await this.#ensureThread(record, fallbackCard) : { thread, created: false }
    if (ensured === undefined) return
    if (ensured.created) return
    const fresh = ensured.thread
    const messageId = await this.#replyCard(fresh, buildFixCard(record, progress, this.#link()), renderFixReply(record, status, this.#link()))
    if (messageId !== undefined) {
      await this.#store.saveThread({ ...(this.#store.thread(record.id) ?? fresh), fixCardId: messageId, updatedAt: now() })
    }
  }

  /** Current fix progress for card rendering (no live worker message yet). */
  #fixProgress(record: AutoReviewRecord): FixProgress {
    return { status: record.fix?.status ?? 'idle', ...(record.fix?.status === 'running' ? { message: '正在准备修复会话…' } : {}) }
  }

  /** Reply with a card into the PR topic, falling back to a plain markdown reply. */
  async #replyCard(thread: FeishuThread, card: string, fallback?: string): Promise<string | undefined> {
    const config = this.#store.config()
    const cli = new LarkCli(config.command, config.proxy)
    const replied = await cli.replyCard(thread.rootMessageId, card)
    if (replied.ok) {
      await this.#store.saveThread({ ...thread, updatedAt: now() })
      return replied.messageId
    }
    this.#host.event('warning', `飞书卡片发送失败，已改用文本：${replied.error ?? '未知错误'}`)
    if (fallback === undefined) return undefined
    const text = await cli.call(['im', '+messages-reply', '--message-id', thread.rootMessageId, '--reply-in-thread', '--as', 'bot', '--markdown', fallback])
    return text.ok && typeof text.data?.message_id === 'string' ? text.data.message_id : undefined
  }

  /**
   * Existing thread for the record, creating the topic on first notification.
   *
   * The topic's ROOT message is the card itself — a topic chat shows the root as
   * the topic, so a text opener would make the useful message a reply. When the
   * card cannot be sent (old client), a markdown opener is used instead.
   */
  async #ensureThread(record: AutoReviewRecord, card: string): Promise<{ thread: FeishuThread, created: boolean } | undefined> {
    const config = this.#store.config()
    if (config.chatId === undefined) return undefined
    const existing = this.#store.thread(record.id)
    if (existing !== undefined) return { thread: existing, created: false }
    const cli = new LarkCli(config.command, config.proxy)
    const sentCard = await cli.sendCard(config.chatId, card)
    let messageId = sentCard.ok ? sentCard.messageId : undefined
    if (!sentCard.ok) {
      this.#host.event('warning', `飞书卡片发送失败，已改用文本：${sentCard.error ?? '未知错误'}`)
      const opener = renderTopicOpener(record, this.#link())
      const sent = await cli.call([
        'im', '+messages-send', '--chat-id', config.chatId, '--as', 'bot', '--markdown',
        `**${opener.title}**\n\n${opener.body}`,
      ])
      if (!sent.ok) {
        this.#host.event('warning', `飞书消息发送失败：${sent.error ?? '未知错误'}`)
        return undefined
      }
      messageId = typeof sent.data?.message_id === 'string' ? sent.data.message_id : undefined
    }
    if (messageId === undefined) return undefined
    const fetched = await cli.call(['im', '+messages-mget', '--message-ids', messageId, '--as', 'bot'])
    const message = Array.isArray(fetched.data?.messages) ? fetched.data.messages[0] as Record<string, unknown> : undefined
    const threadId = typeof message?.thread_id === 'string' ? message.thread_id : undefined
    if (threadId === undefined) {
      this.#host.event('warning', '飞书消息已发送，但没有拿到话题 ID；后续进展会继续发到群里')
      return undefined
    }
    const timestamp = now()
    const thread: FeishuThread = {
      key: record.id,
      title: `PR #${String(record.number)} · ${record.repoSlug}`,
      rootMessageId: messageId,
      threadId,
      seenMessageIds: [],
      // The root message IS this card, so fix progress patches it in place.
      reviewCardId: messageId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.#store.saveThread(thread)
    this.#host.event('info', `已在飞书为 ${record.repoSlug} / PR #${String(record.number)} 创建话题`)
    return { thread, created: true }
  }

  #link(): string | undefined {
    const base = this.#store.config().webBaseUrl
    return base === undefined || base === '' ? undefined : base
  }

  /** Read new topic replies and run them as instructions. */
  async #poll(): Promise<void> {
    if (this.#polling) return
    const config = this.#store.config()
    if (!config.enabled || config.chatId === undefined) return
    this.#polling = true
    const cli = new LarkCli(config.command, config.proxy)
    try {
      for (const thread of this.#store.threads().slice(0, MAX_THREADS_PER_POLL)) {
        const listed = await cli.call(['im', '+threads-messages-list', '--thread', thread.threadId, '--as', 'user', '--order', 'asc', '--page-size', '20', '--no-reactions'])
        if (!listed.ok) continue
        const messages = Array.isArray(listed.data?.messages) ? listed.data.messages as Array<Record<string, unknown>> : []
        const seen = new Set(thread.seenMessageIds)
        const fresh = messages.filter(message => typeof message.message_id === 'string' && !seen.has(message.message_id))
        if (fresh.length === 0) continue
        const ids = [...thread.seenMessageIds]
        for (const message of fresh) {
          const id = String(message.message_id)
          ids.push(id)
          if (!isUserMessage(message)) continue
          const text = messageText(message)
          if (text.trim() === '') continue
          await this.#handle(thread, text)
        }
        await this.#store.saveThread({
          ...thread,
          seenMessageIds: ids.slice(-MAX_SEEN_IDS),
          updatedAt: now(),
        })
      }
    } catch (error) {
      this.#host.event('warning', `飞书指令轮询失败：${messageOf(error)}`)
    } finally {
      this.#polling = false
    }
  }

  /** Run one parsed instruction and answer in the topic. */
  async #handle(thread: FeishuThread, text: string): Promise<void> {
    const record = this.#host.record(thread.key)
    const reply = async (body: string): Promise<void> => {
      const config = this.#store.config()
      await new LarkCli(config.command, config.proxy).call([
        'im', '+messages-reply', '--message-id', thread.rootMessageId, '--reply-in-thread', '--as', 'bot', '--markdown', body,
      ])
    }
    const command = parseFeishuCommand(text)
    if (command === undefined) return
    try {
      if (command.kind === 'open') {
        await reply(this.#link() === undefined ? '还没有配置看板地址；在 dshw 的 Settings → Feishu 里填写。' : `看板：${this.#link() ?? ''}`)
        return
      }
      if (record === undefined) {
        await reply('这条话题对应的 PR 已经不在自动评审记录里了。')
        return
      }
      if (command.kind === 'help') {
        await reply('直接回复文字即可：有修复会话时会作为指令发过去，否则会按这条说明启动修复。也可以点卡片上的按钮。')
        return
      }
      if (command.kind === 'status') {
        const counts = severityLine(record)
        const fix = record.fix === undefined ? '没有修复会话' : `修复会话：${record.fix.status}`
        await reply([`**${record.repoSlug} / PR #${String(record.number)}**`, '', `评审：${record.status} · ${counts}`, fix].join('\n'))
        return
      }
      if (command.kind === 'review') {
        await this.#host.runReview(record.id)
        await reply('已开始评审，完成后会在这里回复。')
        return
      }
      if (command.kind === 'fix') {
        await this.#host.startFix(record.id, command.instruction)
        await reply(command.instruction === undefined ? '已启动修复会话，进展会在这里同步。' : `已启动修复会话，并附上指令：${command.instruction}`)
        return
      }
      // Free text: one small model call routes it (review / fix / answer / status / stop).
      const route = await this.#host.interpret(record.id, command.instruction).catch(() => parseRoute('', command.instruction))
      if (route.action === 'answer') {
        await reply(route.reply === '' ? '我暂时没法回答这个问题；详细信息可以在评审页里看。' : route.reply)
        return
      }
      if (route.action === 'status') {
        const counts = severityLine(record)
        const fix = record.fix === undefined ? '没有修复会话' : `修复会话：${record.fix.status}`
        await reply([route.reply === '' ? '' : route.reply, `评审：${record.status} · ${counts}`, fix].filter(line => line !== '').join('\n\n'))
        return
      }
      if (route.action === 'review') {
        await this.#host.runReview(record.id)
        await reply(route.reply === '' ? '已开始重新评审，完成后会在这里更新卡片。' : route.reply)
        return
      }
      if (route.action === 'push') {
        await this.#host.pushFix(record.id)
        await reply(route.reply === '' ? '好的，开始推送修复。' : route.reply)
        return
      }
      if (route.action === 'stop') {
        const steered = await this.#host.steerFix(record.id, '停止当前任务，先不要继续修改代码，并说明当前进展。')
        await reply(steered ? (route.reply === '' ? '已让修复会话停下。' : route.reply) : '当前没有进行中的修复会话。')
        return
      }
      const instruction = route.instruction ?? command.instruction
      const steered = await this.#host.steerFix(record.id, instruction)
      if (steered) {
        await reply(route.reply === '' ? '已把指令发给修复会话。' : route.reply)
        return
      }
      await this.#host.startFix(record.id, instruction)
      await reply(route.reply === '' ? `当前没有进行中的修复会话，已按这条指令启动一个：${instruction}` : route.reply)
    } catch (error) {
      await reply(`执行失败：${messageOf(error)}`).catch(() => {})
    }
  }
}
