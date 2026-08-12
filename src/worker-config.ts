import { chmod, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { WORKER_CONFIG_FILE, WORKER_SECRET_FILE } from './config.ts'
import type { ApiKeyMode, CredentialSource, WorkerConfig, WorkerConfigInput, WorkerExecutionConfig, WorkerType } from './types.ts'
import { id, now, readJson, writeJsonAtomic } from './util.ts'

interface WorkerConfigDocument {
  version: 1
  configs: StoredWorkerConfig[]
}

type StoredWorkerConfig = Omit<WorkerConfig, 'hasApiKey' | 'credentialSource' | 'apiKeyMode'> & { apiKeyMode?: ApiKeyMode }

const TYPES = new Set<WorkerType>(['dsh', 'codex', 'claude-code'])
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u

export class WorkerConfigStore {
  #configs: StoredWorkerConfig[] = []
  #secrets: Record<string, string> = {}
  #harnessUserEnv: Record<string, string> = {}
  readonly #configFile: string
  readonly #secretFile: string

  private constructor(configFile: string, secretFile: string) {
    this.#configFile = configFile
    this.#secretFile = secretFile
  }

  static async open(paths: { configFile?: string; secretFile?: string; userEnvFile?: string } = {}): Promise<WorkerConfigStore> {
    const configFile = paths.configFile ?? WORKER_CONFIG_FILE
    const secretFile = paths.secretFile ?? WORKER_SECRET_FILE
    const store = new WorkerConfigStore(configFile, secretFile)
    const document = await readJson<WorkerConfigDocument>(configFile)
    if (document !== undefined) {
      if (document.version !== 1 || !Array.isArray(document.configs)) throw new Error('worker 配置文件无效')
      store.#configs = document.configs.map(validateStored)
    }
    store.#secrets = await readSecrets(secretFile)
    store.#harnessUserEnv = await readSecrets(paths.userEnvFile ?? join(homedir(), '.dsh', '.env'))
    for (const config of store.#configs) {
      config.apiKeyMode ??= store.#secrets[secretName(config)] === undefined ? 'environment' : 'value'
    }
    if (store.#configs.length === 0) {
      const createdAt = now()
      store.#configs = [{
        id: 'dsh-default',
        name: 'Default dsh',
        type: 'dsh',
        enabled: true,
        isDefault: true,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        apiKeyMode: 'environment',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        createdAt,
        updatedAt: createdAt,
      }]
      await store.#saveConfigs()
    }
    return store
  }

  list(): WorkerConfig[] {
    return this.#configs.map(config => {
      const credentialSource = this.#credentialSource(config)
      return { ...config, apiKeyMode: config.apiKeyMode ?? 'environment', hasApiKey: credentialSource !== 'missing', credentialSource }
    })
  }

  executionConfig(): WorkerExecutionConfig {
    const config = this.#configs.find(candidate => candidate.enabled && candidate.isDefault)
      ?? this.#configs.find(candidate => candidate.enabled)
    if (config === undefined) throw new Error('没有启用的 worker 配置；请先在 Settings 中添加或启用一个配置')
    if (config.type !== 'dsh') throw new Error(`${config.name} 的 ${config.type} worker 尚未实现；请选择 dsh 配置`)
    return { ...config, apiKeyMode: config.apiKeyMode ?? 'environment', apiKey: this.#secret(config) }
  }

  async create(input: WorkerConfigInput): Promise<WorkerConfig> {
    const type = workerType(input.type)
    const timestamp = now()
    const config: StoredWorkerConfig = {
      id: id('worker'),
      name: required(input.name, '配置名称'),
      type,
      enabled: type === 'dsh' && input.enabled !== false,
      isDefault: !this.#configs.some(candidate => candidate.enabled && candidate.isDefault),
      ...optional('provider', input.provider),
      ...optional('model', input.model),
      ...optionalUrl('baseUrl', input.baseUrl, 'Base URL'),
      ...optionalUrl('searchBaseUrl', input.searchBaseUrl, 'Search Base URL'),
      apiKeyMode: apiKeyMode(input.apiKeyMode ?? (input.apiKey?.trim() ? 'value' : 'environment')),
      ...optionalEnv(input.apiKeyEnv),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.#applyCredential(config, input, true)
    if (config.isDefault) for (const candidate of this.#configs) candidate.isDefault = false
    this.#configs.push(config)
    this.#normalizeDefault()
    await this.#save()
    return this.list().find(candidate => candidate.id === config.id)!
  }

  async update(configId: string, input: WorkerConfigInput): Promise<WorkerConfig> {
    const config = this.#configs.find(candidate => candidate.id === configId)
    if (config === undefined) throw new Error('找不到 worker 配置')
    const type = workerType(input.type)
    const updated: StoredWorkerConfig = {
      ...config,
      name: required(input.name, '配置名称'),
      type,
      enabled: type === 'dsh' && input.enabled !== false,
      provider: clean(input.provider),
      model: clean(input.model),
      baseUrl: cleanUrl(input.baseUrl, 'Base URL'),
      searchBaseUrl: cleanUrl(input.searchBaseUrl, 'Search Base URL'),
      apiKeyMode: apiKeyMode(input.apiKeyMode ?? config.apiKeyMode ?? 'environment'),
      apiKeyEnv: cleanEnv(input.apiKeyEnv),
      updatedAt: now(),
    }
    this.#applyCredential(updated, input, false)
    Object.assign(config, updated)
    this.#normalizeDefault()
    await this.#save()
    return this.list().find(candidate => candidate.id === config.id)!
  }

  async setDefault(configId: string): Promise<WorkerConfig> {
    const config = this.#configs.find(candidate => candidate.id === configId)
    if (config === undefined) throw new Error('找不到 worker 配置')
    if (!config.enabled) throw new Error('不能将未启用的 worker 设为默认')
    for (const candidate of this.#configs) candidate.isDefault = candidate.id === config.id
    config.updatedAt = now()
    await this.#saveConfigs()
    return this.list().find(candidate => candidate.id === config.id)!
  }

  async remove(configId: string): Promise<void> {
    const index = this.#configs.findIndex(candidate => candidate.id === configId)
    if (index < 0) throw new Error('找不到 worker 配置')
    const [removed] = this.#configs.splice(index, 1)
    delete this.#secrets[secretName(removed!)]
    this.#normalizeDefault()
    await this.#save()
  }

  #secret(config: StoredWorkerConfig): string | undefined {
    if (config.apiKeyMode === 'value') return this.#secrets[secretName(config)]
    const stored = this.#secrets[secretName(config)]
    if (stored !== undefined && config.apiKeyMode === undefined) return stored
    const env = config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv]
    const fallback = config.apiKeyEnv === undefined ? undefined : this.#harnessUserEnv[config.apiKeyEnv]
    return env?.trim() || fallback?.trim() || undefined
  }

  #credentialSource(config: StoredWorkerConfig): CredentialSource {
    if (config.apiKeyMode === 'value') return this.#secrets[secretName(config)] === undefined ? 'missing' : 'saved'
    return this.#secret(config) === undefined ? 'missing' : 'environment'
  }

  #applyCredential(config: StoredWorkerConfig, input: WorkerConfigInput, creating: boolean): void {
    if (config.apiKeyMode === 'environment') {
      if (config.apiKeyEnv === undefined) throw new Error('环境变量名不能为空')
      delete this.#secrets[secretName(config)]
      return
    }
    const value = input.apiKey?.trim()
    if (value !== undefined && value !== '') {
      this.#secrets[secretName(config)] = value
      return
    }
    if (creating || this.#secrets[secretName(config)] === undefined) throw new Error('API Key 不能为空')
  }

  async #save(): Promise<void> {
    await this.#saveConfigs()
    const lines = Object.entries(this.#secrets).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    await writeFile(this.#secretFile, `${lines.join('\n')}${lines.length === 0 ? '' : '\n'}`, { mode: 0o600 })
    await chmod(this.#secretFile, 0o600)
  }

  #normalizeDefault(): void {
    const current = this.#configs.find(candidate => candidate.enabled && candidate.isDefault)
    if (current !== undefined) {
      for (const candidate of this.#configs) candidate.isDefault = candidate.id === current.id
      return
    }
    const replacement = this.#configs.find(candidate => candidate.enabled)
    for (const candidate of this.#configs) candidate.isDefault = candidate.id === replacement?.id
  }

  async #saveConfigs(): Promise<void> {
    await writeJsonAtomic(this.#configFile, { version: 1, configs: this.#configs })
  }
}

function validateStored(value: StoredWorkerConfig): StoredWorkerConfig {
  return {
    ...value,
    name: required(value.name, '配置名称'),
    type: workerType(value.type),
    enabled: value.enabled === true,
    isDefault: value.isDefault === true,
    provider: clean(value.provider),
    model: clean(value.model),
    baseUrl: cleanUrl(value.baseUrl, 'Base URL'),
    searchBaseUrl: cleanUrl(value.searchBaseUrl, 'Search Base URL'),
    apiKeyMode: value.apiKeyMode === undefined ? undefined : apiKeyMode(value.apiKeyMode),
    apiKeyEnv: cleanEnv(value.apiKeyEnv),
  }
}

async function readSecrets(filename = WORKER_SECRET_FILE): Promise<Record<string, string>> {
  try {
    return parseEnv(await readFile(filename, 'utf8')) as Record<string, string>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function workerType(value: string): WorkerType {
  if (!TYPES.has(value as WorkerType)) throw new Error('未知 worker 类型')
  return value as WorkerType
}

function apiKeyMode(value: string): ApiKeyMode {
  if (value !== 'value' && value !== 'environment') throw new Error('未知 API Key 来源')
  return value
}

function required(value: string | undefined, label: string): string {
  const result = value?.trim()
  if (!result) throw new Error(`${label}不能为空`)
  return result
}

function clean(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

function cleanEnv(value: string | undefined): string | undefined {
  const result = clean(value)
  if (result !== undefined && !ENV_NAME.test(result)) throw new Error('API Key 环境变量名无效')
  return result
}

function cleanUrl(value: string | undefined, label: string): string | undefined {
  const result = clean(value)
  if (result === undefined) return undefined
  try {
    const url = new URL(result)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
  } catch {
    throw new Error(`${label} 必须是 HTTP(S) URL`)
  }
  return result
}

function optional<K extends 'provider' | 'model'>(key: K, value: string | undefined): Partial<Record<K, string>> {
  const result = clean(value)
  return result === undefined ? {} : { [key]: result } as Partial<Record<K, string>>
}

function optionalEnv(value: string | undefined): { apiKeyEnv?: string } {
  const result = cleanEnv(value)
  return result === undefined ? {} : { apiKeyEnv: result }
}

function optionalUrl<K extends 'baseUrl' | 'searchBaseUrl'>(key: K, value: string | undefined, label: string): Partial<Record<K, string>> {
  const result = cleanUrl(value, label)
  return result === undefined ? {} : { [key]: result } as Partial<Record<K, string>>
}

function secretName(config: Pick<StoredWorkerConfig, 'id'>): string {
  return `DSHW_WORKER_${config.id.replace(/[^a-zA-Z0-9_]/gu, '_').toUpperCase()}_API_KEY`
}
