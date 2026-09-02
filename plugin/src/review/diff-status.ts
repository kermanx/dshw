/** Review diff status color/label helpers (VS Code Light palette). */
import type { ReviewDiffFile } from '../../../src/types.ts'
import { C_DANGER, C_SECONDARY, C_WARNING, C_ACCENT } from '../theme.ts'

export function statusLetter(status: ReviewDiffFile['status']): string {
  return status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : status === 'copied' ? 'C' : 'M'
}

export function statusLabel(status: ReviewDiffFile['status']): string {
  return status === 'added' ? '新增' : status === 'deleted' ? '删除' : status === 'renamed' ? '重命名' : status === 'copied' ? '复制' : '修改'
}

export function statusTone(status: ReviewDiffFile['status']): string {
  return status === 'added' ? C_ACCENT
    : status === 'deleted' ? C_DANGER
      : status === 'renamed' || status === 'copied' ? C_WARNING
        : C_SECONDARY
}
