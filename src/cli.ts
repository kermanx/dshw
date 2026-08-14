#!/usr/bin/env node

import { access } from 'node:fs/promises'
import { formatClonePath, resolveClone } from './clone.ts'
import { CODE_WORKSPACE_FILE, DSHW_ROOT, HOST, PORT, SERVICE_LABEL, SERVICE_PLIST } from './config.ts'
import { ensureHarnessRuntime } from './dsh-runtime.ts'
import { ensureInstallation, ensureManagedHarness, readInstallation, type InstallationRecord } from './install.ts'
import { runService } from './service.ts'
import {
  assertServiceAvailable,
  assertOwnedControl,
  getWorkflowState,
  readServiceIdentity,
  restartService,
  startService,
  stopService,
} from './service-manager.ts'
import { messageOf, run, runOrThrow } from './util.ts'
import { refreshCodeWorkspace } from './workspace.ts'

const [command = 'help', ...args] = process.argv.slice(2)

try {
  switch (command) {
    case 'code': {
      requireAtMostOne(args)
      const installation = await progressStep('初始化本地数据目录', ensureInstallation)
      await progressStep('准备托管仓库（首次运行需要 clone）', () => ensureManagedHarness(installation))
      const clone = await progressStep('查找或创建当前分支的 worktree', () => resolveClone(args[0], process.cwd()))
      await progressStep('打开 VS Code', () => runOrThrow('code', [clone.path]))
      console.log(formatClonePath(clone))
      break
    }
    case 'start': {
      requireNoArgs(args)
      const installation = await progressStep('初始化本地数据目录', ensureInstallation)
      await progressStep('检查后台服务和端口', () => assertServiceAvailable(installation))
      await progressStep('准备托管仓库（首次运行需要 clone，可能耗时较久）', () => ensureManagedHarness(installation))
      await progressStep('准备固定的 dsh runtime（首次运行需要安装和构建，可能耗时较久）', ensureHarnessRuntime)
      await progressStep('构建插件 bundle', buildPlugin)
      await progressStep('生成 VS Code workspace', refreshWorkspaceWithWarning)
      await progressStep('启动后台服务并等待就绪', () => startService(installation))
      console.log('dshw 后台服务已启动；看板请通过 DeepSeek Harness 插件使用（见 README）')
      break
    }
    case 'stop': {
      requireNoArgs(args)
      const installation = await progressStep('读取当前安装', requireInstallation)
      const stopped = await progressStep('验证并停止后台服务', () => stopService(installation))
      console.log(stopped ? 'dshw 后台服务已停止' : 'dshw 后台服务本来就未运行')
      break
    }
    case 'restart': {
      requireNoArgs(args)
      const installation = await progressStep('读取当前安装', requireInstallation)
      await progressStep('验证后台服务 ownership', () => assertOwnedControl(installation))
      await progressStep('检查固定的 dsh runtime', ensureHarnessRuntime)
      await progressStep('重新构建插件 bundle', buildPlugin)
      await progressStep('安全重启并等待服务恢复', () => restartService(installation))
      console.log('dshw 后台服务已安全重启；运行中的 dsh 任务不受影响')
      break
    }
    case 'status': {
      requireNoArgs(args)
      const installation = await progressStep('读取当前安装', requireInstallation)
      const state = await progressStep('连接并验证后台服务', () => getWorkflowState(installation))
      console.log(`服务运行中；${state.service.activeJobs} 个任务执行中；追踪 ${state.syncs.length} 个 PR`)
      break
    }
    case 'doctor': {
      requireNoArgs(args)
      await doctor()
      break
    }
    case 'daemon': {
      requireNoArgs(args)
      await runService()
      break
    }
    case 'help':
    case '--help':
    case '-h': {
      printHelp()
      break
    }
    default:
      throw new Error(`未知子命令：${command}\n\n${helpText()}`)
  }
} catch (error) {
  console.error(`dshw: ${messageOf(error)}`)
  process.exitCode = 1
}

async function requireInstallation(): Promise<InstallationRecord> {
  const installation = await readInstallation()
  if (installation === undefined) throw new Error('尚未初始化；请先运行 pnpm dshw start')
  return installation
}

function requireNoArgs(args: readonly string[]): void {
  if (args.length !== 0) throw new Error('此子命令不接受参数')
}

function requireAtMostOne(args: readonly string[]): void {
  if (args.length > 1) throw new Error('此子命令最多接受一个 clone name 或源仓库编号')
}

async function refreshWorkspaceWithWarning(): Promise<void> {
  try {
    await refreshCodeWorkspace()
  } catch (error) {
    console.warn(`dshw: VS Code workspace 暂时无法刷新：${messageOf(error)}`)
  }
}

async function buildPlugin(): Promise<void> {
  await runOrThrow('pnpm', ['run', 'build:plugin'], { cwd: DSHW_ROOT, timeoutMs: 2 * 60 * 1000 })
}

async function doctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`)
  }
  record('macOS', process.platform === 'darwin', process.platform)
  record('Node.js', Number(process.versions.node.split('.')[0]) >= 24, process.version)
  for (const executable of ['pnpm', 'git', 'gh', 'code']) {
    try {
      const result = await run(executable, ['--version'])
      record(executable, result.code === 0, (result.stdout || result.stderr).trim().split('\n')[0] || '不可用')
    } catch (error) {
      record(executable, false, messageOf(error))
    }
  }
  try {
    const auth = await run('gh', ['auth', 'status'])
    record('GitHub 登录', auth.code === 0, auth.code === 0 ? '已登录' : '请运行 gh auth login')
  } catch (error) {
    record('GitHub 登录', false, messageOf(error))
  }
  let installation: InstallationRecord | undefined
  try {
    installation = await readInstallation()
    record('本地数据', installation !== undefined, installation === undefined ? '尚未运行 start' : `${DSHW_ROOT}/.dshw`)
  } catch (error) {
    record('本地数据', false, messageOf(error))
  }
  const plistExists = await pathExists(SERVICE_PLIST)
  if (!plistExists) record('LaunchAgent', false, '尚未安装')
  else if (installation === undefined) record('LaunchAgent', false, '配置存在，但当前 clone 尚未初始化，无法验证 ownership')
  else {
    try {
      await assertServiceAvailable(installation)
      record('LaunchAgent', true, SERVICE_LABEL)
    } catch (error) {
      record('LaunchAgent', false, messageOf(error))
    }
  }
  const identity = await readServiceIdentity()
  record(
    '后台服务',
    installation !== undefined && identity?.installationId === installation.id,
    identity === undefined ? '未运行或无法验证' : `http://${HOST}:${PORT}`,
  )
  if (checks.some(check => !check.ok)) process.exitCode = 1
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function progressStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  console.error(`→ ${label}`)
  const heartbeat = setInterval(() => {
    console.error(`… ${label}（已等待 ${formatDuration(Date.now() - startedAt)}）`)
  }, 10_000)
  heartbeat.unref()
  try {
    const result = await operation()
    console.error(`✓ ${label}（${formatDuration(Date.now() - startedAt)}）`)
    return result
  } catch (error) {
    console.error(`✗ ${label}（${formatDuration(Date.now() - startedAt)}）`)
    throw error
  } finally {
    clearInterval(heartbeat)
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(1, milliseconds)}ms`
  const seconds = Math.round(milliseconds / 100) / 10
  return `${seconds}s`
}

function printHelp(): void {
  console.log(helpText())
}

function helpText(): string {
  return `Usage: dshw <command> [options]

Commands:
  start              初始化并启动后台服务（构建插件 bundle 与 VS Code workspace）
  stop               停止当前 clone 拥有的后台服务
  restart            构建插件 bundle 并安全重启后台服务
  status             查看后台服务摘要
  code [arg]         用 VS Code 打开当前分支对应的 worktree
  doctor             检查本机依赖、登录和服务状态
  help               显示帮助

运行数据保存在 ${DSHW_ROOT}/.dshw；服务只注册到当前用户的 launchd。
Project: ${DSHW_ROOT}`
}
