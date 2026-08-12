import { realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { CLONES_ROOT } from './config.ts'
import type { CloneGitStatus } from './types.ts'
import { run, runOrThrow, TaskCancelledError } from './util.ts'

const TRANSIENT_GIT_NETWORK_RETRY_DELAYS_MS = [250, 500, 1_000] as const

export function isTransientGitNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\bSSL_ERROR_SYSCALL\b/iu.test(message)
}

async function waitForGitNetworkRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new TaskCancelledError()
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolvePromise()
    }, milliseconds)
    const cancel = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      reject(new TaskCancelledError())
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted === true) cancel()
  })
}

export async function retryTransientGitNetworkOperation<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal, retryDelaysMs?: readonly number[] } = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? TRANSIENT_GIT_NETWORK_RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt]
      if (retryDelayMs === undefined || !isTransientGitNetworkError(error)) throw error
      await waitForGitNetworkRetry(retryDelayMs, options.signal)
    }
  }
}

export async function gitRoot(cwd: string): Promise<string> {
  const result = await runOrThrow('git', ['rev-parse', '--show-toplevel'], { cwd })
  return await realpath(result.stdout.trim())
}

export async function gitCommonDir(cwd: string): Promise<string> {
  const result = await runOrThrow('git', ['rev-parse', '--git-common-dir'], { cwd })
  return await realpath(resolve(cwd, result.stdout.trim()))
}

export function isInsideDirectory(path: string, directory: string): boolean {
  const pathRelative = relative(resolve(directory), resolve(path))
  return pathRelative === '' || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== '..')
}

export async function requireHarnessRepository(cwd: string): Promise<string> {
  const root = await gitRoot(cwd)
  if (isInsideDirectory(root, CLONES_ROOT)) throw new Error(`不能从 dshw 托管的 worktrees 内再次创建 worktree：${root}`)
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

export async function commitOid(root: string, ref: string): Promise<string> {
  return (await runOrThrow('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root })).stdout.trim()
}

export async function fetchBranch(root: string, branch: string, signal?: AbortSignal): Promise<void> {
  await retryTransientGitNetworkOperation(
    () => runOrThrow('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      cwd: root,
      timeoutMs: 5 * 60 * 1000,
      signal,
    }),
    { signal },
  )
}

/** Resolve the current remote branch tip and ensure that exact commit exists locally. */
export async function fetchRemoteBranchTip(root: string, branch: string, signal?: AbortSignal): Promise<string> {
  const result = await retryTransientGitNetworkOperation(
    () => runOrThrow('git', ['ls-remote', 'origin', `refs/heads/${branch}`], {
      cwd: root,
      timeoutMs: 30_000,
      signal,
    }),
    { signal },
  )
  const oid = result.stdout.trim().split(/\s+/u)[0]
  if (oid === undefined || oid === '') throw new Error(`origin 的 target branch ${branch} 不存在`)
  try {
    await commitOid(root, oid)
  } catch {
    await fetchBranch(root, branch, signal)
    await commitOid(root, oid)
  }
  return oid
}

export async function isAncestor(root: string, ref: string, descendant = 'HEAD'): Promise<boolean> {
  const result = await run('git', ['merge-base', '--is-ancestor', ref, descendant], { cwd: root })
  return result.code === 0
}

export function parseCloneGitStatus(porcelain: string, divergence: string, merging: boolean): CloneGitStatus {
  let unstaged = false
  let staged = false
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('? ')) {
      unstaged = true
      continue
    }
    if (line.startsWith('u ')) {
      unstaged = true
      continue
    }
    if (!line.startsWith('1 ') && !line.startsWith('2 ')) continue
    const indexStatus = line[2]
    const worktreeStatus = line[3]
    if (indexStatus !== undefined && indexStatus !== '.') staged = true
    if (worktreeStatus !== undefined && worktreeStatus !== '.') unstaged = true
  }
  const [aheadText = '0', behindText = '0'] = divergence.trim().split(/\s+/u)
  const ahead = Number.parseInt(aheadText, 10)
  const behind = Number.parseInt(behindText, 10)
  return {
    unstaged,
    staged,
    merging,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  }
}

/** Read worktree/index state and compare local HEAD with the exact head GitHub reported. */
export async function cloneGitStatus(root: string, remoteHeadOid: string): Promise<CloneGitStatus> {
  const [status, divergence, mergeHead] = await Promise.all([
    runOrThrow('git', ['status', '--porcelain=v2', '--untracked-files=normal'], { cwd: root }),
    runOrThrow('git', ['rev-list', '--left-right', '--count', `HEAD...${remoteHeadOid}`], { cwd: root }),
    run('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: root }),
  ])
  return parseCloneGitStatus(status.stdout, divergence.stdout, mergeHead.code === 0)
}

/** Compute conflicted paths without changing the worktree or index. */
export async function mergeConflictPaths(
  root: string,
  left: string,
  right: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // GitHub does not run the repository's worktree-local translation pairing driver.
  // Use the standard text merge for those records so this preview matches GitHub's
  // mergeability result instead of silently resolving conflicts only on this machine.
  const args = [
    '-c', 'merge.dsh-translation-pairing.driver=git merge-file %A %O %B',
    'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', left, right,
  ]
  const result = await run('git', args, { cwd: root, signal })
  if (result.cancelled) throw new TaskCancelledError()
  if (result.code !== 0 && result.code !== 1) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  const [treeOid, ...paths] = result.stdout.split('\0')
  if (treeOid === undefined || !/^[0-9a-f]{40,64}$/u.test(treeOid)) {
    const detail = result.stderr.trim()
    if (detail !== '') throw new Error(`git ${args.join(' ')} failed: ${detail}`)
    throw new Error(`git merge-tree 返回了无效 tree OID：${JSON.stringify(treeOid)}`)
  }
  return paths.filter(path => path !== '')
}

export function isDocumentationConflictPath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.i18n.yaml') || path.endsWith('.i18n.yml')
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
