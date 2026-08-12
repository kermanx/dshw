import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EVENT_LOG_FILE, STATE_FILE } from './config.ts'
import type { EventRecord, JobPage, JobRecord, LogPage, ServiceState } from './types.ts'
import { id, now, readJson, writeJsonAtomic } from './util.ts'

const MAX_JOBS = 300
const MAX_DSH_RUNS = 100
const MAX_EVENTS = 100
const LOG_READ_CHUNK_SIZE = 64 * 1024

export class StateStore {
  state: ServiceState
  #listeners = new Set<() => void>()
  #saveChain = Promise.resolve()
  #logWriteChain = Promise.resolve()

  private constructor(state: ServiceState) {
    this.state = state
  }

  static async open(): Promise<StateStore> {
    const stored = await readJson<ServiceState>(STATE_FILE)
    const state: ServiceState = stored?.version === 2 ? stored : {
      version: 2,
      update: {},
      syncs: [],
      jobs: [],
      dshRuns: [],
      events: [],
    }
    await mkdir(dirname(EVENT_LOG_FILE), { recursive: true })
    let logSize = 0
    try {
      logSize = (await stat(EVENT_LOG_FILE)).size
    } catch {}
    // Upgrade path: seed the append-only log once from the events retained in state v2.
    if (logSize === 0 && state.events.length > 0) {
      await writeFile(EVENT_LOG_FILE, state.events.map(record => `${JSON.stringify(record)}\n`).join(''))
    }
    for (const job of state.jobs) {
      if (job.status === 'running') {
        if (job.dshWorker !== undefined) continue
        job.status = 'failed'
        job.finishedAt = now()
        job.summary = `${job.summary}（服务意外退出；状态将重新核对）`
        if (job.syncId !== undefined) {
          const sync = state.syncs.find(candidate => candidate.id === job.syncId)
          if (sync !== undefined) sync.immediateCheckRequestedAt = now()
        }
      }
    }
    return new StateStore(state)
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async changed(): Promise<void> {
    this.state.jobs = this.state.jobs.slice(-MAX_JOBS)
    this.state.dshRuns = this.state.dshRuns.slice(-MAX_DSH_RUNS)
    this.state.events = this.state.events.slice(-MAX_EVENTS)
    this.#saveChain = this.#saveChain.then(() => writeJsonAtomic(STATE_FILE, this.state))
    await Promise.all([this.#saveChain, this.#logWriteChain])
    for (const listener of this.#listeners) listener()
  }

  event(level: EventRecord['level'], kind: string, message: string): void {
    const record = { id: id('event'), time: now(), level, kind, message }
    this.state.events.push(record)
    this.#logWriteChain = this.#logWriteChain.then(() => appendFile(EVENT_LOG_FILE, `${JSON.stringify(record)}\n`))
  }

  async logs(before: string | undefined, limit: number): Promise<LogPage> {
    await this.#logWriteChain
    const beforeOffset = before === undefined ? undefined : Number.parseInt(before, 10)
    if (before !== undefined && (!/^\d+$/u.test(before) || !Number.isSafeInteger(beforeOffset))) {
      throw new Error('无效的日志游标')
    }
    return await readEventLogPage(EVENT_LOG_FILE, beforeOffset, limit)
  }

  jobs(before: string | undefined, limit: number): JobPage {
    return pageJobs(this.state.jobs.filter(job => job.type !== 'sync-check'), before, limit)
  }

  job(type: JobRecord['type'], summary: string, syncId?: string): JobRecord {
    const job: JobRecord = {
      id: id('job'),
      type,
      status: 'queued',
      syncId,
      createdAt: now(),
      summary,
    }
    this.state.jobs.push(job)
    return job
  }
}

export function pageJobs(jobs: readonly JobRecord[], before: string | undefined, limit: number): JobPage {
  const end = before === undefined ? jobs.length : jobs.findIndex(job => job.id === before)
  if (end < 0) throw new Error('无效的任务游标')
  const start = Math.max(0, end - limit)
  const records = jobs.slice(start, end).reverse()
  return {
    records,
    ...(start > 0 && records.length > 0 ? { nextCursor: records.at(-1)!.id } : {}),
    hasMore: start > 0,
  }
}

export async function readEventLogPage(path: string, before: number | undefined, limit: number): Promise<LogPage> {
  const size = (await stat(path).catch(() => ({ size: 0 }))).size
  const end = Math.min(before ?? size, size)
  if (end <= 0 || limit <= 0) return { records: [], hasMore: false }
  const handle = await open(path, 'r')
  const records: EventRecord[] = []
  let scanAt = end
  let lineEnd = end
  let nextOffset = end

  const readRecord = async (start: number, finish: number): Promise<void> => {
    if (finish <= start) return
    const bytes = Buffer.allocUnsafe(finish - start)
    await handle.read(bytes, 0, bytes.length, start)
    try {
      const value = JSON.parse(bytes.toString('utf8')) as EventRecord
      if (typeof value.id === 'string' && typeof value.time === 'string' && typeof value.kind === 'string' && typeof value.message === 'string') {
        records.push(value)
      }
    } catch {}
  }

  try {
    // Cursors always point to the first byte of the oldest record from the previous page.
    // Skip the newline immediately before that boundary before scanning older records.
    if (scanAt > 0) {
      const last = Buffer.allocUnsafe(1)
      await handle.read(last, 0, 1, scanAt - 1)
      if (last[0] === 10) {
        scanAt -= 1
        lineEnd = scanAt
      }
    }
    while (scanAt > 0 && records.length < limit) {
      const blockStart = Math.max(0, scanAt - LOG_READ_CHUNK_SIZE)
      const block = Buffer.allocUnsafe(scanAt - blockStart)
      await handle.read(block, 0, block.length, blockStart)
      for (let index = block.length - 1; index >= 0 && records.length < limit; index -= 1) {
        if (block[index] !== 10) continue
        const lineStart = blockStart + index + 1
        await readRecord(lineStart, lineEnd)
        nextOffset = lineStart
        lineEnd = blockStart + index
      }
      scanAt = blockStart
    }
    if (scanAt === 0 && records.length < limit && lineEnd > 0) {
      await readRecord(0, lineEnd)
      nextOffset = 0
    }
  } finally {
    await handle.close()
  }
  return {
    records,
    ...(nextOffset > 0 ? { nextCursor: String(nextOffset) } : {}),
    hasMore: nextOffset > 0,
  }
}
