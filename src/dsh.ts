import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DATA_ROOT, DSHW_ROOT, HOST, LOG_ROOT, PORT, SERVICE_LABEL, WORKER_ROOT } from './config.ts'
import { dshWorkerLaunchEnvironmentXml } from './dsh-launch-env.ts'
import { formatProgressEvent } from './dsh-progress-plugin.ts'
import { ensureHarnessRuntime, missingTypertRuntimeArtifacts } from './dsh-runtime.ts'
export { missingTypertRuntimeArtifacts } from './dsh-runtime.ts'
import type { DshRunRecord, DshWorkerHandle, DshWorkerProgress, DshWorkerState, SyncRecord, WorkerExecutionConfig } from './types.ts'
import { escapeXml, id, now, readJson, run, runOrThrow, writeJsonAtomic } from './util.ts'

export interface DshWorkerRequest {
  runId: string
  resultPath: string
  progressUrl: string
  /** Legacy one-shot runner field; new workers use it only as their profile overlay. */
  patchPath: string
  controlSocketPath: string
  eventLogPath: string
  outputLogPath: string
  sync: SyncRecord
  kind: DshRunRecord['kind']
  prompt: string
  worker?: { provider?: string; model?: string; reasoningEffort?: string }
}

export function renderPromptTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (_match, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`dsh prompt 使用了未知占位符：${key}`)
    return value
  }).trim()
}

export function appendAdditionalInstruction(prompt: string, additionalInstruction?: string): string {
  const instruction = additionalInstruction?.trim()
  if (instruction === undefined || instruction === '') return prompt
  return `${prompt.trim()}\n\n## 用户额外指令\n\n${instruction}`
}

export function renderPeriodicAgentReminder(worker: DshWorkerState): string {
  const objective = worker.kind === 'merge-base'
    ? `把 origin/${worker.sync.baseRefName} 合并到 PR #${worker.sync.prNumber} 的当前分支并解决冲突`
    : worker.kind === 'fix-ci'
      ? `修复 PR #${worker.sync.prNumber} 启动本任务时已经失败的 CI checks`
      : `处理 PR #${worker.sync.prNumber} 启动本任务时尚未解决的 review threads`
  return [
    '# 20 分钟任务边界提醒',
    '',
    '这不是新任务。请继续执行最初的任务 prompt，并重新收敛到它规定的范围。',
    '',
    `当前唯一目标：${objective}。`,
    '',
    '完成必要修改和最小验证后，立即提交并 push 当前分支，然后输出最初 prompt 要求的最终结果并结束本次 agent 任务。',
    '',
    '不得等待、轮询、重跑或尝试触发 push 后的新 CI；新 CI 的等待、状态检查和后续任务派发全部由 dshw 负责。',
    '',
    '如果确认无法安全完成，请按最初 prompt 的 blocked 格式立即结束，不要扩展为其他任务。',
  ].join('\n')
}

export function parseDshOutcome(output: string): { blocked: false } | { blocked: true, reason: string } {
  if (!/^DSHW_RESULT:\s*blocked\s*$/imu.test(output)) return { blocked: false }
  const reason = output.match(/^DSHW_REASON:\s*(.+?)\s*$/imu)?.[1]?.trim()
  return { blocked: true, reason: reason === undefined || reason === '' ? 'dsh 未提供无法完成的具体原因' : reason }
}

export function headlessDshArguments(patchPath: string, prompt: string, usesRunSubcommand = false): string[] {
  return [
    ...(usesRunSubcommand ? ['run'] : []),
    '--profile', 'headless', '--patch', patchPath, prompt,
  ]
}

/** Keep the control plane rooted in the pinned runtime, never the target PR's tsconfig. */
export function dshWorkerLaunchSpec(
  runtimePath: string,
  patchPath: string,
  executable = process.execPath,
): { workingDirectory: string; programArguments: string[] } {
  return {
    workingDirectory: runtimePath,
    programArguments: [
      executable,
      join(runtimePath, 'apps', 'cli', 'lib', 'bin.js'),
      '--profile', 'headless', '--patch', patchPath,
    ],
  }
}

export async function loadWorkerPrompt(sync: SyncRecord, kind: DshRunRecord['kind'], additionalInstruction?: string): Promise<string> {
  const filename = kind === 'merge-base' ? 'merge-base.md' : kind === 'fix-ci' ? 'fix-ci.md' : 'resolve-comments.md'
  const template = await readFile(join(DSHW_ROOT, 'prompts', filename), 'utf8')
  return appendAdditionalInstruction(renderPromptTemplate(template, {
    clonePath: sync.clonePath,
    prNumber: String(sync.prNumber),
    branch: sync.branch,
    baseRefName: sync.baseRefName,
  }), additionalInstruction)
}

export async function startDshWorker(sync: SyncRecord, kind: DshRunRecord['kind'], worker: WorkerExecutionConfig, additionalInstruction?: string): Promise<DshWorkerHandle> {
  if (worker.type !== 'dsh') throw new Error(`${worker.type} worker 尚未实现`)
  const runId = id('dsh')
  const directory = join(WORKER_ROOT, runId)
  const requestPath = join(directory, 'request.json')
  const resultPath = join(directory, 'result.json')
  const patchPath = join(directory, 'session-worker.patch.yml')
  const plistPath = join(directory, 'worker.plist')
  const installationKey = createHash('sha256').update(DATA_ROOT).digest('hex').slice(0, 10)
  // macOS sockaddr_un paths are very short; /tmp is the stable short alias
  // for its much longer per-user TMPDIR. The 0700 directory is the access
  // boundary, while the socket itself is also chmod 0600 by the worker.
  const controlRoot = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `dshw-${installationKey}`)
  const controlSocketPath = join(controlRoot, `${runId}.sock`)
  const eventLogPath = join(directory, 'session-events.ndjson')
  const outputLogPath = join(LOG_ROOT, `${runId}.log`)
  const dshHome = join(directory, 'dsh-home')
  await mkdir(directory, { recursive: true })
  await mkdir(controlRoot, { recursive: true, mode: 0o700 })
  await chmod(controlRoot, 0o700)
  const runtime = await ensureHarnessRuntime()
  const prompt = await loadWorkerPrompt(sync, kind, additionalInstruction)
  const pluginUrl = pathToFileURL(fileURLToPath(new URL('./dsh-session-plugin.ts', import.meta.url))).href
  await writeFile(patchPath, [
    '- id: headless-startup',
    '  disabled: true',
    '- id: headless-runner',
    '  disabled: true',
    '- insert:',
    '    - id: dshw-session-worker',
    `      name: ${JSON.stringify(pluginUrl)}`,
    '      inject: [agentDefaultModel, agents, sessions]',
    '      config:',
    `        requestPath: ${JSON.stringify(requestPath)}`,
    '',
  ].join('\n'))
  const request: DshWorkerRequest = {
    runId,
    resultPath,
    progressUrl: `http://${HOST}:${PORT}/api/worker-progress`,
    patchPath,
    controlSocketPath,
    eventLogPath,
    outputLogPath,
    sync: structuredClone(sync),
    kind,
    prompt,
    worker: { provider: worker.provider, model: worker.model, reasoningEffort: worker.reasoningEffort },
  }
  await writeJsonAtomic(requestPath, request)
  const label = `${SERVICE_LABEL}.worker.${runId}`
  const domain = `gui/${uid()}/${label}`
  const path = process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  // Node 24 loads dshw's TypeScript plugin natively. Installing tsx here
  // would make its tsconfig-path hook inspect the PR worktree and redirect
  // pinned runtime imports into the PR branch's uninstalled source tree.
  const launch = dshWorkerLaunchSpec(runtime.path, patchPath)
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key><array>${launch.programArguments.map(value => `<string>${escapeXml(value)}</string>`).join('')}</array>
  <!-- Keep process/package resolution inside the pinned runtime. The agent's
       actual repository cwd is carried separately by session meta.cwd. -->
  <key>WorkingDirectory</key><string>${escapeXml(launch.workingDirectory)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
    <key>DSH_PERMISSION_MODE</key><string>danger-full-access</string>
    <key>DSH_HOME</key><string>${escapeXml(dshHome)}</string>
    <key>DSHW_DATA_ROOT</key><string>${escapeXml(DATA_ROOT)}</string>
    <key>DSHW_HARNESS_RUNTIME_ROOT</key><string>${escapeXml(runtime.path)}</string>
    ${process.env.DSHW_INSTALLATION_ID === undefined ? '' : `<key>DSHW_INSTALLATION_ID</key><string>${escapeXml(process.env.DSHW_INSTALLATION_ID)}</string>`}
    ${dshWorkerLaunchEnvironmentXml(process.env, undefined, {
      ...(worker.apiKeyEnv === undefined ? {} : { [worker.apiKeyEnv]: worker.apiKey }),
      DEEPSEEK_BASE_URL: worker.baseUrl,
      DEEPSEEK_SEARCH_BASE_URL: worker.searchBaseUrl,
    })}
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(directory, 'worker.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(directory, 'worker.stderr.log'))}</string>
</dict></plist>
`
  await writeFile(plistPath, plist, { mode: 0o600 })
  await runOrThrow('launchctl', ['bootstrap', `gui/${uid()}`, plistPath])
  try {
    await runOrThrow('launchctl', ['kickstart', domain])
  } catch (error) {
    await run('launchctl', ['bootout', domain])
    throw error
  }
  return {
    runId,
    label,
    domain,
    plistPath,
    requestPath,
    resultPath,
    controlSocketPath,
    eventLogPath,
    runtimeCommit: runtime.commit,
    workerType: 'dsh',
    progressProtocol: 'session-control-v1',
    startedAt: now(),
  }
}

export async function steerDshWorker(handle: DshWorkerHandle, prompt: string): Promise<void> {
  await requestWorker(handle, 'session.steer', { prompt })
}

export async function cancelDshWorker(handle: DshWorkerHandle): Promise<void> {
  await requestWorker(handle, 'session.cancel', {})
}

export async function inspectDshWorker(handle: DshWorkerHandle): Promise<DshWorkerProgress> {
  const result = await requestWorker(handle, 'session.status', {}) as {
    phase?: DshWorkerProgress['phase']
  }
  const lines = handle.workerType === 'codex'
    ? await readWorkerOutputTail(handle.runId)
    : await readWorkerEventTail(handle.eventLogPath)
  const phase = ['starting', 'running', 'cancelling', 'paused', 'finishing'].includes(result.phase ?? '')
    ? result.phase!
    : 'running'
  return {
    runId: handle.runId,
    phase,
    message: lines.at(-1) ?? (phase === 'paused' ? '任务已暂停' : 'dsh agent 正在运行'),
    startedAt: handle.startedAt,
    updatedAt: now(),
    outputTail: `${lines.join('\n')}\n`.slice(-48_000),
  }
}

async function readWorkerEventTail(path: string | undefined): Promise<string[]> {
  if (path === undefined) return []
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const length = Math.min(size, 256 * 1024)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    const source = buffer.toString('utf8')
    const records = source.split('\n')
    if (size > length) records.shift()
    return records.flatMap(line => {
      if (line.trim() === '') return []
      try {
        const event = JSON.parse(line) as { type: string; data: Record<string, unknown> }
        const text = formatProgressEvent(event)
        return text === undefined ? [] : [text]
      } catch {
        return []
      }
    })
  } finally {
    await file.close()
  }
}

async function readWorkerOutputTail(runId: string): Promise<string[]> {
  try {
    const source = await readFile(join(LOG_ROOT, `${runId}.log`), 'utf8')
    return source.slice(-256 * 1024).split('\n').filter(Boolean)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function terminateDshWorker(handle: DshWorkerHandle): Promise<void> {
  try {
    await requestWorker(handle, 'runtime.terminate', {}, 1_500)
  } catch {
    await signalWorker(handle, 'SIGTERM')
  }
}

async function requestWorker(
  handle: DshWorkerHandle,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<unknown> {
  const socketPath = handle.controlSocketPath
  if (socketPath === undefined) throw new Error('这个任务由旧版 worker 启动，不支持 session 控制')
  const id = `dshw-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => finish(new Error(`worker ${method} 请求超时`)), timeoutMs)
    const finish = (error?: Error, value?: unknown): void => {
      clearTimeout(timer)
      socket.destroy()
      if (error === undefined) resolve(value)
      else reject(error)
    }
    socket.setEncoding('utf8')
    socket.once('error', error => finish(new Error(`无法连接 Worker：${error.message}`)))
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    socket.on('data', chunk => {
      buffer += chunk
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        let frame: { id?: unknown; result?: unknown; error?: { message?: unknown } }
        try { frame = JSON.parse(line) as typeof frame } catch { continue }
        if (frame.id !== id) continue
        if (frame.error !== undefined) finish(new Error(typeof frame.error.message === 'string' ? frame.error.message : `${method} 失败`))
        else finish(undefined, frame.result)
        return
      }
    })
  })
}

export async function waitForDshWorker(handle: DshWorkerHandle, signal?: AbortSignal): Promise<DshRunRecord> {
  let cancelled = false
  let notRunningSince: number | undefined
  let forceKillTimer: NodeJS.Timeout | undefined
  const terminate = (): void => {
    if (cancelled) return
    cancelled = true
    void terminateDshWorker(handle)
    forceKillTimer = setTimeout(() => void signalWorker(handle, 'SIGKILL'), 5_000)
    forceKillTimer.unref()
  }
  signal?.addEventListener('abort', terminate, { once: true })
  if (signal?.aborted === true) terminate()
  try {
    while (true) {
      const result = await readJson<DshRunRecord>(handle.resultPath)
      if (result !== undefined) return result
      if (!await workerAlive(handle)) {
        notRunningSince ??= Date.now()
        // kickstart returns before launchd necessarily reports the process as
        // running, and a very short worker may exit just before its atomic
        // result file becomes visible. Give both transitions a small grace.
        if (Date.now() - notRunningSince >= 2_000) {
          return await recordInterruptedWorker(handle, cancelled)
        }
      } else {
        notRunningSince = undefined
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } finally {
    signal?.removeEventListener('abort', terminate)
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
    await run('launchctl', ['bootout', handle.domain])
  }
}

async function recordInterruptedWorker(handle: DshWorkerHandle, cancelled: boolean): Promise<DshRunRecord> {
  const workerName = handle.workerType ?? 'dsh'
  let output = cancelled ? '任务已被手动终止' : `${workerName} worker 意外退出，未写入结果`
  if (!cancelled) {
    try {
      const stderr = (await readFile(join(dirname(handle.requestPath), 'worker.stderr.log'), 'utf8')).trim()
      if (stderr !== '') output = `${workerName} worker 意外退出：${stderr.slice(-4_000)}`
    } catch { /* the generic reason still explains that the worker died before persisting a result */ }
  }
  const request = await readJson<DshWorkerRequest>(handle.requestPath)
  if (request === undefined) throw new Error(`Worker request 不存在：${handle.requestPath}`)
  const record: DshRunRecord = {
    id: handle.runId,
    syncId: request.sync.id,
    kind: request.kind,
    clonePath: request.sync.clonePath,
    startedAt: handle.startedAt,
    finishedAt: now(),
    status: cancelled ? 'cancelled' : 'failed',
    finalOutput: output,
  }
  await mkdir(LOG_ROOT, { recursive: true })
  await writeFile(join(LOG_ROOT, `${handle.runId}.txt`), `${output}\n`)
  await writeJsonAtomic(handle.resultPath, record)
  return record
}

async function workerAlive(handle: DshWorkerHandle): Promise<boolean> {
  const result = await run('launchctl', ['print', handle.domain])
  return result.code === 0 && /\bstate = running\b/.test(result.stdout)
}

async function signalWorker(handle: DshWorkerHandle, signal: NodeJS.Signals): Promise<void> {
  await run('launchctl', ['kill', signal, handle.domain])
}

function uid(): number {
  if (process.getuid === undefined) throw new Error('dsh worker 目前只支持 macOS/Unix')
  return process.getuid()
}
