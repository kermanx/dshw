import { DSHW_ROOT } from './config.ts'
import type { DshwRepositoryStatus } from './types.ts'
import { messageOf, now, runOrThrow } from './util.ts'

export async function readDshwRepositoryStatus(fetchRemote: boolean): Promise<DshwRepositoryStatus> {
  const checkedAt = now()
  try {
    const upstream = (await runOrThrow(
      'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: DSHW_ROOT },
    )).stdout.trim()
    if (fetchRemote) {
      await runOrThrow('git', ['fetch', '--quiet'], { cwd: DSHW_ROOT, timeoutMs: 2 * 60 * 1000 })
    }
    const [divergence, status] = await Promise.all([
      runOrThrow('git', ['rev-list', '--count', `HEAD..${upstream}`], { cwd: DSHW_ROOT }),
      runOrThrow('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: DSHW_ROOT }),
    ])
    return {
      state: 'ready',
      checkedAt,
      behind: Number.parseInt(divergence.stdout.trim(), 10) || 0,
      dirty: status.stdout !== '',
      upstream,
    }
  } catch (error) {
    return {
      state: 'error',
      checkedAt,
      error: messageOf(error),
    }
  }
}
