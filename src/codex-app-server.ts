import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type JsonObject = Record<string, unknown>

export class CodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  readonly #onNotification: (frame: JsonObject) => void
  readonly #onExit: (error: Error) => void
  #nextId = 1
  #buffer = ''
  #closing = false

  constructor(
    executable: string,
    cwd: string,
    onNotification: (frame: JsonObject) => void = () => {},
    onExit: (error: Error) => void = () => {},
  ) {
    this.#onNotification = onNotification
    this.#onExit = onExit
    this.#child = spawn(executable, ['app-server', '--stdio'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', chunk => this.#accept(String(chunk)))
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', chunk => {
      const text = String(chunk).trim()
      if (text !== '') this.#onNotification({ method: 'worker/stderr', params: { text } })
    })
    this.#child.once('error', error => this.#failAll(error))
    this.#child.once('exit', (code, signal) => {
      if (this.#closing) return
      this.#failAll(new Error(`Codex app-server 意外退出（${code ?? signal ?? 'unknown'}）`))
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'dshw', title: 'dshw', version: '0.1.0' } })
    this.notify('initialized')
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Codex ${method} 请求超时`))
      }, 30_000)
      timer.unref()
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ id, method, params })
    })
  }

  notify(method: string, params?: JsonObject): void {
    this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  close(): void {
    this.#closing = true
    this.#child.kill('SIGTERM')
  }

  #write(frame: JsonObject): void {
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  #accept(chunk: string): void {
    this.#buffer += chunk
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line === '') continue
      let frame: JsonObject
      try { frame = JSON.parse(line) as JsonObject } catch { continue }
      if (typeof frame.id === 'number' && (frame.result !== undefined || frame.error !== undefined)) {
        const pending = this.#pending.get(frame.id)
        if (pending === undefined) continue
        this.#pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.error !== undefined) {
          const error = asRecord(frame.error)
          pending.reject(new Error(typeof error?.message === 'string' ? error.message : 'Codex request failed'))
        } else pending.resolve(asRecord(frame.result) ?? {})
      } else if (frame.id !== undefined && typeof frame.method === 'string') {
        this.#write({ id: frame.id, error: { code: -32601, message: 'dshw does not handle server requests' } })
      } else this.#onNotification(frame)
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.#onExit(error)
  }
}

function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}
