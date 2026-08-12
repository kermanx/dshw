import { access, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import {
  DATA_ROOT,
  HARNESS_ROOT,
  HARNESS_RUNTIME_COMMIT,
  HARNESS_RUNTIME_FILE,
  HARNESS_RUNTIME_ROOT,
} from './config.ts'
import { assertManagedHarnessOwned, readInstallation } from './install.ts'
import { now, readJson, run, runOrThrow, writeJsonAtomic } from './util.ts'

interface HarnessRuntimeRecord {
  version: 1
  installationId: string
  path: string
  commit: string
  createdAt: string
}

let preparation: Promise<HarnessRuntimeRecord> | undefined

/** Return the immutable Harness checkout used by all dsh workers. */
export function ensureHarnessRuntime(): Promise<HarnessRuntimeRecord> {
  preparation ??= prepareHarnessRuntime().catch(error => {
    preparation = undefined
    throw error
  })
  return preparation
}

async function prepareHarnessRuntime(): Promise<HarnessRuntimeRecord> {
  await assertManagedHarnessOwned()
  const installation = await readInstallation()
  if (installation === undefined) throw new Error('找不到 dshw installation，无法校验 Harness runtime')
  const existing = await readJson<HarnessRuntimeRecord>(HARNESS_RUNTIME_FILE)
  if (existing !== undefined) {
    await validateRuntime(existing, installation.id)
    await ensureRuntimeBuilt(existing.path)
    return existing
  }
  if (await exists(HARNESS_RUNTIME_ROOT)) {
    throw new Error(`Harness runtime 目录已存在但没有 ownership 记录：${HARNESS_RUNTIME_ROOT}`)
  }

  const commit = HARNESS_RUNTIME_COMMIT
  const available = await run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: HARNESS_ROOT })
  if (available.code !== 0) {
    await runOrThrow('git', ['fetch', 'origin', 'master'], { cwd: HARNESS_ROOT, timeoutMs: 5 * 60 * 1000 })
    const fetched = await run('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: HARNESS_ROOT })
    if (fetched.code !== 0) throw new Error(`托管仓库不包含 dshw 固定的 Harness runtime commit：${commit}`)
  }
  await mkdir(dirname(HARNESS_RUNTIME_ROOT), { recursive: true })
  try {
    await runOrThrow('git', ['worktree', 'add', '--detach', HARNESS_RUNTIME_ROOT, commit], {
      cwd: HARNESS_ROOT,
      timeoutMs: 5 * 60 * 1000,
    })
    await ensureRuntimeBuilt(HARNESS_RUNTIME_ROOT)
    const record: HarnessRuntimeRecord = {
      version: 1,
      installationId: installation.id,
      path: await realpath(HARNESS_RUNTIME_ROOT),
      commit,
      createdAt: now(),
    }
    await writeJsonAtomic(HARNESS_RUNTIME_FILE, record)
    return record
  } catch (error) {
    await run('git', ['worktree', 'remove', '--force', HARNESS_RUNTIME_ROOT], { cwd: HARNESS_ROOT })
    await rm(HARNESS_RUNTIME_ROOT, { recursive: true, force: true })
    throw error
  }
}

async function ensureRuntimeBuilt(runtimeRoot: string): Promise<void> {
  const readyPath = join(runtimeRoot, '.dshw-runtime-ready')
  const head = (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: runtimeRoot })).stdout.trim()
  const marker = `runtime-v2 ${head}`
  try {
    if ((await readFile(readyPath, 'utf8')).trim() === marker
      && (await missingRuntimeArtifacts(runtimeRoot)).length === 0) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await runOrThrow('pnpm', ['install', '--frozen-lockfile'], { cwd: runtimeRoot, timeoutMs: 10 * 60 * 1000 })
  // The headless composition still contains a small number of dual-face
  // packages (for example the TypeRT registry). Build both library faces so
  // every package referenced by the profile has its declared runtime entry.
  await runOrThrow('pnpm', ['run', 'build:lib'], { cwd: runtimeRoot, timeoutMs: 20 * 60 * 1000 })
  await writeFile(readyPath, `${marker}\n`)
}

async function missingRuntimeArtifacts(runtimeRoot: string): Promise<string[]> {
  const required = [
    join(runtimeRoot, 'apps', 'cli', 'lib', 'bin.js'),
    join(runtimeRoot, 'packages', 'typert', 'registry', 'lib', 'index.js'),
    join(runtimeRoot, 'packages', 'api', 'gateway', 'lib', 'index.js'),
    ...await missingTypertRuntimeArtifacts(runtimeRoot),
  ]
  const missing: string[] = []
  await Promise.all(required.map(async path => {
    try {
      await access(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.push(path)
    }
  }))
  return missing.sort()
}

async function validateRuntime(record: HarnessRuntimeRecord, installationId: string): Promise<void> {
  if (record.version !== 1 || record.installationId !== installationId || record.commit === '') {
    throw new Error(`无效的 Harness runtime 记录：${HARNESS_RUNTIME_FILE}`)
  }
  if (record.commit !== HARNESS_RUNTIME_COMMIT) throw new Error('Harness runtime 记录与 dshw 固定版本不一致')
  const actual = await realpath(HARNESS_RUNTIME_ROOT)
  if (resolve(record.path) !== resolve(actual)) throw new Error('Harness runtime 路径与 ownership 记录不一致')
  const fromDataRoot = relative(resolve(DATA_ROOT), actual)
  if (fromDataRoot === '' || fromDataRoot === '..' || fromDataRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Harness runtime 必须位于 ${DATA_ROOT} 内`)
  }
  const info = await lstat(actual)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Harness runtime 必须是普通目录')
  await access(join(actual, '.git'))
  const head = (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: actual })).stdout.trim()
  if (head !== record.commit) throw new Error(`Harness runtime 已被修改：预期 ${record.commit}，实际 ${head}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function runtimeExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const conditions = value as Record<string, unknown>
  return runtimeExportTarget(conditions.default) ?? runtimeExportTarget(conditions.import)
}

/** Return workspace packages whose declared Host TypeRT runtime artifact is not built yet. */
export async function missingTypertRuntimeArtifacts(clonePath: string): Promise<string[]> {
  const packagesRoot = join(clonePath, 'packages')
  const manifests: string[] = []
  const directories = async (directory: string): Promise<string[]> => {
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => join(directory, entry.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  for (const group of await directories(packagesRoot)) {
    for (const packageDirectory of await directories(group)) {
      const manifestPath = join(packageDirectory, 'package.json')
      try {
        await access(manifestPath)
        manifests.push(manifestPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
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
