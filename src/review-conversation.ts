import type { WorkerRunRecord } from './types.ts'

export const REVIEW_READ_ONLY_REMINDER = '除非获得用户显式同意，否则不许修改代码和分支。'

export function isReviewConversation(kind: WorkerRunRecord['kind']): boolean {
  return kind === 'review'
}

export function renderReviewTurnPrompt(instruction: string): string {
  return `${instruction.trim()}\n\n${REVIEW_READ_ONLY_REMINDER}`
}
