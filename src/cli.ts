#!/usr/bin/env node

import { access } from 'node:fs/promises'
import { formatClonePath, resolveClone } from './clone.ts'
import { resolveCommandTarget } from './command-target.ts'
import { CODE_WORKSPACE_FILE, DSHW_ROOT, HOST, PORT, SERVICE_LABEL, SERVICE_PLIST } from './config.ts'
import { runDevPreview } from './dev.ts'
import { ensureInstallation, ensureManagedHarness, readInstallation, type InstallationRecord } from './install.ts'
import { runService } from './service.ts'
import {
  assertServiceAvailable,
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
      const installation = await ensureInstallation()
      await ensureManagedHarness(installation)
      const target = resolveCommandTarget(args[0])
      const clone = await resolveClone(target.cloneName, target.cwd)
      await runOrThrow('code', [clone.path])
      console.log(formatClonePath(clone))
      break
    }
    case 'start': {
      const openCode = parseStartArgs(args)
      const installation = await ensureInstallation()
      await assertServiceAvailable(installation)
      await ensureManagedHarness(installation)
      await buildUi()
      await refreshWorkspaceWithWarning()
      await startService(installation)
      if (openCode) await openCodeWorkspaceWithWarning()
      console.log(`dshw 后台服务已启动：http://${HOST}:${PORT}`)
      break
    }
    case 'stop': {
      requireNoArgs(args)
      const installation = await requireInstallation()
      const stopped = await stopService(installation)
      console.log(stopped ? 'dshw 后台服务已停止' : 'dshw 后台服务本来就未运行')
      break
    }
    case 'restart': {
      requireNoArgs(args)
      const installation = await requireInstallation()
      await buildUi()
      await restartService(installation)
      console.log('dshw 后台服务已安全重启；运行中的 dsh 任务不受影响')
      break
    }
    case 'status': {
      requireNoArgs(args)
      const installation = await requireInstallation()
      const state = await getWorkflowState(installation)
      console.log(`服务运行中；${state.service.activeJobs} 个任务执行中；追踪 ${state.syncs.length} 个 PR；UI：http://${HOST}:${PORT}`)
      break
    }
    case 'ui': {
      requireNoArgs(args)
      const installation = await requireInstallation()
      await getWorkflowState(installation)
      await runOrThrow('open', [`http://${HOST}:${PORT}`])
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
    case 'dev': {
      requireNoArgs(args)
      await runDevPreview()
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

function parseStartArgs(args: readonly string[]): boolean {
  if (args.length === 0) return true
  if (args.length === 1 && args[0] === '--no-code') return false
  throw new Error('start 只接受可选参数 --no-code')
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

async function openCodeWorkspaceWithWarning(): Promise<void> {
  try {
    const result = await run('code', [CODE_WORKSPACE_FILE])
    if (result.code !== 0) {
      console.warn(`dshw: 服务已启动，但 VS Code 打开失败：${result.stderr.trim() || result.stdout.trim() || '找不到 code 命令'}`)
    }
  } catch (error) {
    console.warn(`dshw: 服务已启动，但 VS Code 打开失败：${messageOf(error)}`)
  }
}

async function buildUi(): Promise<void> {
  await runOrThrow('pnpm', ['run', 'build:ui'], { cwd: DSHW_ROOT, timeoutMs: 2 * 60 * 1000 })
}

async function doctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  checks.push({ name: 'macOS', ok: process.platform === 'darwin', detail: process.platform })
  checks.push({ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version })
  for (const executable of ['pnpm', 'git', 'gh', 'code']) {
    try {
      const result = await run(executable, ['--version'])
      checks.push({ name: executable, ok: result.code === 0, detail: (result.stdout || result.stderr).trim().split('\n')[0] || '不可用' })
    } catch (error) {
      checks.push({ name: executable, ok: false, detail: messageOf(error) })
    }
  }
  try {
    const auth = await run('gh', ['auth', 'status'])
    checks.push({ name: 'GitHub 登录', ok: auth.code === 0, detail: auth.code === 0 ? '已登录' : '请运行 gh auth login' })
  } catch (error) {
    checks.push({ name: 'GitHub 登录', ok: false, detail: messageOf(error) })
  }
  let installation: InstallationRecord | undefined
  try {
    installation = await readInstallation()
    checks.push({ name: '本地数据', ok: installation !== undefined, detail: installation === undefined ? '尚未运行 start' : `${DSHW_ROOT}/.dshw` })
  } catch (error) {
    checks.push({ name: '本地数据', ok: false, detail: messageOf(error) })
  }
  const plistExists = await pathExists(SERVICE_PLIST)
  if (!plistExists) checks.push({ name: 'LaunchAgent', ok: false, detail: '尚未安装' })
  else if (installation === undefined) checks.push({ name: 'LaunchAgent', ok: false, detail: '配置存在，但当前 clone 尚未初始化，无法验证 ownership' })
  else {
    try {
      await assertServiceAvailable(installation)
      checks.push({ name: 'LaunchAgent', ok: true, detail: SERVICE_LABEL })
    } catch (error) {
      checks.push({ name: 'LaunchAgent', ok: false, detail: messageOf(error) })
    }
  }
  const identity = await readServiceIdentity()
  checks.push({
    name: '后台服务',
    ok: installation !== undefined && identity?.installationId === installation.id,
    detail: identity === undefined ? '未运行或无法验证' : `http://${HOST}:${PORT}`,
  })
  for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
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

function printHelp(): void {
  console.log(helpText())
}

function helpText(): string {
  return `Usage: dshw <command> [options]

Commands:
  start [--no-code]  初始化并启动后台服务；默认打开 VS Code
  stop               停止当前 clone 拥有的后台服务
  restart            构建 UI 并安全重启后台服务
  status             查看后台服务摘要
  ui                 在浏览器打开状态页
  code [arg]         用 VS Code 打开当前分支对应的 worktree
  doctor             检查本机依赖、登录和服务状态
  dev                启动只读 Vite 开发预览（端口 7850）
  help               显示帮助

运行数据保存在 ${DSHW_ROOT}/.dshw；服务只注册到当前用户的 launchd。
Project: ${DSHW_ROOT}`
}
