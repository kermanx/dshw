#!/usr/bin/env node
/**
 * 迁移 clone 命名到带仓库标识的格式，并移除 .dshw/clones/ 元数据目录。
 *
 * 旧格式: pr-<number>（目录 / worktree 分支 dshw/pr-<number> / clones/pr-<number>.json）
 * 新格式: pr-<owner>-<repo>-<number>（目录 + worktree 分支 dshw/pr-<owner>-<repo>-<number>，
 *          不再有独立元数据文件，worktree 信息由 git 枚举推导）
 *
 * 步骤（每个 clone）:
 *   1. git branch -m 重命名 worktree 分支
 *   2. 移动 worktree 目录
 *   3. git worktree repair 修复 gitdir 链接
 *   4. 删除旧元数据 json
 * 最后更新 state.json 中 syncs 的 cloneName/clonePath 并删除 clones/ 目录。
 *
 * 用法: node scripts/migrate-clone-names.mjs
 * 建议先停止 daemon（pnpm dshw stop）再运行。
 */
import { execFileSync } from 'node:child_process'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSHW_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_ROOT = join(DSHW_ROOT, '.dshw')
const CLONES_ROOT = join(DATA_ROOT, 'worktrees')
const META_ROOT = join(DATA_ROOT, 'clones')
const STATE_FILE = join(DATA_ROOT, 'state.json')

function prCloneName(number, repoSlug) {
  const [owner, name] = repoSlug.split('/')
  if (owner === undefined || name === undefined) throw new Error(`无效的仓库 slug：${JSON.stringify(repoSlug)}`)
  return `pr-${owner}-${name}-${number}`
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe', cwd })
}

const state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
if (state.version !== 3) {
  console.error(`state.json 版本为 ${String(state.version)}，预期 3，拒绝迁移`)
  process.exit(1)
}

const metaEntries = await readdir(META_ROOT, { withFileTypes: true }).catch(() => [])
const jsonFiles = metaEntries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
const syncs = state.syncs ?? []

const renamed = []
const skipped = []
let syncsUpdated = 0

for (const entry of jsonFiles) {
  const metaPath = join(META_ROOT, entry.name)
  let meta
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'))
  } catch {
    console.warn(`跳过无法解析的元数据：${entry.name}`)
    continue
  }
  const oldName = meta.name
  const match = /^pr-(\d+)$/u.exec(oldName ?? '')
  if (match === null) {
    skipped.push(oldName)
    continue
  }
  const newName = prCloneName(Number(match[1]), meta.repoSlug)
  const newPath = join(CLONES_ROOT, newName)
  try {
    if (newName !== oldName) {
      git(['branch', '-m', meta.worktreeBranch, `dshw/${newName}`], meta.sourcePath)
      await rename(meta.path, newPath)
      git(['worktree', 'repair', newPath], meta.sourcePath)
      // 验证 worktree 仍可用
      git(['rev-parse', '--git-dir'], newPath)
    }
    await rm(metaPath, { force: true })
    for (const sync of syncs) {
      if (sync.cloneName === oldName) {
        sync.cloneName = newName
        syncsUpdated += 1
      }
      if (sync.clonePath === meta.path) {
        sync.clonePath = newPath
        syncsUpdated += 1
      }
    }
    renamed.push(`${oldName} → ${newName}`)
  } catch (error) {
    console.error(`迁移失败：${oldName}（${error instanceof Error ? error.message : String(error)}）`)
  }
}

if (renamed.length > 0 || syncsUpdated > 0) {
  const backup = `${STATE_FILE}.v3.bak`
  await rename(STATE_FILE, backup)
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
  console.log(`state.json 已更新（备份 ${backup}），syncs 字段更新 ${syncsUpdated} 处`)
}
await rm(META_ROOT, { recursive: true, force: true })

console.log(`迁移完成：${renamed.length} 个 clone 重命名${skipped.length > 0 ? `，${skipped.length} 个跳过（${skipped.join('、')}）` : ''}；clones/ 目录已移除`)
