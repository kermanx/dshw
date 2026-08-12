import { HARNESS_ROOT } from './config.ts'
import type { HarnessRepositoryStatus } from './types.ts'
import { messageOf, now, runOrThrow } from './util.ts'

export async function readHarnessRepositoryStatus(): Promise<HarnessRepositoryStatus> {
  const checkedAt = now()
  try {
    const result = await runOrThrow('git', ['rev-list', '--count', 'HEAD..refs/remotes/origin/master'], { cwd: HARNESS_ROOT })
    return {
      state: 'ready',
      checkedAt,
      behind: Number.parseInt(result.stdout.trim(), 10) || 0,
    }
  } catch (error) {
    return {
      state: 'error',
      checkedAt,
      error: messageOf(error),
    }
  }
}
