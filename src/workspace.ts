import { dirname, relative, sep } from 'node:path'
import { CODE_WORKSPACE_FILE, DSHW_ROOT, STATE_FILE } from './config.ts'
import { listClones } from './clone.ts'
import { pullRequest } from './github.ts'
import type { PrDashboardRecord, ServiceState } from './types.ts'
import { messageOf, readJson, writeJsonAtomic } from './util.ts'

export interface CodeWorkspaceFolder {
  name: string
  path: string
}

export interface WorkspaceRefreshResult {
  folders: CodeWorkspaceFolder[]
  warnings: string[]
}

export function codeWorkspaceFolders(
  clones: readonly { name: string; path: string; prNumber: number; repoSlug: string }[],
  workspaceRoot = dirname(CODE_WORKSPACE_FILE),
): CodeWorkspaceFolder[] {
  const folders = clones.map(clone => ({
    // 多 repo 下 PR 号会跨仓库冲突，文件夹名带上仓库名以便区分
    name: `#${clone.prNumber} · ${clone.repoSlug}`,
    path: `./${relative(workspaceRoot, clone.path).split(sep).join('/')}`,
  }))
  folders.push({ name: 'dshw', path: `./${relative(workspaceRoot, DSHW_ROOT).split(sep).join('/')}` })
  return folders
}

/** Write exactly the PR folders currently shown by the dashboard, in dashboard order. */
export async function refreshCodeWorkspace(dashboard?: readonly PrDashboardRecord[]): Promise<WorkspaceRefreshResult> {
  if (dashboard !== undefined) {
    const folders = codeWorkspaceFolders(dashboard.map(pr => ({
      name: pr.cloneName,
      path: pr.clonePath,
      prNumber: pr.number,
      repoSlug: pr.repoSlug,
    })))
    await writeJsonAtomic(CODE_WORKSPACE_FILE, { folders })
    return { folders, warnings: [] }
  }

  // Before the daemon starts, use the same persisted dashboard snapshot the
  // UI will render. This avoids a second source of truth during startup.
  const state = await readJson<ServiceState>(STATE_FILE)
  const cached = state?.version === 3 ? state.prDashboardCache?.records : undefined
  if (cached !== undefined) return await refreshCodeWorkspace(cached)

  // First-ever startup has no dashboard snapshot yet. Resolve open PRs once,
  // using the dashboard's active-before-draft, then PR-number ordering.
  const clones = await listClones()
  const warnings: string[] = []
  const resolved = await Promise.all(clones.map(async clone => {
    try {
      const pr = await pullRequest(clone.path, clone.repoSlug, undefined, clone.branch)
      return pr.state === 'OPEN'
        ? { name: clone.name, path: clone.path, prNumber: pr.number, repoSlug: clone.repoSlug, isDraft: pr.isDraft }
        : undefined
    } catch (error) {
      warnings.push(`${clone.name}: ${messageOf(error)}`)
      return undefined
    }
  }))
  const open = resolved
    .filter((clone): clone is NonNullable<typeof clone> => clone !== undefined)
    .sort((left, right) => Number(left.isDraft) - Number(right.isDraft) || left.prNumber - right.prNumber || left.name.localeCompare(right.name))
  const folders = codeWorkspaceFolders(open)
  await writeJsonAtomic(CODE_WORKSPACE_FILE, { folders })
  return { folders, warnings }
}
