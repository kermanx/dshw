import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexAppServerClient, type JsonObject } from './codex-app-server.ts'
import type { CodexWorkerRequest } from './codex.ts'
import { parseDshOutcome } from './dsh.ts'
import type { WorkerProgress, WorkerRunRecord } from './types.ts'
import { now, readJson, writeJsonAtomic } from './util.ts'
import { createWorkerProgressReporter } from './worker-progress.ts'

type WorkerPhase = WorkerProgress['phase'] | 'completed'

export function codexThreadStartParams(request: Pick<CodexWorkerRequest, 'sync' | 'worker'>): JsonObject {
  return {
    cwd: request.sync.clonePath,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    serviceName: 'dshw',
    ...(request.worker.model === undefined ? {} : { model: request.worker.model }),
  }
}

export function codexTurnStartParams(threadId: string, prompt: string, worker: CodexWorkerRequest['worker']): JsonObject {
  return {
    threadId,
    input: [{ type: 'text', text: prompt }],
    ...(worker.reasoningEffort === undefined ? {} : { effort: worker.reasoningEffort }),
  }
}

export function formatCodexThreadItem(item: JsonObject): string[] {
  if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim() !== '') {
    return [`Agent：${clip(item.text, 3_000)}`]
  }
  if (item.type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : '(unknown command)'
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trim() : ''
    const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
    return [
      `调用工具 exec_command：${clip(command, 1_200)}`,
      `工具结果 ${failed ? `失败（exit ${String(item.exitCode ?? '?')}）` : '完成'}${output === '' ? '' : `：${clip(output, 2_000)}`}`,
    ]
  }
  if (item.type === 'fileChange') {
    const failed = item.status === 'failed'
    return ['调用工具 apply_patch：(文件修改)', `工具结果 ${failed ? '失败（apply_patch）' : '完成'}`]
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const server = typeof item.server === 'string' ? `${item.server}.` : ''
    const tool = typeof item.tool === 'string' ? item.tool : 'tool'
    const failed = item.status === 'failed' || item.success === false
    return [
      `调用工具 ${server}${tool}：${clip(pretty(item.arguments), 1_200)}`,
      `工具结果 ${failed ? '失败（tool）' : '完成'}${item.result === undefined ? '' : `：${clip(pretty(item.result), 2_000)}`}`,
    ]
  }
  if (item.type === 'webSearch') {
    return [`调用工具 web_search：${clip(typeof item.query === 'string' ? item.query : pretty(item.action), 1_200)}`, '工具结果 完成']
  }
  return []
}

async function main(): Promise<void> {
  const requestPath = process.argv[2]
  if (requestPath === undefined) throw new Error('Codex worker 缺少 request path')
  const request = await readJson<CodexWorkerRequest>(requestPath)
  if (request === undefined) throw new Error(`Codex worker request 不存在：${requestPath}`)
  await runWorker(request)
}

async function runWorker(request: CodexWorkerRequest): Promise<void> {
  await mkdir(dirname(request.controlSocketPath), { recursive: true })
  await rm(request.controlSocketPath, { force: true })
  const eventStream = createWriteStream(request.eventLogPath, { flags: 'a' })
  const outputStream = createWriteStream(request.outputLogPath, { flags: 'a' })
  const progress = createWorkerProgressReporter(request.runId, request.progressUrl)
  let phase: WorkerPhase = 'starting'
  let threadId: string | undefined
  let activeTurnId: string | undefined
  let finalMessage = ''
  let failure: string | undefined
  let settled = false
  let terminating = false
  let pendingAfterCancel: string[] = []
  let server: Server | undefined
  const sockets = new Set<Socket>()

  const setPhase = (next: WorkerPhase, message: string): void => {
    phase = next
    if (next !== 'completed') progress.phase(next, message)
  }
  const writeProgress = (line: string): void => {
    outputStream.write(`${line}\n`)
    progress.line(line)
  }
  const finish = async (forced = false): Promise<void> => {
    if (settled) return
    settled = true
    terminating = forced
    setPhase('finishing', forced ? '正在终止 Codex 任务' : 'Codex 任务正在收尾')
    const parsed = parseDshOutcome(finalMessage)
    const status: WorkerRunRecord['status'] = forced ? 'cancelled' : failure !== undefined ? 'failed' : parsed.blocked ? 'blocked' : 'succeeded'
    const output = forced
      ? '任务已被手动终止'
      : failure ?? (finalMessage || 'Codex 任务已完成')
    const record: WorkerRunRecord = {
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
    phase = 'completed'
    await progress.flush()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
    client.close()
    await new Promise<void>(resolve => eventStream.end(resolve))
    await new Promise<void>(resolve => outputStream.end(resolve))
    await rm(request.controlSocketPath, { force: true })
    process.exit(status === 'succeeded' || status === 'blocked' ? 0 : 1)
  }
  const fail = (error: unknown): void => {
    if (settled) return
    failure = error instanceof Error ? error.message : String(error)
    writeProgress(`[stderr] ${failure}`)
    void finish(false)
  }

  const client = new CodexAppServerClient(request.codexExecutable, request.sync.clonePath, frame => {
    eventStream.write(`${JSON.stringify(frame)}\n`)
    const params = asRecord(frame.params)
    if (frame.method === 'worker/stderr' && typeof params?.text === 'string') {
      writeProgress(`[stderr] ${params.text}`)
      return
    }
    if (frame.method === 'item/completed' && params !== undefined && params.threadId === threadId) {
      const item = asRecord(params.item)
      if (item !== undefined) {
        if (item.type === 'agentMessage' && typeof item.text === 'string') finalMessage = item.text.trim()
        for (const line of formatCodexThreadItem(item)) writeProgress(line)
      }
      return
    }
    if (frame.method === 'turn/completed' && params !== undefined && params.threadId === threadId) {
      const turn = asRecord(params.turn)
      if (turn === undefined || turn.id !== activeTurnId) return
      activeTurnId = undefined
      if (turn.status === 'interrupted') {
        if (terminating) void finish(true)
        else {
          setPhase('paused', '任务已暂停，可以发送新指令继续')
          const queued = pendingAfterCancel
          pendingAfterCancel = []
          for (const prompt of queued) void steer(prompt).catch(fail)
        }
      } else if (turn.status === 'failed') {
        const error = asRecord(turn.error)
        failure = typeof error?.message === 'string' ? error.message : 'Codex turn 失败'
        void finish(false)
      } else if (turn.status === 'completed') {
        void finish(false)
      }
      return
    }
    if (frame.method === 'error' && params !== undefined && params.threadId === threadId && params.willRetry !== true) {
      const error = asRecord(params.error)
      fail(typeof error?.message === 'string' ? error.message : 'Codex app-server error')
    }
  }, error => {
    if (!settled) fail(error)
  })

  const startTurn = async (prompt: string): Promise<void> => {
    if (threadId === undefined) throw new Error('Codex thread 尚未创建')
    const response = await client.request('turn/start', codexTurnStartParams(threadId, prompt, request.worker))
    const turn = asRecord(response.turn)
    if (typeof turn?.id !== 'string') throw new Error('Codex turn/start 未返回 turn id')
    activeTurnId = turn.id
    setPhase('running', 'Codex 正在执行任务')
  }
  const steer = async (prompt: string): Promise<void> => {
    if (settled) throw new Error('任务已结束，无法 steer')
    if (prompt.trim() === '') throw new Error('steer 内容不能为空')
    if (phase === 'cancelling') {
      pendingAfterCancel.push(prompt)
      return
    }
    if (threadId === undefined) throw new Error('Codex thread 尚未创建')
    if (activeTurnId === undefined) {
      await startTurn(prompt)
      return
    }
    await client.request('turn/steer', {
      threadId,
      expectedTurnId: activeTurnId,
      input: [{ type: 'text', text: prompt }],
    })
    setPhase('running', '已向当前 Codex turn 追加指令')
  }
  const cancel = async (): Promise<void> => {
    if (settled) throw new Error('任务已结束，无法 cancel')
    if (activeTurnId === undefined || phase === 'paused' || phase === 'cancelling') return
    setPhase('cancelling', '正在中断当前 Codex turn')
    await client.request('turn/interrupt', { threadId, turnId: activeTurnId })
  }

  progress.phase('starting', '正在启动本机 Codex')
  await client.initialize()
  const threadResponse = await client.request('thread/start', codexThreadStartParams(request))
  const thread = asRecord(threadResponse.thread)
  if (typeof thread?.id !== 'string') throw new Error('Codex thread/start 未返回 thread id')
  threadId = thread.id

  server = createServer(socket => {
    sockets.add(socket)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        void handleControlLine(line, socket, {
          status: () => ({ phase, agentStatus: activeTurnId === undefined ? 'idle' : 'running', pendingAfterCancel: pendingAfterCancel.length }),
          steer,
          cancel,
          terminate: async () => {
            terminating = true
            if (activeTurnId !== undefined && threadId !== undefined) {
              await client.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {})
            }
            await finish(true)
          },
        })
      }
    })
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(request.controlSocketPath, () => {
      server!.off('error', reject)
      resolve()
    })
  })
  await chmod(request.controlSocketPath, 0o600)
  writeProgress(`session control ready: ${request.runId}`)
  process.once('SIGTERM', () => { void finish(true) })
  process.once('SIGINT', () => { void finish(true) })
  await startTurn(request.prompt)
}

async function handleControlLine(
  line: string,
  socket: Socket,
  actions: {
    status(): JsonObject
    steer(prompt: string): Promise<void>
    cancel(): Promise<void>
    terminate(): Promise<void>
  },
): Promise<void> {
  let frame: JsonObject
  try { frame = JSON.parse(line) as JsonObject } catch { return }
  const params = asRecord(frame.params) ?? {}
  try {
    let result: JsonObject
    if (frame.method === 'session.status') result = actions.status()
    else if (frame.method === 'session.steer') {
      if (typeof params.prompt !== 'string') throw new Error('session.steer 缺少 prompt')
      await actions.steer(params.prompt)
      result = { accepted: true }
    } else if (frame.method === 'session.cancel') {
      await actions.cancel()
      result = { accepted: true }
    } else if (frame.method === 'runtime.terminate') {
      setImmediate(() => { void actions.terminate() })
      result = { accepted: true }
    } else throw new Error(`unknown dshw worker method: ${String(frame.method)}`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`)
  } catch (error) {
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { message: error instanceof Error ? error.message : String(error) } })}\n`)
  }
}

function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function clip(value: string, length: number): string {
  const normalized = value.trim()
  return normalized.length <= length ? normalized : `${normalized.slice(0, length)}…`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
