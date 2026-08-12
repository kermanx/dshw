import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { Socket } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLONE_METADATA_ROOT,
  CLONES_ROOT,
  CODE_WORKSPACE_FILE,
  DATA_ROOT,
  DSHW_ROOT,
  HARNESS_REMOTE_URL,
  HARNESS_ROOT,
  HOST,
  LOG_ROOT,
  PORT,
  SERVICE_LABEL,
  SERVICE_PLIST,
} from './config.ts'
import { dshLaunchEnvironmentXml } from './dsh-launch-env.ts'
import type { InstallationRecord } from './install.ts'
import { escapeXml, messageOf, run, runOrThrow } from './util.ts'

const OWNER_PREFIX = 'dshw-owner:'
const PRODUCT = 'dshw'

export interface ServiceOwner {
  version: 1
  installationId: string
  dshwRoot: string
  serviceLabel: string
}

export interface ServiceIdentity {
  product: typeof PRODUCT
  installationId: string
  dshwRoot: string
  serviceLabel: string
  port: number
}

export interface WorkflowStateSummary {
  service: { activeJobs: number; startedAt?: string; installationId?: string }
  syncs: unknown[]
}

export function serviceDomain(): string {
  return `gui/${uid()}/${SERVICE_LABEL}`
}

export function serviceOwner(installation: InstallationRecord): ServiceOwner {
  return {
    version: 1,
    installationId: installation.id,
    dshwRoot: installation.dshwRoot,
    serviceLabel: SERVICE_LABEL,
  }
}

export function renderServicePlist(installation: InstallationRecord): string {
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url))
  const owner = serviceOwner(installation)
  const marker = Buffer.from(JSON.stringify(owner)).toString('base64url')
  const path = process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  const variables: Readonly<Record<string, string>> = {
    DSHW_INSTALLATION_ID: installation.id,
    DSHW_DATA_ROOT: DATA_ROOT,
    DSHW_HARNESS_ROOT: HARNESS_ROOT,
    DSHW_CLONES_ROOT: CLONES_ROOT,
    DSHW_CLONE_METADATA_ROOT: CLONE_METADATA_ROOT,
    DSHW_CODE_WORKSPACE_FILE: CODE_WORKSPACE_FILE,
    DSHW_HARNESS_REMOTE_URL: HARNESS_REMOTE_URL,
    DSHW_SERVICE_LABEL: SERVICE_LABEL,
    DSHW_SERVICE_PLIST: SERVICE_PLIST,
    DSHW_PORT: String(PORT),
  }
  const environmentXml = Object.entries(variables)
    .map(([name, value]) => `<key>${name}</key><string>${escapeXml(value)}</string>`)
    .join('\n    ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${OWNER_PREFIX}${marker} -->
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(cliPath)}</string><string>daemon</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(DSHW_ROOT)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
    ${environmentXml}
    ${dshLaunchEnvironmentXml(process.env)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(`${LOG_ROOT}/service.stdout.log`)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(`${LOG_ROOT}/service.stderr.log`)}</string>
  <key>ThrottleInterval</key><integer>5</integer>
</dict></plist>
`
}

export function parseServiceOwner(plist: string): ServiceOwner | undefined {
  const encoded = plist.match(/<!--\s*dshw-owner:([A-Za-z0-9_-]+)\s*-->/u)?.[1]
  if (encoded === undefined) return undefined
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ServiceOwner>
    if (
      value.version !== 1
      || typeof value.installationId !== 'string'
      || typeof value.dshwRoot !== 'string'
      || typeof value.serviceLabel !== 'string'
    ) return undefined
    return value as ServiceOwner
  } catch {
    return undefined
  }
}

export async function assertServiceAvailable(installation: InstallationRecord): Promise<void> {
  requireMacOs()
  const expected = serviceOwner(installation)
  const existingOwner = await plistOwner()
  if (existingOwner !== undefined) await assertSameOwner(existingOwner, expected)
  const loaded = await isLoaded()
  const identity = await readServiceIdentity()
  if (identity !== undefined) assertSameIdentity(identity, expected)
  if (loaded && existingOwner === undefined) {
    throw serviceConflict('同名 launchd 服务已加载，但无法验证其 installation 身份')
  }
  if (!loaded && identity !== undefined) {
    throw serviceConflict(`端口 ${PORT} 已被另一个 dshw 进程占用`)
  }
  if (identity === undefined && await isPortOccupied()) {
    throw serviceConflict(`端口 ${PORT} 已被无法验证身份的进程占用`)
  }
}

export async function startService(installation: InstallationRecord): Promise<void> {
  await assertServiceAvailable(installation)
  const expected = serviceOwner(installation)
  const loaded = await isLoaded()
  if (loaded) {
    const identity = await waitForIdentity(installation, 10_000)
    assertSameIdentity(identity, expected)
    return
  }
  await writePlistAtomic(renderServicePlist(installation))
  await runOrThrow('launchctl', ['enable', serviceDomain()])
  await runOrThrow('launchctl', ['bootstrap', `gui/${uid()}`, SERVICE_PLIST])
  await waitForIdentity(installation, 20_000)
}

export async function stopService(installation: InstallationRecord): Promise<boolean> {
  await assertOwnedControl(installation)
  if (!await isLoaded()) return false
  const result = await run('launchctl', ['bootout', serviceDomain()])
  if (result.code !== 0 && !/could not find service/i.test(result.stderr)) {
    throw new Error(result.stderr.trim() || '停止服务失败')
  }
  return result.code === 0
}

export async function restartService(installation: InstallationRecord): Promise<void> {
  await assertOwnedControl(installation)
  const before = await getWorkflowState(installation)
  await postOwnedApi(installation, '/api/restart', {})
  const previousStartedAt = before.service.startedAt
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    await delay(250)
    try {
      const state = await getWorkflowState(installation)
      if (previousStartedAt === undefined || state.service.startedAt !== previousStartedAt) return
    } catch {}
  }
  throw new Error(`服务重启超时；请查看 ${LOG_ROOT}/service.stderr.log`)
}

export async function getWorkflowState(installation: InstallationRecord): Promise<WorkflowStateSummary> {
  await assertOwnedControl(installation)
  let response: Response
  try {
    response = await fetch(`http://${HOST}:${PORT}/api/state`, { signal: AbortSignal.timeout(3_000) })
  } catch (error) {
    throw new Error(`后台服务未运行（${messageOf(error)}）`)
  }
  if (!response.ok) throw new Error(`后台服务状态读取失败：HTTP ${response.status}`)
  return await response.json() as WorkflowStateSummary
}

export async function postOwnedApi(
  installation: InstallationRecord,
  path: string,
  body: object,
): Promise<Record<string, unknown>> {
  await assertOwnedControl(installation)
  let response: Response
  try {
    response = await fetch(`http://${HOST}:${PORT}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    })
  } catch (error) {
    throw new Error(`无法连接后台服务；请先运行 dshw start（${messageOf(error)}）`)
  }
  const value = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${response.status}`)
  return value
}

export async function assertOwnedControl(installation: InstallationRecord): Promise<void> {
  requireMacOs()
  const expected = serviceOwner(installation)
  const owner = await plistOwner()
  if (owner === undefined) throw serviceConflict(`服务配置缺少当前安装的 ownership 标记：${SERVICE_PLIST}`)
  await assertSameOwner(owner, expected)
  const identity = await readServiceIdentity()
  if (identity === undefined) {
    if (await isLoaded()) throw new Error(`服务已加载但暂时无法验证身份；请查看 ${LOG_ROOT}/service.stderr.log`)
    return
  }
  assertSameIdentity(identity, expected)
}

export async function readServiceIdentity(): Promise<ServiceIdentity | undefined> {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/api/identity`, { signal: AbortSignal.timeout(1_000) })
    if (!response.ok) return undefined
    const value = await response.json() as Partial<ServiceIdentity>
    if (
      value.product !== PRODUCT
      || typeof value.installationId !== 'string'
      || typeof value.dshwRoot !== 'string'
      || typeof value.serviceLabel !== 'string'
      || typeof value.port !== 'number'
    ) return undefined
    return value as ServiceIdentity
  } catch {
    return undefined
  }
}

async function plistOwner(): Promise<ServiceOwner | undefined> {
  let info
  try {
    info = await lstat(SERVICE_PLIST)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) throw serviceConflict(`服务配置不是普通文件：${SERVICE_PLIST}`)
  const owner = parseServiceOwner(await readFile(SERVICE_PLIST, 'utf8'))
  if (owner === undefined) {
    throw serviceConflict(`已有同名服务配置且不属于新版 dshw：${SERVICE_PLIST}`)
  }
  return owner
}

async function assertSameOwner(actual: ServiceOwner, expected: ServiceOwner): Promise<void> {
  const actualRoot = await canonicalOrResolved(actual.dshwRoot)
  const expectedRoot = await canonicalOrResolved(expected.dshwRoot)
  if (
    actual.installationId !== expected.installationId
    || actualRoot !== expectedRoot
    || actual.serviceLabel !== expected.serviceLabel
  ) {
    throw serviceConflict(`同名服务属于另一份 dshw：${actual.dshwRoot}`)
  }
}

function assertSameIdentity(actual: ServiceIdentity, expected: ServiceOwner): void {
  if (
    actual.installationId !== expected.installationId
    || actual.dshwRoot !== expected.dshwRoot
    || actual.serviceLabel !== expected.serviceLabel
  ) {
    throw serviceConflict(`端口或同名服务属于另一份 dshw：${actual.dshwRoot}`)
  }
}

async function waitForIdentity(installation: InstallationRecord, timeoutMs: number): Promise<ServiceIdentity> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const identity = await readServiceIdentity()
    if (identity !== undefined) {
      assertSameIdentity(identity, serviceOwner(installation))
      return identity
    }
    await delay(250)
  }
  throw new Error(`后台服务启动超时；请查看 ${LOG_ROOT}/service.stderr.log`)
}

async function writePlistAtomic(contents: string): Promise<void> {
  await mkdir(dirname(SERVICE_PLIST), { recursive: true })
  const temporary = `${SERVICE_PLIST}.${process.pid}.tmp`
  await writeFile(temporary, contents, { mode: 0o600 })
  await rename(temporary, SERVICE_PLIST)
}

async function isLoaded(): Promise<boolean> {
  return (await run('launchctl', ['print', serviceDomain()])).code === 0
}

async function isPortOccupied(): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = new Socket()
    const finish = (occupied: boolean): void => {
      socket.destroy()
      resolve(occupied)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(PORT, HOST)
  })
}

async function canonicalOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

function serviceConflict(detail: string): Error {
  return new Error(`${detail}。为避免破坏其他安装，dshw 未修改该服务；请先停止或迁移旧安装`)
}

function requireMacOs(): void {
  if (process.platform !== 'darwin') throw new Error('dshw 后台服务目前只支持 macOS launchd')
}

function uid(): number {
  if (process.getuid === undefined) throw new Error('无法确定当前用户 UID')
  return process.getuid()
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}
