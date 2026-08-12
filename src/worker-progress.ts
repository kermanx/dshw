import type { DshWorkerProgress } from './types.ts'
import { now } from './util.ts'

export function createWorkerProgressReporter(runId: string, progressUrl: string): {
  startedAt: string
  phase(phase: DshWorkerProgress['phase'], message: string): void
  line(text: string): void
  flush(): Promise<void>
} {
  const startedAt = now()
  let phase: DshWorkerProgress['phase'] = 'starting'
  let message = 'worker 正在启动'
  const queue: Array<Record<string, string>> = []
  let draining: Promise<void> | undefined
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
        queue.length = 0
      }
    }
  }
  const startDrain = (): void => {
    if (draining !== undefined) return
    draining = drain().finally(() => {
      draining = undefined
      if (queue.length > 0) startDrain()
    })
  }
  const send = (line?: string): void => {
    queue.push({ runId, phase, message, startedAt, ...(line === undefined ? {} : { line }) })
    startDrain()
  }
  const heartbeat = setInterval(send, 5_000)
  heartbeat.unref()
  return {
    startedAt,
    phase(next, text) { phase = next; message = text; send() },
    line(text) { message = text.split('\n', 1)[0] ?? text; send(text) },
    async flush() {
      clearInterval(heartbeat)
      send()
      while (draining !== undefined) await draining
    },
  }
}
