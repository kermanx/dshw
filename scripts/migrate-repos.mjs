#!/usr/bin/env node
/**
 * 迁移 .dshw/state.json 到多 repo 版本（v2 → v3）。
 *
 * v3 新增 `repos` 字段（监控仓库列表，顺序即面板展示顺序）。
 * 以现有 sync 记录的 repoSlug 推断默认监控仓库；若没有任何 sync，
 * 默认监控 deepseek-harness/deepseek-harness（dshw 主仓库）。
 *
 * 用法: node scripts/migrate-repos.mjs [state.json 路径]
 * 默认路径: <dshw 根>/.dshw/state.json
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSHW_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HARNESS_REPO_SLUG = 'deepseek-harness/deepseek-harness'
const statePath = resolve(process.argv[2] ?? join(DSHW_ROOT, '.dshw', 'state.json'))

const raw = await readFile(statePath, 'utf8')
const state = JSON.parse(raw)

if (state.version === 3) {
  console.log(`state.json 已经是 v3，无需迁移：${statePath}`)
  process.exit(0)
}
if (state.version !== 2) {
  console.error(`不支持的 state 版本 ${String(state.version)}，拒绝迁移`)
  process.exit(1)
}

const repoSlug = state.syncs?.[0]?.repoSlug ?? HARNESS_REPO_SLUG
const migrated = {
  ...state,
  version: 3,
  repos: [{ repoSlug, enabled: true }],
}

const backup = `${statePath}.v2.bak`
await rename(statePath, backup)
try {
  await writeFile(statePath, `${JSON.stringify(migrated, null, 2)}\n`)
  console.log(`已迁移到 v3：监控仓库 = ${repoSlug}（原文件备份为 ${backup}）`)
} catch (error) {
  await rename(backup, statePath)
  throw error
}
