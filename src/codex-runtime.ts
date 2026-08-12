import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { constants } from 'node:fs'
import { CodexAppServerClient, type JsonObject } from './codex-app-server.ts'
import type { WorkerModelCatalog, WorkerModelOption, WorkerTypeAvailability } from './types.ts'
import { run } from './util.ts'

export interface CodexRuntime {
  executable?: string
  status: WorkerTypeAvailability
}

export async function readCodexModelCatalog(executable: string, cwd = process.cwd()): Promise<WorkerModelCatalog> {
  let exited: Error | undefined
  const client = new CodexAppServerClient(executable, cwd, () => {}, error => { exited = error })
  try {
    await client.initialize()
    const [configResponse, models] = await Promise.all([
      client.request('config/read', { cwd, includeLayers: false }),
      readAllCodexModels(client),
    ])
    if (exited !== undefined) throw exited
    return codexModelCatalogFrom(configResponse, models)
  } finally {
    client.close()
  }
}

export function codexModelCatalogFrom(configResponse: JsonObject, rawModels: unknown[]): WorkerModelCatalog {
  const config = asRecord(configResponse.config) ?? {}
  const models = rawModels.flatMap(value => {
    const model = asRecord(value)
    if (model === undefined || typeof model.model !== 'string') return []
    const efforts = Array.isArray(model.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.flatMap(value => {
          const effort = asRecord(value)
          if (effort === undefined || typeof effort.reasoningEffort !== 'string') return []
          return [{
            id: effort.reasoningEffort,
            name: effort.reasoningEffort,
            ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
          }]
        })
      : []
    const option: WorkerModelOption = {
      id: model.model,
      name: typeof model.displayName === 'string' ? model.displayName : model.model,
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      reasoningEfforts: efforts,
      ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    }
    return [option]
  })
  const configuredModel = typeof config.model === 'string' ? config.model : undefined
  const defaultModel = configuredModel ?? models.find(model => model.isDefault)?.id
  const selectedModel = models.find(model => model.id === defaultModel)
  const configuredEffort = typeof config.model_reasoning_effort === 'string' ? config.model_reasoning_effort : undefined
  const defaultReasoningEffort = configuredEffort ?? selectedModel?.defaultReasoningEffort
  return {
    type: 'codex',
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    models,
  }
}

async function readAllCodexModels(client: CodexAppServerClient): Promise<unknown[]> {
  const models: unknown[] = []
  let cursor: string | undefined
  do {
    const response = await client.request('model/list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
    if (Array.isArray(response.data)) models.push(...response.data)
    cursor = typeof response.nextCursor === 'string' ? response.nextCursor : undefined
  } while (cursor !== undefined)
  return models
}

function asRecord(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}

export async function detectCodexRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<CodexRuntime> {
  const executable = await findCodexExecutable(environment.PATH)
  if (executable === undefined) {
    return { status: { type: 'codex', available: false, reason: '未检测到本机 Codex CLI' } }
  }
  const versionResult = await run(executable, ['--version'], { env: environment, timeoutMs: 5_000 })
  if (versionResult.code !== 0) {
    return { executable, status: { type: 'codex', available: false, reason: '本机 Codex CLI 无法运行' } }
  }
  const version = versionResult.stdout.trim().replace(/^codex-cli\s+/u, '') || undefined
  const login = await run(executable, ['login', 'status'], { env: environment, timeoutMs: 5_000 })
  if (login.code !== 0) {
    return { executable, status: { type: 'codex', available: false, ...(version === undefined ? {} : { version }), reason: '本机 Codex 尚未登录' } }
  }
  return { executable, status: { type: 'codex', available: true, ...(version === undefined ? {} : { version }) } }
}

export async function findCodexExecutable(pathValue: string | undefined): Promise<string | undefined> {
  const candidates = [
    ...(pathValue ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, 'codex')),
    ...(process.platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources/codex'] : []),
  ]
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch { /* try the next PATH entry */ }
  }
  return undefined
}
