import { dirname, relative, sep } from 'node:path'
import { CLONES_ROOT, CODE_WORKSPACE_FILE, DSHW_ROOT } from './config.ts'
import { listClones } from './clone.ts'
import { pullRequest } from './github.ts'
import { messageOf, writeJsonAtomic } from './util.ts'

export interface CodeWorkspaceFolder {
  name: string
  path: string
}

export interface WorkspaceRefreshResult {
  folders: CodeWorkspaceFolder[]
  warnings: string[]
}

export function codeWorkspaceFolders(
  clones: readonly { name: string; path: string; prNumber: number }[],
  workspaceRoot = dirname(CODE_WORKSPACE_FILE),
): CodeWorkspaceFolder[] {
  const folders = [...clones]
    .sort((left, right) => left.prNumber - right.prNumber || left.name.localeCompare(right.name))
    .map(clone => ({
      name: `PR_${clone.prNumber}`,
      path: `./${relative(workspaceRoot, clone.path).split(sep).join('/')}`,
    }))
  folders.push({ name: 'dshw', path: `./${relative(workspaceRoot, DSHW_ROOT).split(sep).join('/')}` })
  folders.push({ name: 'worktrees', path: `./${relative(workspaceRoot, CLONES_ROOT).split(sep).join('/')}` })
  return folders
}

export async function refreshCodeWorkspace(): Promise<WorkspaceRefreshResult> {
  const clones = await listClones()
  const warnings: string[] = []
  const resolved = await Promise.all(clones.map(async clone => {
    try {
      const pr = await pullRequest(clone.path, clone.repoSlug, undefined, clone.branch)
      return pr.state === 'OPEN' ? { name: clone.name, path: clone.path, prNumber: pr.number } : undefined
    } catch (error) {
      warnings.push(`${clone.name}: ${messageOf(error)}`)
      return undefined
    }
  }))
  const open = resolved.filter((clone): clone is NonNullable<typeof clone> => clone !== undefined)
  const folders = codeWorkspaceFolders(open)
  await writeJsonAtomic(CODE_WORKSPACE_FILE, { folders })
  return { folders, warnings }
}
