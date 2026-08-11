#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatClonePath, resolveClone } from './clone.ts'
import { resolveCommandTarget } from './command-target.ts'
import {
  DATA_ROOT,
  CODE_WORKSPACE_FILE,
  DSHW_ROOT,
  HOST,
  PORT,
  SERVICE_LABEL,
  SERVICE_PLIST,
  WORKFLOW_ROOT,
} from './config.ts'
import { runService } from './service.ts'
import { runDevPreview } from './dev.ts'
import { dshLaunchEnvironmentXml } from './dsh-launch-env.ts'
import { escapeXml, messageOf, run, runOrThrow } from './util.ts'
import { refreshCodeWorkspace } from './workspace.ts'

const [command = 'help', ...args] = process.argv.slice(2)

try {
  switch (command) {
    case 'code': {
      requireAtMostOne(args)
      const target = resolveCommandTarget(args[0])
      const clone = await resolveClone(target.cloneName, target.cwd)
      await runOrThrow('code', [clone.path])
      console.log(formatClonePath(clone))
      break
    }
    case 'start': {
      requireNoArgs(args)
      await buildUi()
      await refreshWorkspaceWithWarning()
      await installService()
      await runOrThrow('code', [CODE_WORKSPACE_FILE])
      console.log(`dshw 后台服务已安装并启动：http://${HOST}:${PORT}`)
      break
    }
    case 'stop': {
      requireNoArgs(args)
      const result = await run('launchctl', ['bootout', serviceDomain()])
      if (result.code !== 0 && !/could not find service/i.test(result.stderr)) {
        throw new Error(result.stderr.trim() || '停止服务失败')
      }
      console.log('dshw 后台服务已停止')
      break
    }
    case 'restart': {
      requireNoArgs(args)
      await buildUi()
      await api('/api/restart', {})
      console.log('dshw 正在安全重启；运行中的 dsh 任务由 launchd 保持，新服务会重新接管')
      break
    }
    case 'status': {
      requireNoArgs(args)
      const state = await getState()
      console.log(`服务运行中；${state.service.activeJobs} 个任务执行中；追踪 ${state.syncs.length} 个 PR；UI：http://${HOST}:${PORT}`)
      break
    }
    case 'ui': {
      requireNoArgs(args)
      await runOrThrow('open', [`http://${HOST}:${PORT}`])
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

async function api(path: string, body: object): Promise<Record<string, unknown>> {
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

async function getState(): Promise<{ service: { activeJobs: number }; syncs: unknown[] }> {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/api/state`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as { service: { activeJobs: number }; syncs: unknown[] }
  } catch (error) {
    throw new Error(`后台服务未运行（${messageOf(error)}）`)
  }
}

async function installService(): Promise<void> {
  await mkdir(DATA_ROOT, { recursive: true })
  await mkdir(dirname(SERVICE_PLIST), { recursive: true })
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url))
  const path = process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(cliPath)}</string><string>daemon</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(WORKFLOW_ROOT)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
    ${dshLaunchEnvironmentXml(process.env)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(`${DATA_ROOT}/service.stdout.log`)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(`${DATA_ROOT}/service.stderr.log`)}</string>
  <key>ThrottleInterval</key><integer>5</integer>
</dict></plist>
`
  await writeFile(SERVICE_PLIST, plist)
  const loaded = await run('launchctl', ['print', serviceDomain()])
  if (loaded.code === 0) return
  await runOrThrow('launchctl', ['bootstrap', `gui/${uid()}`, SERVICE_PLIST])
  await runOrThrow('launchctl', ['enable', serviceDomain()])
}

function serviceDomain(): string {
  return `gui/${uid()}/${SERVICE_LABEL}`
}

function uid(): number {
  if (process.getuid === undefined) throw new Error('dshw 后台服务目前只支持 macOS/Unix')
  return process.getuid()
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
    console.warn(`dshw: code workspace 暂时无法刷新：${messageOf(error)}`)
  }
}

async function buildUi(): Promise<void> {
  await runOrThrow('pnpm', ['run', 'build:ui'], { cwd: DSHW_ROOT, timeoutMs: 2 * 60 * 1000 })
}

function printHelp(): void {
  console.log(helpText())
}

function helpText(): string {
  return `Usage: dshw <command> [name|repo-id]

Commands:
  code [arg]     用 VS Code 打开当前分支被自动追踪的 worktree
  start          安装并启动后台服务，然后打开 code workspace
  stop           停止后台服务
  restart        安全重启后台服务；不打断 launchd 中的 dsh 任务
  status         查看后台服务摘要
  ui             在浏览器打开实时状态页
  dev            启动 Vue + UnoCSS 的只读 Vite 热更新预览（端口 7850）
  help           显示帮助

GitHub 上你创建的所有 open PR 会被后台服务自动克隆并纳入追踪；
每个 PR 的自动 sync（合并 base / 修 CI）在 UI 上单独开关。

纯数字 arg 是 ~/workspace/deepseek-harness-<id> 的仓库编号；0 表示 ~/workspace/deepseek-harness。
非数字 arg 仍表示显式 clone name，并使用当前目录作为源仓库。

Project: ${DSHW_ROOT}`
}
