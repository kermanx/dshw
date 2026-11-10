import type { WorkerRunRecord } from './types.ts'

export const REVIEW_READ_ONLY_REMINDER = '除非获得用户显式同意，否则不许修改代码和分支。'

export function isReviewConversation(kind: WorkerRunRecord['kind']): boolean {
  return kind === 'review'
}

/**
 * Kinds whose session stays alive after a turn so the daemon can steer the next
 * one. The auto-review fix runs three turns (fix → scope audit → summary) in one
 * session and then explicitly completes it.
 */
export function keepsSessionAlive(kind: WorkerRunRecord['kind']): boolean {
  return kind === 'review' || kind === 'auto-review-fix'
}

export function renderReviewTurnPrompt(instruction: string): string {
  return `${instruction.trim()}\n\n${REVIEW_READ_ONLY_REMINDER}`
}
