/**
 * Review result validation, ported from dsh-dev-bench
 * (`src/support/code-review/validation.ts`) and ultimately from
 * https://gitlab.deepseek.com/Ts2/cc_bot (`config/pi/extensions/git-only-bash.ts`,
 * synced at 7202626a, 2026-11-06).
 *
 * The same function runs in two places: this module validates whatever the
 * model wrote before dshw stores it, and the Pi extension embeds a stripped
 * copy so an invalid file is rejected before the agent can finish. Keep this
 * module dependency-free — it is inlined into the extension source.
 */

/** One comment exactly as the model is asked to write it. */
export interface ReviewCommentData {
  file: string
  message: string
  severity: 'critical' | 'warning' | 'suggestion'
  line_type: 'old' | 'new'
  line?: number | null
  line_start?: number | null
  line_end?: number | null
  fallback_line?: number
  reply_to_thread_id?: unknown
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Assert that `parsed` is a valid `mr_review_result.json` document. */
export function validateReviewResult(parsed: unknown): asserts parsed is { summary: string, comments: ReviewCommentData[] } {
  if (!object(parsed) || typeof parsed.summary !== 'string' || !Array.isArray(parsed.comments)) {
    throw new Error('Review result requires a string summary and a comments array.')
  }
  parsed.comments.forEach((value: unknown, index: number) => {
    function invalid(reason: string): never {
      throw new Error(`comments[${index}]: ${reason}`)
    }
    if (!object(value)) invalid('expected an object')
    if (typeof value.file !== 'string' || !value.file.trim() || value.file.startsWith('/')
      || value.file.split('/').includes('..') || /[\0\\]/u.test(value.file)) invalid('invalid relative file path')
    if (typeof value.message !== 'string' || !value.message.trim()) invalid('message is required')
    if (!['critical', 'warning', 'suggestion'].includes(String(value.severity))) {
      // Upstream guardrail (cc_bot 5aa0dfb2): comments are for action items, so
      // a verification note without a severity must move to the summary.
      invalid('severity must be critical/warning/suggestion; comments are for issues the author must act on. '
        + 'If this is only a verification note (e.g. “已删除” “无残留” “清理完整”), remove it from comments and put it in summary')
    }
    if (value.line_type !== 'old' && value.line_type !== 'new') invalid('line_type must be old or new')
    const hasLine = value.line !== undefined && value.line !== null
    const hasRange = (value.line_start !== undefined && value.line_start !== null)
      || (value.line_end !== undefined && value.line_end !== null)
    if (hasLine === hasRange) invalid('use either line or line_start/line_end')
    if (hasLine && !positiveInteger(value.line)) invalid('invalid line')
    if (hasRange && (!positiveInteger(value.line_start) || !positiveInteger(value.line_end)
      || value.line_end < value.line_start)) invalid('invalid line range')
    if (value.fallback_line !== undefined && !positiveInteger(value.fallback_line)) invalid('invalid fallback_line')
  })
}
