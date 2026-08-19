import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CLONES_ROOT, MANAGED_ROOT } from './config.ts'
import { managedRootFor } from './repos.ts'
import type { CloneRecord, MyPullRequestSummary } from './types.ts'
import {
  branchName,
  addSharedWorktree,
  isInsideDirectory,
  originUrl,
  removeSharedWorktree,
  repoSlugFromRemote,
  requireHarnessRepository,
} from './git.ts'
import { run } from './util.ts'

export function validateCloneName(name: string): void {
  const invalidGitRef = name.includes('..') || name.endsWith('.') || name.endsWith('.lock')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || invalidGitRef) {
    throw new Error('clone 名称必须能安全组成 Git 分支名，只能包含字母、数字、点、下划线和连字符，长度不超过 64')
  }
}

/** PR clone 名：带仓库标识（多 repo 下 PR 号会跨仓库冲突），如 pr-deepseek-harness-deepseek-harness-1768。 */
export function prCloneName(prNumber: number, repoSlug: string): string {
  const [owner, name] = repoSlug.split('/')
  if (owner === undefined || name === undefined) throw new Error(`无效的 GitHub 仓库：${JSON.stringify(repoSlug)}`)
  const candidate = `pr-${owner}-${name}-${prNumber}`
  validateCloneName(candidate)
  return candidate
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 所有被监控 repo 的托管 clone 根目录。harness 主仓库是单层
 *  （managed/deepseek-harness），其它 repo 是 managed/<owner>/<name>。 */
async function managedRoots(): Promise<string[]> {
  const roots: string[] = []
  const entries = await readdir(MANAGED_ROOT, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const candidate = join(MANAGED_ROOT, entry.name)
    if (await exists(join(candidate, '.git'))) {
      roots.push(candidate)
      continue
    }
    const names = await readdir(candidate, { withFileTypes: true }).catch(() => [])
    for (const name of names) {
      if (!name.isDirectory() || name.name.startsWith('.')) continue
      const root = join(candidate, name.name)
      if (await exists(join(root, '.git'))) roots.push(root)
    }
  }
  return roots
}

/** 解析 `git worktree list --porcelain` 输出。 */
function parseWorktreeList(output: string): Array<{ path: string; branch?: string }> {
  const records: Array<{ path: string; branch?: string }> = []
  let current: { path: string; branch?: string } | undefined
  for (const line of output.split('\n')) {
    if (line === '') {
      if (current !== undefined) {
        records.push(current)
        current = undefined
      }
      continue
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length).trim()
  }
  if (current !== undefined) records.push(current)
  return records
}

/** 从 worktree 推导 CloneRecord：origin → repoSlug，worktree 分支的 upstream → PR head 分支。 */
async function describeClone(path: string, name: string, worktreeBranch: string): Promise<CloneRecord | undefined> {
  try {
    const repoSlug = repoSlugFromRemote(await originUrl(path))
    let branch = name
    const merge = (await run('git', ['config', '--get', `branch.${worktreeBranch}.merge`], { cwd: path, timeoutMs: 10_000 })).stdout.trim()
    if (merge.startsWith('refs/heads/')) branch = merge.slice('refs/heads/'.length)
    return { name, path, repoSlug, branch, worktreeBranch }
  } catch {
    return undefined
  }
}

/** worktree 集合很少变化，但每次 /api/state 都会重新枚举（每个 worktree 要跑
 *  数次 git 子进程，几十个 PR 时可达数秒）。缓存后状态接口降到毫秒级；
 *  创建 / 删除 clone 时主动失效，新增托管 repo 等未覆盖的变更由滑动 TTL 兜底
 *  （空闲超过 TTL 才重算，活跃使用期间一直命中缓存）。 */
const CLONES_CACHE_IDLE_TTL_MS = 60_000
let clonesCache: { at: number; records: CloneRecord[] } | undefined

/** clone 集合变化后调用，使 listClones 立即重算。 */
export function invalidateClonesCache(): void {
  clonesCache = undefined
}

/** 枚举所有 dshw 管理的 PR worktree。git 是唯一真相源：worktree 分支
 *  `dshw/<name>` 标识归属，repo / PR head 分支从 worktree 自身推导。 */
export async function listClones(): Promise<CloneRecord[]> {
  if (clonesCache !== undefined && Date.now() - clonesCache.at < CLONES_CACHE_IDLE_TTL_MS) {
    clonesCache.at = Date.now()
    return clonesCache.records
  }
  const clones: CloneRecord[] = []
  for (const root of await managedRoots()) {
    const result = await run('git', ['worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: 15_000 })
    if (result.code !== 0) continue
    for (const worktree of parseWorktreeList(result.stdout)) {
      if (worktree.branch === undefined || !worktree.branch.startsWith('dshw/')) continue
      const name = worktree.branch.slice('dshw/'.length)
      if (!isInsideDirectory(worktree.path, CLONES_ROOT)) continue
      const record = await describeClone(worktree.path, name, worktree.branch)
      if (record !== undefined) clones.push(record)
    }
  }
  const records = clones.sort((left, right) => left.name.localeCompare(right.name))
  clonesCache = { at: Date.now(), records }
  return records
}
/**
 * 为自动发现的 PR 创建 clone：克隆名即 PR 名（pr-<owner>-<repo>-<number>）。
 * 已存在同分支 clone（包括旧的 dsh-N 命名）时直接复用。
 */
export async function createPrClone(pr: MyPullRequestSummary, repoSlug: string): Promise<CloneRecord> {
  const clones = await listClones()
  const byBranch = clones.find(clone => clone.repoSlug === repoSlug && clone.branch === pr.headRefName)
  if (byBranch !== undefined) return byBranch

  await mkdir(CLONES_ROOT, { recursive: true })
  const name = prCloneName(pr.number, repoSlug)
  const destination = join(CLONES_ROOT, name)

  let worktreeCreated = false
  try {
    const managedRoot = managedRootFor(repoSlug)
    const worktreeBranch = await addSharedWorktree(managedRoot, pr.headRefName, name, destination)
    worktreeCreated = true
    invalidateClonesCache()
    return { name, path: destination, repoSlug, branch: pr.headRefName, worktreeBranch }
  } catch (error) {
    if (worktreeCreated) await removeSharedWorktree(managedRootFor(repoSlug), `dshw/${name}`, destination)
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

export async function removeClone(name: string): Promise<CloneRecord> {
  validateCloneName(name)
  const clone = (await listClones()).find(candidate => candidate.name === name)
  if (clone === undefined) throw new Error(`找不到 worktree：${name}`)
  await removeCloneRecord(clone)
  return clone
}

export async function removeCloneRecord(
  clone: CloneRecord,
  paths: { managedRoot?: string, clonesRoot?: string } = {},
): Promise<void> {
  validateCloneName(clone.name)
  const clonesRoot = paths.clonesRoot ?? CLONES_ROOT
  if (resolve(clone.path) === resolve(clonesRoot) || !isInsideDirectory(clone.path, clonesRoot)) {
    throw new Error(`拒绝删除 worktree 目录之外的路径：${clone.path}`)
  }
  const managedRoot = paths.managedRoot ?? managedRootFor(clone.repoSlug)
  await removeSharedWorktree(managedRoot, clone.worktreeBranch, clone.path)
  await rm(clone.path, { recursive: true, force: true })
  invalidateClonesCache()
}

export function formatClonePath(clone: CloneRecord): string {
  return `${clone.path.slice(0, -clone.name.length)}[1m${clone.name}[0m`
}

export async function resolveClone(name: string | undefined, cwd = process.cwd()): Promise<CloneRecord> {
  const clones = await listClones()
  if (name !== undefined) {
    validateCloneName(name)
    const clone = clones.find(candidate => candidate.name === name)
    if (clone === undefined) throw new Error(`找不到 clone：${name}`)
    return clone
  }
  const sourcePath = await requireHarnessRepository(cwd)
  const branch = await branchName(sourcePath)
  const remoteUrl = await originUrl(sourcePath)
  const repoSlug = repoSlugFromRemote(remoteUrl)
  const clone = clones.find(candidate => candidate.repoSlug === repoSlug && candidate.branch === branch)
  if (clone === undefined) throw new Error(`当前分支 ${branch} 还没有 clone；它的 PR 被自动追踪后会出现在 ${CLONES_ROOT}`)
  return clone
}
