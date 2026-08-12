import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CLONE_METADATA_ROOT, CLONES_ROOT, HARNESS_ROOT } from './config.ts'
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
import { now, readJson, writeJsonAtomic } from './util.ts'

export function validateCloneName(name: string): void {
  const invalidGitRef = name.includes('..') || name.endsWith('.') || name.endsWith('.lock')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || invalidGitRef) {
    throw new Error('clone 名称必须能安全组成 Git 分支名，只能包含字母、数字、点、下划线和连字符，长度不超过 64')
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

export async function listClones(): Promise<CloneRecord[]> {
  await mkdir(CLONES_ROOT, { recursive: true })
  await mkdir(CLONE_METADATA_ROOT, { recursive: true })
  const entries = await readdir(CLONE_METADATA_ROOT, { withFileTypes: true })
  const records = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => readJson<CloneRecord>(join(CLONE_METADATA_ROOT, entry.name))))
  const present = await Promise.all(records.map(async record => {
    if (record === undefined) return undefined
    return await exists(join(record.path, '.git')) ? record : undefined
  }))
  return present.filter((record): record is CloneRecord => record !== undefined)
}

/**
 * 为自动发现的 PR 创建 clone：克隆名即 PR 名（pr-<number>）。
 * 已存在同分支 clone（包括旧的 dsh-N 命名）时直接复用。
 */
export async function createPrClone(pr: MyPullRequestSummary, repoSlug: string): Promise<CloneRecord> {
  const clones = await listClones()
  const byBranch = clones.find(clone => clone.repoSlug === repoSlug && clone.branch === pr.headRefName)
  if (byBranch !== undefined) return byBranch

  await mkdir(CLONES_ROOT, { recursive: true })
  let name = `pr-${pr.number}`
  for (let suffix = 2; clones.some(clone => clone.name === name) || await exists(join(CLONES_ROOT, name)); suffix += 1) {
    name = `pr-${pr.number}-${suffix}`
  }
  validateCloneName(name)
  const destination = join(CLONES_ROOT, name)
  const remoteUrl = `https://github.com/${repoSlug}.git`

  let worktreeCreated = false
  try {
    const worktreeBranch = await addSharedWorktree(HARNESS_ROOT, pr.headRefName, name, destination)
    worktreeCreated = true
    const record: CloneRecord = {
      name,
      path: destination,
      sourcePath: HARNESS_ROOT,
      remoteUrl,
      repoSlug,
      branch: pr.headRefName,
      worktreeBranch,
      createdAt: now(),
    }
    await writeJsonAtomic(join(CLONE_METADATA_ROOT, `${name}.json`), record)
    return record
  } catch (error) {
    if (worktreeCreated) await removeSharedWorktree(HARNESS_ROOT, `dshw/${name}`, destination)
    await rm(join(CLONE_METADATA_ROOT, `${name}.json`), { force: true })
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
  paths: { managedRoot?: string, clonesRoot?: string, metadataRoot?: string } = {},
): Promise<void> {
  validateCloneName(clone.name)
  const managedRoot = paths.managedRoot ?? HARNESS_ROOT
  const clonesRoot = paths.clonesRoot ?? CLONES_ROOT
  const metadataRoot = paths.metadataRoot ?? CLONE_METADATA_ROOT
  if (resolve(clone.path) === resolve(clonesRoot) || !isInsideDirectory(clone.path, clonesRoot)) {
    throw new Error(`拒绝删除 worktree 目录之外的路径：${clone.path}`)
  }
  await removeSharedWorktree(managedRoot, clone.worktreeBranch, clone.path)
  await rm(join(metadataRoot, `${clone.name}.json`), { force: true })
  await rm(clone.path, { recursive: true, force: true })
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
