import { HARNESS_ROOT } from './config.ts'
import type { HarnessRepositoryStatus } from './types.ts'
import { messageOf, now, runOrThrow } from './util.ts'

export async function readHarnessRepositoryStatus(fetchRemote = false): Promise<HarnessRepositoryStatus> {
  const checkedAt = now()
  try {
    if (fetchRemote) {
      await runOrThrow('git', ['fetch', '--quiet'], { cwd: HARNESS_ROOT, timeoutMs: 2 * 60 * 1000 })
    }
    const [divergence, status] = await Promise.all([
      runOrThrow('git', ['rev-list', '--count', 'HEAD..refs/remotes/origin/master'], { cwd: HARNESS_ROOT }),
      runOrThrow('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: HARNESS_ROOT }),
    ])
    return {
      state: 'ready',
      checkedAt,
      behind: Number.parseInt(divergence.stdout.trim(), 10) || 0,
      dirty: status.stdout !== '',
    }
  } catch (error) {
    return {
      state: 'error',
      checkedAt,
      error: messageOf(error),
    }
  }
}
