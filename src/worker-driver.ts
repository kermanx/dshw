import { startCodexWorker } from './codex.ts'
import { detectCodexRuntime, readCodexModelCatalog } from './codex-runtime.ts'
import {
  cancelDshWorker,
  inspectDshWorker,
  startDshWorker,
  steerDshWorker,
  terminateDshWorker,
  waitForDshWorker,
} from './dsh.ts'
import type {
  SyncRecord,
  WorkerExecutionConfig,
  WorkerHandle,
  WorkerModelCatalog,
  WorkerProgress,
  WorkerRunRecord,
  WorkerType,
  WorkerTypeAvailability,
} from './types.ts'

export interface WorkerDriver {
  readonly type: WorkerType
  readonly availability: WorkerTypeAvailability
  modelCatalog(provider?: string): Promise<WorkerModelCatalog>
  start(sync: SyncRecord, kind: WorkerRunRecord['kind'], config: WorkerExecutionConfig, additionalInstruction?: string): Promise<WorkerHandle>
  wait(handle: WorkerHandle, signal?: AbortSignal): Promise<WorkerRunRecord>
  inspect(handle: WorkerHandle): Promise<WorkerProgress>
  steer(handle: WorkerHandle, prompt: string): Promise<void>
  cancel(handle: WorkerHandle): Promise<void>
  terminate(handle: WorkerHandle): Promise<void>
}

export class WorkerRegistry {
  readonly #drivers: Map<WorkerType, WorkerDriver>
  readonly #availability: WorkerTypeAvailability[]
  readonly #modelCatalogs = new Map<string, Promise<WorkerModelCatalog>>()

  private constructor(drivers: WorkerDriver[], unavailable: WorkerTypeAvailability[]) {
    this.#drivers = new Map(drivers.map(driver => [driver.type, driver]))
    this.#availability = [...drivers.map(driver => driver.availability), ...unavailable]
  }

  static async create(): Promise<WorkerRegistry> {
    const codex = await detectCodexRuntime()
    const drivers: WorkerDriver[] = [new DshWorkerDriver()]
    if (codex.status.available && codex.executable !== undefined) {
      drivers.push(new CodexWorkerDriver(codex.executable, codex.status))
    }
    return new WorkerRegistry(drivers, [
      ...(codex.status.available ? [] : [codex.status]),
      { type: 'claude-code', available: false, reason: '尚未支持 Claude Code' },
    ])
  }

  availability(): WorkerTypeAvailability[] {
    return this.#availability.map(status => ({ ...status }))
  }

  assertAvailable(type: WorkerType): void {
    if (this.#drivers.has(type)) return
    const status = this.#availability.find(candidate => candidate.type === type)
    throw new Error(status?.reason ?? `${type} Worker 不可用`)
  }

  async modelCatalog(type: WorkerType, provider?: string): Promise<WorkerModelCatalog> {
    const driver = this.#drivers.get(type)
    if (driver === undefined) {
      this.assertAvailable(type)
      throw new Error(`${type} Worker 不可用`)
    }
    const key = `${type}:${provider ?? ''}`
    const pending = this.#modelCatalogs.get(key) ?? driver.modelCatalog(provider)
    this.#modelCatalogs.set(key, pending)
    try {
      return structuredClone(await pending)
    } catch (error) {
      this.#modelCatalogs.delete(key)
      throw error
    }
  }

  async start(sync: SyncRecord, kind: WorkerRunRecord['kind'], config: WorkerExecutionConfig, additionalInstruction?: string): Promise<WorkerHandle> {
    const driver = this.#drivers.get(config.type)
    if (driver === undefined) {
      this.assertAvailable(config.type)
      throw new Error(`${config.type} Worker 不可用`)
    }
    return await driver.start(sync, kind, config, additionalInstruction)
  }

  async wait(handle: WorkerHandle, signal?: AbortSignal): Promise<WorkerRunRecord> {
    return await this.#driverForHandle(handle).wait(handle, signal)
  }

  async inspect(handle: WorkerHandle): Promise<WorkerProgress> {
    return await this.#driverForHandle(handle).inspect(handle)
  }

  async steer(handle: WorkerHandle, prompt: string): Promise<void> {
    await this.#driverForHandle(handle).steer(handle, prompt)
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    await this.#driverForHandle(handle).cancel(handle)
  }

  async terminate(handle: WorkerHandle): Promise<void> {
    await this.#driverForHandle(handle).terminate(handle)
  }

  #driverForHandle(handle: WorkerHandle): WorkerDriver {
    const type = handle.workerType ?? 'dsh'
    const driver = this.#drivers.get(type)
    if (driver === undefined) throw new Error(`${type} Worker Driver 不可用`)
    return driver
  }
}

abstract class SessionWorkerDriver implements WorkerDriver {
  abstract readonly type: WorkerType
  abstract readonly availability: WorkerTypeAvailability
  abstract start(sync: SyncRecord, kind: WorkerRunRecord['kind'], config: WorkerExecutionConfig, additionalInstruction?: string): Promise<WorkerHandle>
  abstract modelCatalog(provider?: string): Promise<WorkerModelCatalog>

  async wait(handle: WorkerHandle, signal?: AbortSignal): Promise<WorkerRunRecord> {
    return await waitForDshWorker(handle, signal)
  }

  async inspect(handle: WorkerHandle): Promise<WorkerProgress> {
    return await inspectDshWorker(handle)
  }

  async steer(handle: WorkerHandle, prompt: string): Promise<void> {
    await steerDshWorker(handle, prompt)
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    await cancelDshWorker(handle)
  }

  async terminate(handle: WorkerHandle): Promise<void> {
    await terminateDshWorker(handle)
  }
}

class DshWorkerDriver extends SessionWorkerDriver {
  readonly type = 'dsh' as const
  readonly availability: WorkerTypeAvailability = { type: 'dsh', available: true }

  async modelCatalog(provider = 'deepseek-official'): Promise<WorkerModelCatalog> {
    return dshModelCatalog(provider)
  }

  async start(sync: SyncRecord, kind: WorkerRunRecord['kind'], config: WorkerExecutionConfig, additionalInstruction?: string): Promise<WorkerHandle> {
    return await startDshWorker(sync, kind, config, additionalInstruction)
  }
}

class CodexWorkerDriver extends SessionWorkerDriver {
  readonly type = 'codex' as const
  readonly availability: WorkerTypeAvailability
  readonly #executable: string

  constructor(executable: string, availability: WorkerTypeAvailability) {
    super()
    this.#executable = executable
    this.availability = availability
  }

  async modelCatalog(): Promise<WorkerModelCatalog> {
    return await readCodexModelCatalog(this.#executable)
  }

  async start(sync: SyncRecord, kind: WorkerRunRecord['kind'], config: WorkerExecutionConfig, additionalInstruction?: string): Promise<WorkerHandle> {
    return await startCodexWorker(sync, kind, config, this.#executable, additionalInstruction)
  }
}

export function dshModelCatalog(provider: string): WorkerModelCatalog {
  if (provider !== 'deepseek-official') return { type: 'dsh', provider, models: [] }
  const reasoningEfforts = [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  return {
    type: 'dsh',
    provider,
    defaultModel: 'deepseek-v4-flash',
    defaultReasoningEffort: 'high',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', isDefault: true, reasoningEfforts, defaultReasoningEffort: 'high' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts, defaultReasoningEffort: 'high' },
    ],
  }
}
