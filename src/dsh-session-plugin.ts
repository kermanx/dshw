import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatProgressEvent } from './dsh-progress-plugin.ts'
import type { DshRunRecord } from './types.ts'
import { now, readJson, writeJsonAtomic } from './util.ts'
import { createWorkerProgressReporter } from './worker-progress.ts'

export const name = 'dshw-session-worker'
export const inject = ['agentDefaultModel', 'agents', 'sessions']

interface Config {
  requestPath: string
}

interface WorkerRequest {
  runId: string
  resultPath: string
  progressUrl: string
  controlSocketPath: string
  eventLogPath: string
  outputLogPath: string
  sync: { id: string; clonePath: string }
  kind: DshRunRecord['kind']
  prompt: string
  worker?: { provider?: string; model?: string; reasoningEffort?: string }
}

interface RuntimeModules {
  createUserMessage(options: object): unknown
  SessionId(value: string): unknown
  installModelSelection(ctx: unknown, selection: object): void
  JsonRpcLineTransport: new(input: Socket, output: Socket) => {
    start(): void
    close(): void
    onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void
    notify(method: string, params?: object): void
    flush(): Promise<void>
  }
}

interface AgentLike {
  status: 'idle' | 'running'
  session: { id: unknown; seq: number; events: SessionEventLike[] }
  steer(message: unknown): void
  cancel(cause: { kind: 'user' }): void
  whenIdle(): Promise<void>
}

interface SessionEventLike {
  type: string
  seq: number
  data: Record<string, unknown>
}

interface ContextLike {
  get(name: string): unknown
  on(name: 'session/event', listener: (session: unknown, event: SessionEventLike) => void): () => void
  agents: {
    create(options: object): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
  }
  agentDefaultModel: { currentSelection(): { provider: string; model: string } }
  sessions: { flush(session: AgentLike['session']): Promise<void> }
}

type WorkerPhase = 'starting' | 'running' | 'cancelling' | 'paused' | 'finishing' | 'completed'

/** Mount after the complete Harness composition settles, without making Loader await itself. */
export function apply(ctx: ContextLike, config: Config): () => Promise<void> {
  let disposed = false
  let stop: (() => Promise<void>) | undefined
  const started = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
    await loader?.await()
    if (disposed) return
    stop = await startSessionWorker(ctx, config)
  }).catch(error => {
    process.stderr.write(`dshw session worker: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    const exit = ctx.get('appExit') as ((code: number) => void) | undefined
    exit?.(1)
  })
  return async () => {
    disposed = true
    await started
    await stop?.()
  }
}

/** Long-lived, directly controlled Agent/Session worker loaded into the pinned Harness runtime. */
async function startSessionWorker(ctx: ContextLike, config: Config): Promise<() => Promise<void>> {
  const request = await readJson<WorkerRequest>(config.requestPath)
  if (request === undefined) throw new Error(`dshw worker request 不存在：${config.requestPath}`)
  const runtimeRoot = process.env.DSHW_HARNESS_RUNTIME_ROOT
  if (runtimeRoot === undefined) throw new Error('dshw session worker 缺少 DSHW_HARNESS_RUNTIME_ROOT')
  const modules = await loadRuntimeModules(runtimeRoot)
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) throw new Error('dshw session worker 需要 launcher 提供 appExit')

  await mkdir(dirname(request.controlSocketPath), { recursive: true })
  await rm(request.controlSocketPath, { force: true })
  const eventStream = createWriteStream(request.eventLogPath, { flags: 'a' })
  const outputStream = createWriteStream(request.outputLogPath, { flags: 'a' })
  const progress = createWorkerProgressReporter(request.runId, request.progressUrl)
  const transports = new Set<InstanceType<RuntimeModules['JsonRpcLineTransport']>>()
  const sockets = new Set<Socket>()
  let phase: WorkerPhase = 'starting'
  let activity = 0
  let pendingAfterCancel: string[] = []
  let settled = false
  let cleanup: () => Promise<void> = async () => {}

  progress.phase('starting', '正在创建隔离的 Harness session')
  const fallbackSelection = ctx.agentDefaultModel.currentSelection()
  const selection = {
    provider: request.worker?.provider ?? fallbackSelection.provider,
    model: request.worker?.model ?? fallbackSelection.model,
    ...(request.worker?.reasoningEffort === undefined ? {} : { reasoningEffort: request.worker.reasoningEffort }),
  }
  const handle = await ctx.agents.create({
    sessionId: modules.SessionId(`dshw-${request.runId}`),
    meta: { cwd: request.sync.clonePath },
    agentOptions: selection,
    setup: (agentCtx: unknown) => {
      modules.installModelSelection(agentCtx, { current: selection, assembled: undefined })
    },
  })
  const agent = handle.agent
  await agent.whenIdle()
  const firstSeq = agent.session.seq

  const notify = (method: string, params: object): void => {
    for (const transport of transports) {
      try { transport.notify(method, params) } catch { /* disconnected clients are removed by the socket close edge */ }
    }
  }
  const setPhase = (next: WorkerPhase, message: string): void => {
    phase = next
    if (next !== 'completed') progress.phase(next, message)
    notify('session.status', { phase: next, agentStatus: agent.status })
  }
  const finish = async (forced = false): Promise<void> => {
    if (settled) return
    settled = true
    let exitCode = 1
    try {
      setPhase('finishing', forced ? '正在终止并保存 session' : '任务已停稳，正在保存结果')
      await withTimeout(ctx.sessions.flush(agent.session), 5_000, '保存 Harness session 超时').catch(error => {
        progress.line(`[stderr] ${error instanceof Error ? error.message : String(error)}`)
      })
      const outcome = summarize(agent.session.events, firstSeq)
      const parsed = parseOutcome(outcome.text)
      const status: DshRunRecord['status'] = forced
        ? 'cancelled'
        : outcome.reason === 'completed'
          ? parsed.blocked ? 'blocked' : 'succeeded'
          : 'failed'
      const output = forced
        ? '任务已被手动终止'
        : outcome.text || outcome.error || `dsh 任务结束：${outcome.reason ?? 'unknown'}`
      const record: DshRunRecord = {
        id: request.runId,
        syncId: request.sync.id,
        kind: request.kind,
        clonePath: request.sync.clonePath,
        startedAt: progress.startedAt,
        finishedAt: now(),
        status,
        finalOutput: output,
        ...(status === 'blocked' && parsed.blocked ? { blockedReason: parsed.reason } : {}),
      }
      await writeFile(join(dirname(request.resultPath), 'final.txt'), `${output}\n`)
      await writeJsonAtomic(request.resultPath, record)
      setPhase('completed', '任务已结束')
      exitCode = status === 'succeeded' || status === 'blocked' ? 0 : 1
    } catch (error) {
      progress.line(`[stderr] worker 收尾失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Result persistence is the completion boundary. Do not make process
      // shutdown depend on a best-effort daemon progress request, cleanup
      // edge, or a client that connected while the worker was finishing.
      void progress.flush()
      await cleanup().catch(error => {
        process.stderr.write(`dshw session worker cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      })
      exit(exitCode)
    }
  }
  const settleActivity = async (token: number): Promise<void> => {
    await agent.whenIdle()
    if (settled || token !== activity) return
    if (phase === 'cancelling') {
      setPhase('paused', '任务已暂停，可以发送新指令继续')
      const queued = pendingAfterCancel
      pendingAfterCancel = []
      for (const prompt of queued) steer(prompt)
      return
    }
    await finish(false)
  }
  const steer = (prompt: string): void => {
    if (settled || phase === 'finishing' || phase === 'completed') throw new Error('任务已结束，无法 steer')
    if (prompt.trim() === '') throw new Error('steer 内容不能为空')
    if (phase === 'cancelling') {
      pendingAfterCancel.push(prompt)
      notify('session.status', { phase, queuedAfterCancel: pendingAfterCancel.length })
      return
    }
    const token = ++activity
    setPhase('running', agent.status === 'idle' ? '正在继续 dsh 任务' : '已在下一个 step 前插入指令')
    agent.steer(modules.createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    void settleActivity(token).catch(error => void fail(error))
  }
  const cancel = (): void => {
    if (settled || phase === 'finishing' || phase === 'completed') throw new Error('任务已结束，无法 cancel')
    if (phase === 'paused' || phase === 'cancelling') return
    const token = ++activity
    setPhase('cancelling', '正在取消当前 turn')
    agent.cancel({ kind: 'user' })
    void settleActivity(token).catch(error => void fail(error))
  }
  const fail = async (error: unknown): Promise<void> => {
    if (settled) return
    progress.line(`[stderr] ${error instanceof Error ? error.message : String(error)}`)
    await finish(false)
  }

  const removeEventListener = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    eventStream.write(`${JSON.stringify(event)}\n`)
    notify('session.event', { event })
    const text = formatProgressEvent(event)
    if (text !== undefined) {
      outputStream.write(`${text}\n`)
      progress.line(text)
    }
  })

  const server = createServer(socket => {
    sockets.add(socket)
    const transport = new modules.JsonRpcLineTransport(socket, socket)
    transports.add(transport)
    transport.onRequest(async (method, params) => {
      switch (method) {
        case 'session.status':
          return { phase, agentStatus: agent.status, pendingAfterCancel: pendingAfterCancel.length }
        case 'session.steer':
          if (typeof params.prompt !== 'string') throw new Error('session.steer 缺少 prompt')
          steer(params.prompt)
          return { accepted: true, phase }
        case 'session.cancel':
          cancel()
          return { accepted: true, phase }
        case 'runtime.terminate':
          setImmediate(() => { void finish(true) })
          return { accepted: true }
        default:
          throw new Error(`unknown dshw worker method: ${method}`)
      }
    })
    transport.start()
    socket.once('close', () => {
      sockets.delete(socket)
      transports.delete(transport)
      transport.close()
    })
  })
  let cleanupTask: Promise<void> | undefined
  cleanup = async () => {
    cleanupTask ??= (async () => {
      removeEventListener()
      const closed = new Promise<void>(resolve => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await withTimeout(closed, 1_000, '关闭 session control socket 超时').catch(() => {})
      for (const transport of transports) transport.close()
      transports.clear()
      await new Promise<void>(resolve => eventStream.end(resolve))
      await new Promise<void>(resolve => outputStream.end(resolve))
      await rm(request.controlSocketPath, { force: true })
      // During whole-tree shutdown the Agent can already be disposing through
      // its parent. Joining that same teardown here can form a lifecycle cycle,
      // so manual cleanup is bounded and the root remains the final owner.
      await withTimeout(handle.dispose(), 1_000, 'Agent cleanup joined root shutdown').catch(() => {})
    })()
    await cleanupTask
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(request.controlSocketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(request.controlSocketPath, 0o600)
  progress.line(`session control ready: ${request.runId}`)
  steer(request.prompt)

  return cleanup
}

async function loadRuntimeModules(runtimeRoot: string): Promise<RuntimeModules> {
  const load = async (name: string): Promise<Record<string, unknown>> => {
    return await import(pathToFileURL(await resolveRuntimePackage(runtimeRoot, name)).href) as Record<string, unknown>
  }
  const [llm, session, agent, protocol] = await Promise.all([
    load('@deepseek-ai/dsh-llm'),
    load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-sdk-protocol'),
  ])
  return {
    createUserMessage: llm.createUserMessage as RuntimeModules['createUserMessage'],
    SessionId: session.SessionId as RuntimeModules['SessionId'],
    installModelSelection: agent.installModelSelection as RuntimeModules['installModelSelection'],
    JsonRpcLineTransport: protocol.JsonRpcLineTransport as RuntimeModules['JsonRpcLineTransport'],
  }
}

async function resolveRuntimePackage(runtimeRoot: string, name: string): Promise<string> {
  const packagesRoot = join(runtimeRoot, 'packages')
  for (const group of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupRoot = join(packagesRoot, group.name)
    for (const candidate of await readdir(groupRoot, { withFileTypes: true })) {
      if (!candidate.isDirectory()) continue
      const directory = join(groupRoot, candidate.name)
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; main?: string }
        if (manifest.name === name) return resolve(directory, manifest.main ?? 'lib/index.js')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  throw new Error(`pinned Harness runtime 缺少 package ${name}`)
}

function summarize(events: SessionEventLike[], firstSeq: number): { text: string; reason?: string; error?: string } {
  let text = ''
  let reason: string | undefined
  let error: string | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'assistant/message') {
      const next = extractText(event.data.message).join('').trim()
      if (next !== '') text = next
    }
    if (event.type === 'turn/end') {
      const value = asRecord(event.data.reason)
      reason = typeof value?.kind === 'string' ? value.kind : undefined
      const detail = asRecord(value?.error)
      if (typeof detail?.message === 'string') error = detail.message
    }
  }
  return { text, reason, error }
}

function parseOutcome(output: string): { blocked: false } | { blocked: true; reason: string } {
  if (!/^DSHW_RESULT:\s*blocked\s*$/imu.test(output)) return { blocked: false }
  const reason = output.match(/^DSHW_REASON:\s*(.+?)\s*$/imu)?.[1]?.trim()
  return { blocked: true, reason: reason || 'dsh 未提供无法完成的具体原因' }
}

function extractText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(extractText)
  const item = asRecord(value)
  if (item === undefined) return []
  if (item.type === 'text' && typeof item.text === 'string') return [item.text]
  return extractText(item.content)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
