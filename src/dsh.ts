import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DATA_ROOT, DSHW_ROOT, HOST, LOG_ROOT, PORT, SERVICE_LABEL, WORKER_ROOT } from './config.ts'
import { dshLaunchEnvironmentXml } from './dsh-launch-env.ts'
import type { DshRunRecord, DshWorkerHandle, DshWorkerProgress, SyncRecord } from './types.ts'
import { escapeXml, finalOutput, id, now, readJson, run, runOrThrow, writeJsonAtomic } from './util.ts'

export interface DshWorkerRequest {
  runId: string
  resultPath: string
  progressUrl: string
  patchPath: string
  sync: SyncRecord
  kind: DshRunRecord['kind']
}

export function renderPromptTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (_match, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`dsh prompt 使用了未知占位符：${key}`)
    return value
  }).trim()
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

function runtimeExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const conditions = value as Record<string, unknown>
  return runtimeExportTarget(conditions.default) ?? runtimeExportTarget(conditions.import)
}

/** 返回 workspace package 声明但尚未生成的 Host TypeRT runtime 产物。 */
export async function missingTypertRuntimeArtifacts(clonePath: string): Promise<string[]> {
  const packagesRoot = join(clonePath, 'packages')
  const manifests: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await Promise.all(entries.map(async entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name === 'package.json') manifests.push(path)
    }))
  }
  await visit(packagesRoot)
  const missing: string[] = []
  await Promise.all(manifests.map(async manifestPath => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { exports?: Record<string, unknown> }
    const target = runtimeExportTarget(manifest.exports?.['./typert'])
    if (target === undefined || !target.startsWith('./')) return
    const artifact = resolve(dirname(manifestPath), target)
    try {
      await access(artifact)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(artifact)
    }
  }))
  return missing.sort()
}

/** 自动克隆的 worktree 首次运行时安装依赖，并补齐其声明但缺失的 TypeRT runtime 产物。 */
async function ensureCloneRuntimeReady(clonePath: string): Promise<void> {
  try {
    createRequire(join(clonePath, 'package.json')).resolve('tsx/esm')
  } catch {
    await runOrThrow('pnpm', ['install', '--frozen-lockfile'], { cwd: clonePath, timeoutMs: 10 * 60 * 1000 })
  }
  const missing = await missingTypertRuntimeArtifacts(clonePath)
  if (missing.length === 0) return
  await runOrThrow('pnpm', ['run', 'build:lib:host'], { cwd: clonePath, timeoutMs: 10 * 60 * 1000 })
  const stillMissing = await missingTypertRuntimeArtifacts(clonePath)
  if (stillMissing.length > 0) {
    throw new Error(`Host TypeRT 构建后仍缺少 runtime 产物：${stillMissing.join(', ')}`)
  }
}

async function targetDshCommand(clonePath: string, patchPath: string, prompt: string): Promise<{ executable: string, args: string[] }> {
  const executableOverride = process.env.DSHW_DSH_EXECUTABLE
  if (executableOverride !== undefined) {
    return { executable: executableOverride, args: headlessDshArguments(patchPath, prompt) }
  }
  await ensureCloneRuntimeReady(clonePath)
  const targetRequire = createRequire(join(clonePath, 'package.json'))
  const cliPath = join(clonePath, 'apps', 'cli', 'src', 'bin.ts')
  const argsSource = await readFile(join(clonePath, 'apps', 'cli', 'src', 'args.ts'), 'utf8')
  const usesRunSubcommand = /\.command\(\s*['"]run['"]\s*\)/u.test(argsSource)
  return {
    executable: process.execPath,
    args: [
      '--import',
      targetRequire.resolve('tsx/esm'),
      cliPath,
      ...headlessDshArguments(patchPath, prompt, usesRunSubcommand),
    ],
  }
}

async function loadPrompt(sync: SyncRecord, kind: DshRunRecord['kind']): Promise<string> {
  const filename = kind === 'merge-base' ? 'merge-base.md' : 'fix-ci.md'
  const template = await readFile(join(DSHW_ROOT, 'prompts', filename), 'utf8')
  return renderPromptTemplate(template, {
    clonePath: sync.clonePath,
    prNumber: String(sync.prNumber),
    branch: sync.branch,
    baseRefName: sync.baseRefName,
  })
}

export async function startDshWorker(sync: SyncRecord, kind: DshRunRecord['kind']): Promise<DshWorkerHandle> {
  const runId = id('dsh')
  const directory = join(WORKER_ROOT, runId)
  const requestPath = join(directory, 'request.json')
  const resultPath = join(directory, 'result.json')
  const patchPath = join(directory, 'progress.patch.yml')
  const plistPath = join(directory, 'worker.plist')
  await mkdir(directory, { recursive: true })
  const pluginUrl = pathToFileURL(fileURLToPath(new URL('./dsh-progress-plugin.ts', import.meta.url))).href
  await writeFile(patchPath, `- insert:\n    - id: dshw-progress\n      name: ${JSON.stringify(pluginUrl)}\n`)
  const request: DshWorkerRequest = {
    runId,
    resultPath,
    progressUrl: `http://${HOST}:${PORT}/api/worker-progress`,
    patchPath,
    sync: structuredClone(sync),
    kind,
  }
  await writeJsonAtomic(requestPath, request)
  const workerPath = fileURLToPath(new URL('./dsh-worker.ts', import.meta.url))
  const label = `${SERVICE_LABEL}.worker.${runId}`
  const domain = `gui/${uid()}/${label}`
  const path = process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(workerPath)}</string><string>${escapeXml(requestPath)}</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(sync.clonePath)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
    <key>DSH_PERMISSION_MODE</key><string>danger-full-access</string>
    <key>DSHW_DATA_ROOT</key><string>${escapeXml(DATA_ROOT)}</string>
    ${dshLaunchEnvironmentXml(process.env)}
    ${process.env.DSHW_DSH_EXECUTABLE === undefined ? '' : `<key>DSHW_DSH_EXECUTABLE</key><string>${escapeXml(process.env.DSHW_DSH_EXECUTABLE)}</string>`}
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(directory, 'worker.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(directory, 'worker.stderr.log'))}</string>
</dict></plist>
`
  await writeFile(plistPath, plist)
  await runOrThrow('launchctl', ['bootstrap', `gui/${uid()}`, plistPath])
  try {
    await runOrThrow('launchctl', ['kickstart', domain])
  } catch (error) {
    await run('launchctl', ['bootout', domain])
    throw error
  }
  return { runId, label, domain, plistPath, requestPath, resultPath, progressProtocol: 'memory-events-v1', startedAt: now() }
}

export async function waitForDshWorker(handle: DshWorkerHandle, signal?: AbortSignal): Promise<DshRunRecord> {
  let cancelled = false
  let notRunningSince: number | undefined
  let forceKillTimer: NodeJS.Timeout | undefined
  const terminate = (): void => {
    if (cancelled) return
    cancelled = true
    void signalWorker(handle, 'SIGTERM')
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

export async function executeDshWorker(request: DshWorkerRequest): Promise<DshRunRecord> {
  const startedAt = now()
  await mkdir(LOG_ROOT, { recursive: true })
  const logStream = createWriteStream(join(LOG_ROOT, `${request.runId}.log`))
  const progress = createProgressReporter(request.runId, request.progressUrl, startedAt)
  const decoder = createProgressDecoder({
    line(text) {
      logStream.write(`${text}\n`)
      progress.line(text)
    },
  })
  let status: DshRunRecord['status'] = 'failed'
  let output = '(no output)'
  const controller = new AbortController()
  const terminate = (): void => controller.abort()
  process.once('SIGTERM', terminate)
  process.once('SIGINT', terminate)
  try {
    progress.phase('starting', '正在读取任务提示词')
    const prompt = await loadPrompt(request.sync, request.kind)
    progress.phase('running', 'dsh agent 正在运行')
    const command = await targetDshCommand(request.sync.clonePath, request.patchPath, prompt)
    const result = await run(command.executable, command.args, {
      cwd: request.sync.clonePath,
      env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access' },
      timeoutMs: 2 * 60 * 60 * 1000,
      signal: controller.signal,
      killProcessGroup: true,
      onOutput: (stream, chunk) => decoder.push(stream, chunk),
    })
    decoder.flush()
    output = finalOutput(result.stdout, stripProgressFrames(result.stderr))
    if (result.cancelled) {
      status = 'cancelled'
    } else if (result.code !== 0) {
      status = 'failed'
    } else {
      const outcome = parseDshOutcome(output)
      status = outcome.blocked ? 'blocked' : 'succeeded'
    }
  } catch (error) {
    output = error instanceof Error ? error.message : String(error)
  } finally {
    decoder.flush()
    progress.phase('finishing', controller.signal.aborted ? '正在终止并保存结果' : '正在保存最终结果')
    await progress.flush()
    logStream.end()
    process.removeListener('SIGTERM', terminate)
    process.removeListener('SIGINT', terminate)
  }
  const outcome = parseDshOutcome(output)
  const record: DshRunRecord = {
    id: request.runId,
    syncId: request.sync.id,
    kind: request.kind,
    clonePath: request.sync.clonePath,
    startedAt,
    finishedAt: now(),
    status,
    finalOutput: output,
    ...(status === 'blocked' && outcome.blocked ? { blockedReason: outcome.reason } : {}),
  }
  await writeFile(join(LOG_ROOT, `${request.runId}.txt`), `${output}\n`)
  await writeJsonAtomic(request.resultPath, record)
  return record
}

function createProgressReporter(runId: string, progressUrl: string, startedAt: string): {
  phase: (phase: DshWorkerProgress['phase'], message: string) => void
  line: (text: string) => void
  flush: () => Promise<void>
} {
  let phase: DshWorkerProgress['phase'] = 'starting'
  let message = 'worker 正在启动'
  const queue: Array<Record<string, string>> = []
  let drainPromise: Promise<void> | undefined
  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const payload = queue.shift()
      if (payload === undefined) continue
      try {
        await fetch(progressUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(750),
        })
      } catch {
        // Progress is deliberately best-effort and memory-only. Drop queued
        // history while the daemon is restarting; the heartbeat reconnects.
        queue.length = 0
      }
    }
  }
  const startDrain = (): void => {
    if (drainPromise !== undefined) return
    drainPromise = drain().finally(() => {
      drainPromise = undefined
      if (queue.length > 0) startDrain()
    })
  }
  const send = (line?: string): void => {
    queue.push({ runId, phase, message, startedAt, ...(line === undefined ? {} : { line }) })
    startDrain()
  }
  const heartbeat = setInterval(() => send(), 5_000)
  heartbeat.unref()
  return {
    phase(nextPhase, nextMessage) {
      phase = nextPhase
      message = nextMessage
      send()
    },
    line(text) {
      const clean = stripTerminalControl(text).trim()
      if (clean === '') return
      message = clean.split('\n', 1)[0] ?? clean
      send(clean)
    },
    async flush() {
      clearInterval(heartbeat)
      send()
      while (drainPromise !== undefined) await drainPromise
    },
  }
}

const PROGRESS_FRAME_PREFIX = '\u001edshw-progress '

function createProgressDecoder(progress: { line(text: string): void }): {
  push(stream: 'stdout' | 'stderr', chunk: string): void
  flush(): void
} {
  let stderrBuffer = ''
  const consumeStderrLine = (line: string): void => {
    if (line.startsWith(PROGRESS_FRAME_PREFIX)) {
      try {
        const value = JSON.parse(line.slice(PROGRESS_FRAME_PREFIX.length)) as { text?: unknown }
        if (typeof value.text === 'string') progress.line(value.text)
      } catch {
        progress.line(`[stderr] ${line}`)
      }
      return
    }
    if (line.trim() !== '') progress.line(`[stderr] ${line}`)
  }
  return {
    push(stream, chunk) {
      if (stream === 'stdout') {
        progress.line(chunk)
        return
      }
      stderrBuffer += chunk
      while (true) {
        const newline = stderrBuffer.indexOf('\n')
        if (newline < 0) break
        consumeStderrLine(stderrBuffer.slice(0, newline))
        stderrBuffer = stderrBuffer.slice(newline + 1)
      }
    },
    flush() {
      if (stderrBuffer !== '') consumeStderrLine(stderrBuffer)
      stderrBuffer = ''
    },
  }
}

function stripProgressFrames(value: string): string {
  return value.split('\n').filter(line => !line.startsWith(PROGRESS_FRAME_PREFIX)).join('\n')
}

function stripTerminalControl(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '')
}

async function recordInterruptedWorker(handle: DshWorkerHandle, cancelled: boolean): Promise<DshRunRecord> {
  const output = cancelled ? '任务已被手动终止' : 'dsh worker 意外退出，未写入结果'
  const request = await readJson<DshWorkerRequest>(handle.requestPath)
  if (request === undefined) throw new Error(`dsh worker request 不存在：${handle.requestPath}`)
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
