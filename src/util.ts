import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
  cancelled: boolean
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  killProcessGroup?: boolean
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
}

export class TaskCancelledError extends Error {
  constructor(message = '任务已被手动终止') {
    super(message)
    this.name = 'TaskCancelledError'
  }
}

export function isTaskCancelled(error: unknown): error is TaskCancelledError {
  return error instanceof TaskCancelledError
}

export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted === true) {
    return { code: 130, stdout: '', stderr: '', cancelled: true }
  }
  return await new Promise((resolvePromise, reject) => {
    const detached = options.killProcessGroup === true && process.platform !== 'win32'
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let cancelled = false
    let forceKillTimer: NodeJS.Timeout | undefined
    const terminate = (): void => {
      if (cancelled) return
      cancelled = true
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      forceKillTimer = setTimeout(() => {
        try {
          if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {}
      }, 5_000)
      forceKillTimer.unref()
    }
    options.signal?.addEventListener('abort', terminate, { once: true })
    if (options.signal?.aborted === true) terminate()
    child.stdout.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      stdout.push(buffer)
      options.onOutput?.('stdout', buffer.toString('utf8'))
    })
    child.stderr.on('data', chunk => {
      const buffer = Buffer.from(chunk)
      stderr.push(buffer)
      options.onOutput?.('stderr', buffer.toString('utf8'))
    })
    child.on('error', reject)
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => child.kill('SIGTERM'), options.timeoutMs)
    timer?.unref()
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      options.signal?.removeEventListener('abort', terminate)
      resolvePromise({
        code: code ?? (signal === null ? 1 : 128),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        cancelled,
      })
    })
  })
}

export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const result = await run(command, args, options)
  if (result.cancelled) throw new TaskCancelledError()
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
  return result
}

export function now(): string {
  return new Date().toISOString()
}

export function after(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString()
}

export function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function finalOutput(stdout: string, stderr: string): string {
  const preferred = stdout.trim() || stderr.trim()
  return preferred || '(no output)'
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
