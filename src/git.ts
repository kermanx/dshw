import { realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { CLONES_ROOT } from './config.ts'
import { run, runOrThrow } from './util.ts'

export async function gitRoot(cwd: string): Promise<string> {
  const result = await runOrThrow('git', ['rev-parse', '--show-toplevel'], { cwd })
  return await realpath(result.stdout.trim())
}

export function isInsideDirectory(path: string, directory: string): boolean {
  const pathRelative = relative(resolve(directory), resolve(path))
  return pathRelative === '' || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== '..')
}

export async function requireHarnessRepository(cwd: string): Promise<string> {
  const root = await gitRoot(cwd)
  if (isInsideDirectory(root, CLONES_ROOT)) throw new Error(`不能从 dsh-workflow/clones 内再次创建 clone：${root}`)
  const remote = await originUrl(root)
  if (repoSlugFromRemote(remote) !== 'deepseek-harness/deepseek-harness') {
    throw new Error(`当前 Git 仓库的 origin 不是 deepseek-harness/deepseek-harness：${remote}`)
  }
  return root
}

export async function branchName(root: string): Promise<string> {
  const result = await runOrThrow('git', ['branch', '--show-current'], { cwd: root })
  const branch = result.stdout.trim()
  if (branch === '') throw new Error('当前仓库处于 detached HEAD，无法创建工作 clone')
  return branch
}

export async function originUrl(root: string): Promise<string> {
  return (await runOrThrow('git', ['remote', 'get-url', 'origin'], { cwd: root })).stdout.trim()
}

export function repoSlugFromRemote(remote: string): string {
  const normalized = remote
    .replace(/^git@github\.com:/, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
  if (!/^[^/]+\/[^/]+$/.test(normalized)) {
    throw new Error(`无法从 origin 推断 GitHub 仓库：${remote}`)
  }
  return normalized
}

export async function currentHead(root: string): Promise<string> {
  return (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
}

export async function fetchBranch(root: string, branch: string, signal?: AbortSignal): Promise<void> {
  await runOrThrow('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: root,
    timeoutMs: 5 * 60 * 1000,
    signal,
  })
}

export async function isAncestor(root: string, ref: string): Promise<boolean> {
  const result = await run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd: root })
  return result.code === 0
}

export async function addSharedWorktree(
  managedRoot: string,
  branch: string,
  name: string,
  destination: string,
): Promise<string> {
  const worktreeBranch = `dshw/${name}`
  const existing = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${worktreeBranch}`], { cwd: managedRoot })
  if (existing.code === 0) throw new Error(`托管仓库已存在本地分支 ${worktreeBranch}；请先清理残留 worktree`)
  await runOrThrow('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: managedRoot,
    timeoutMs: 5 * 60 * 1000,
  })
  await runOrThrow('git', ['config', 'extensions.worktreeConfig', 'true'], { cwd: managedRoot })
  let added = false
  try {
    await runOrThrow(
      'git',
      ['worktree', 'add', '-b', worktreeBranch, destination, `refs/remotes/origin/${branch}`],
      { cwd: managedRoot, timeoutMs: 5 * 60 * 1000 },
    )
    added = true
    await runOrThrow('git', ['branch', '--set-upstream-to', `origin/${branch}`, worktreeBranch], { cwd: destination })
    await runOrThrow('git', ['config', '--worktree', 'push.default', 'upstream'], { cwd: destination })
    return worktreeBranch
  } catch (error) {
    if (added) await removeSharedWorktree(managedRoot, worktreeBranch, destination)
    throw error
  }
}

export async function removeSharedWorktree(
  managedRoot: string,
  worktreeBranch: string,
  destination: string,
): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', destination], { cwd: managedRoot })
  await run('git', ['branch', '-D', worktreeBranch], { cwd: managedRoot })
  await run('git', ['worktree', 'prune'], { cwd: managedRoot })
}

export async function remoteBranchOid(repoSlug: string, branch: string): Promise<string> {
  const result = await runOrThrow(
    'git',
    ['ls-remote', `https://github.com/${repoSlug}.git`, `refs/heads/${branch}`],
    { timeoutMs: 30_000 },
  )
  const oid = result.stdout.trim().split(/\s+/)[0]
  if (oid === undefined || oid === '') throw new Error(`${repoSlug} 的 target branch ${branch} 不存在`)
  return oid
}
