import { STATE_FILE } from './config.ts'
import type { EventRecord, JobRecord, ServiceState } from './types.ts'
import { id, now, readJson, writeJsonAtomic } from './util.ts'

const MAX_JOBS = 300
const MAX_DSH_RUNS = 100
const MAX_EVENTS = 500

export class StateStore {
  state: ServiceState
  #listeners = new Set<() => void>()
  #saveChain = Promise.resolve()

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
    await this.#saveChain
    for (const listener of this.#listeners) listener()
  }

  event(level: EventRecord['level'], kind: string, message: string): void {
    this.state.events.push({ id: id('event'), time: now(), level, kind, message })
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
