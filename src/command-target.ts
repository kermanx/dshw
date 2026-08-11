import { join } from 'node:path'
import { WORKSPACE_ROOT } from './config.ts'

export interface CommandTarget {
  cloneName: string | undefined
  cwd: string
}

export function resolveCommandTarget(
  argument: string | undefined,
  currentCwd = process.cwd(),
  workspaceRoot = WORKSPACE_ROOT,
): CommandTarget {
  if (argument === undefined || !/^\d+$/.test(argument)) {
    return { cloneName: argument, cwd: currentCwd }
  }

  const repositoryId = BigInt(argument)
  const directory = repositoryId === 0n ? 'deepseek-harness' : `deepseek-harness-${repositoryId}`
  return { cloneName: undefined, cwd: join(workspaceRoot, directory) }
}
