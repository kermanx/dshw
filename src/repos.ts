import { access, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { HARNESS_REPO_SLUG, HARNESS_ROOT, MANAGED_ROOT } from './config.ts'
import { ensureManagedHarness, type InstallationRecord } from './install.ts'
import { runOrThrow } from './util.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 每个被监控 repo 的托管 clone 根目录（worktree 的共享对象库所在）。 */
export function managedRootFor(repoSlug: string): string {
  if (repoSlug === HARNESS_REPO_SLUG) return HARNESS_ROOT
  const [owner, name] = repoSlug.split('/')
  if (owner === undefined || name === undefined || owner === '' || name === '') {
    throw new Error(`无效的 GitHub 仓库：${JSON.stringify(repoSlug)}`)
  }
  return resolve(join(MANAGED_ROOT, owner, name))
}

/**
 * 确保被监控 repo 的托管 clone 存在（harness 主仓库走既有的 ownership 流程，
 * 其它 repo 首次出现时做一次完整 clone）。
 */
export async function ensureManagedRoot(repoSlug: string, installation?: InstallationRecord): Promise<string> {
  const root = managedRootFor(repoSlug)
  if (repoSlug === HARNESS_REPO_SLUG) {
    if (installation !== undefined) await ensureManagedHarness(installation)
    if (!(await exists(join(root, '.git')))) throw new Error(`托管主仓库缺失：${root}`)
    return root
  }
  if (await exists(join(root, '.git'))) return root
  await mkdir(dirname(root), { recursive: true })
  await runOrThrow('git', ['clone', '--no-tags', `https://github.com/${repoSlug}.git`, root], {
    timeoutMs: 10 * 60 * 1000,
  })
  return root
}
