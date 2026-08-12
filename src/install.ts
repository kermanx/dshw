import { randomUUID } from 'node:crypto'
import { access, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  CLONE_METADATA_ROOT,
  CLONES_ROOT,
  CODE_WORKSPACE_FILE,
  DATA_ROOT,
  DSHW_ROOT,
  HARNESS_REMOTE_URL,
  HARNESS_ROOT,
  HARNESS_RUNTIME_ROOT,
  INSTALLATION_FILE,
  LOG_ROOT,
  MANAGED_HARNESS_FILE,
  WORKER_ROOT,
} from './config.ts'
import { now, readJson, runOrThrow, writeJsonAtomic } from './util.ts'

export interface InstallationRecord {
  version: 1
  id: string
  dshwRoot: string
  createdAt: string
}

export interface ManagedHarnessRecord {
  version: 1
  installationId: string
  path: string
  remoteUrl: string
  createdAt: string
}

export async function ensureInstallation(): Promise<InstallationRecord> {
  await ensureRuntimeDirectories()
  const sourceRoot = await realpath(DSHW_ROOT)
  const existing = await readJson<InstallationRecord>(INSTALLATION_FILE)
  if (existing !== undefined) {
    validateInstallation(existing, sourceRoot)
    return existing
  }
  const created: InstallationRecord = {
    version: 1,
    id: randomUUID(),
    dshwRoot: sourceRoot,
    createdAt: now(),
  }
  await writeJsonAtomic(INSTALLATION_FILE, created)
  return created
}

export async function readInstallation(): Promise<InstallationRecord | undefined> {
  const record = await readJson<InstallationRecord>(INSTALLATION_FILE)
  if (record === undefined) return undefined
  validateInstallation(record, await realpath(DSHW_ROOT))
  return record
}

export async function requireDaemonInstallation(): Promise<InstallationRecord> {
  const installation = await readInstallation()
  if (installation === undefined) throw new Error('dshw 尚未初始化；请先运行 dshw start')
  const expected = process.env.DSHW_INSTALLATION_ID
  if (expected === undefined) throw new Error('拒绝直接启动 daemon；请使用 dshw start 注册用户服务')
  if (expected !== installation.id) throw new Error('daemon installationId 与当前 dshw clone 不匹配')
  return installation
}

export async function ensureRuntimeDirectories(): Promise<void> {
  assertRuntimeLayout()
  await Promise.all([
    mkdir(DATA_ROOT, { recursive: true }),
    mkdir(dirname(HARNESS_ROOT), { recursive: true }),
    mkdir(dirname(HARNESS_RUNTIME_ROOT), { recursive: true }),
    mkdir(CLONES_ROOT, { recursive: true }),
    mkdir(CLONE_METADATA_ROOT, { recursive: true }),
    mkdir(LOG_ROOT, { recursive: true }),
    mkdir(WORKER_ROOT, { recursive: true }),
  ])
}

function assertRuntimeLayout(): void {
  assertInside(HARNESS_ROOT, DATA_ROOT, '托管仓库')
  assertInside(HARNESS_RUNTIME_ROOT, DATA_ROOT, '固定 Harness runtime')
  assertInside(CLONES_ROOT, DATA_ROOT, 'worktree 目录')
  assertInside(CLONE_METADATA_ROOT, DATA_ROOT, 'worktree 元数据目录')
  assertInside(LOG_ROOT, DATA_ROOT, '日志目录')
  assertInside(WORKER_ROOT, DATA_ROOT, 'worker 目录')
  assertInside(CODE_WORKSPACE_FILE, DATA_ROOT, 'VS Code workspace')
}

export async function ensureManagedHarness(installation: InstallationRecord): Promise<void> {
  await ensureRuntimeDirectories()
  const marker = await readJson<ManagedHarnessRecord>(MANAGED_HARNESS_FILE)
  if (await exists(HARNESS_ROOT)) {
    if (marker === undefined) {
      throw new Error(`托管仓库目录已存在但不属于当前 dshw：${HARNESS_ROOT}`)
    }
    await validateManagedHarness(marker, installation)
    return
  }
  if (marker !== undefined) throw new Error(`托管仓库记录存在但目录缺失：${HARNESS_ROOT}`)

  const temporary = resolve(dirname(HARNESS_ROOT), `.dshw-clone-${process.pid}-${randomUUID()}`)
  assertInside(temporary, DATA_ROOT, '临时托管仓库')
  try {
    await runOrThrow(
      'git',
      ['clone', '--no-tags', '--branch', 'master', HARNESS_REMOTE_URL, temporary],
      { timeoutMs: 10 * 60 * 1000 },
    )
    await rename(temporary, HARNESS_ROOT)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
  const created: ManagedHarnessRecord = {
    version: 1,
    installationId: installation.id,
    path: await realpath(HARNESS_ROOT),
    remoteUrl: HARNESS_REMOTE_URL,
    createdAt: now(),
  }
  await writeJsonAtomic(MANAGED_HARNESS_FILE, created)
}

export async function assertManagedHarnessOwned(): Promise<void> {
  const installation = await readInstallation()
  if (installation === undefined) throw new Error('找不到 dshw installation 记录，拒绝操作托管仓库')
  const marker = await readJson<ManagedHarnessRecord>(MANAGED_HARNESS_FILE)
  if (marker === undefined) throw new Error('找不到托管仓库 ownership 记录，拒绝操作')
  await validateManagedHarness(marker, installation)
}

function validateInstallation(record: InstallationRecord, sourceRoot: string): void {
  if (record.version !== 1 || typeof record.id !== 'string' || record.id === '') {
    throw new Error(`无效的 installation 记录：${INSTALLATION_FILE}`)
  }
  if (resolve(record.dshwRoot) !== resolve(sourceRoot)) {
    throw new Error(`这个 .dshw 属于另一份源码：${record.dshwRoot}`)
  }
}

async function validateManagedHarness(record: ManagedHarnessRecord, installation: InstallationRecord): Promise<void> {
  if (record.version !== 1 || record.installationId !== installation.id) {
    throw new Error('托管仓库不属于当前 dshw installation，拒绝操作')
  }
  const actual = await realpath(HARNESS_ROOT)
  if (resolve(record.path) !== resolve(actual)) throw new Error('托管仓库路径与 ownership 记录不一致')
  if (HARNESS_REMOTE_URL !== record.remoteUrl) throw new Error('托管仓库 remote 配置与 ownership 记录不一致')
  assertInside(actual, DATA_ROOT, '托管仓库')
  if (resolve(actual) === resolve(DSHW_ROOT)) throw new Error('托管仓库不能是 dshw 源码仓库')
  const sourceInfo = await lstat(HARNESS_ROOT)
  if (sourceInfo.isSymbolicLink()) throw new Error('托管仓库不能是符号链接')
  const info = await lstat(actual)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('托管仓库必须是普通目录')
  await access(resolve(actual, '.git'))
  const origin = (await runOrThrow('git', ['remote', 'get-url', 'origin'], { cwd: actual })).stdout.trim()
  if (origin !== record.remoteUrl) throw new Error('托管仓库 origin 与 ownership 记录不一致，拒绝操作')
}

function assertInside(path: string, directory: string, label: string): void {
  const pathRelative = relative(resolve(directory), resolve(path))
  if (pathRelative === '' || pathRelative === '..' || pathRelative.startsWith(`..${sep}`)) {
    throw new Error(`${label} 必须位于 ${directory} 内：${path}`)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
