/**
 * Parse `mr_review_result.json` into anchored review comments.
 *
 * Ported from dsh-dev-bench (`src/support/code-review/result.ts`), which ports
 * cc_bot's `review/result_parser.py` and `adapters/post/base.py`
 * (https://gitlab.deepseek.com/Ts2/cc_bot, synced at 7202626a, 2026-11-06).
 *
 * The cc_bot posting bot silently drops comments it cannot anchor; dshw keeps
 * them and marks `locationValid: false`, so the panel never hides a finding.
 * A structurally malformed document fails the whole review — a broken payload
 * must not read as a clean review.
 */
import type { AutoReviewComment } from '../types.ts'
import { validateReviewResult } from './validation.ts'

/** Undo Git's C-style octal quoting for non-ASCII paths. */
function gitPath(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const bytes: number[] = []
    const text = raw.slice(1, -1)
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '\\') {
        const octal = text.slice(index + 1).match(/^[0-7]{1,3}/u)?.[0]
        if (octal !== undefined) {
          bytes.push(Number.parseInt(octal, 8))
          index += octal.length
          continue
        }
        const escaped = text[++index] ?? ''
        const replacements: Record<string, string> = { t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07' }
        bytes.push(...Buffer.from(replacements[escaped] ?? escaped))
      } else {
        bytes.push(...Buffer.from(text[index]!))
      }
    }
    raw = Buffer.from(bytes).toString('utf8')
  }
  return raw.replace(/^[ab]\//u, '')
}

/** Line numbers each file's diff touches, per side. */
export function diffLineSets(patch: string): Map<string, { old: Set<number>, new: Set<number> }> {
  const files = new Map<string, { old: Set<number>, new: Set<number> }>()
  let oldPath = ''
  let newPath = ''
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  let lines = { old: new Set<number>(), new: new Set<number>() }
  for (const row of patch.split('\n')) {
    if (row.startsWith('diff --git ')) {
      oldPath = newPath = ''
      oldLeft = newLeft = 0
      lines = { old: new Set(), new: new Set() }
    } else if (oldLeft === 0 && newLeft === 0 && row.startsWith('--- ')) {
      oldPath = gitPath(row.slice(4))
      if (oldPath !== '/dev/null') files.set(oldPath, lines)
    } else if (oldLeft === 0 && newLeft === 0 && row.startsWith('+++ ')) {
      newPath = gitPath(row.slice(4))
      if (newPath !== '/dev/null') files.set(newPath, lines)
    } else if (row.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(row)
      if (match === null) continue
      oldLine = Number(match[1])
      oldLeft = Number(match[2] ?? 1)
      newLine = Number(match[3])
      newLeft = Number(match[4] ?? 1)
    } else if (oldLeft !== 0 || newLeft !== 0) {
      if ((row[0] === ' ' || row[0] === '-') && oldLeft > 0) {
        lines.old.add(oldLine++)
        oldLeft--
      }
      if ((row[0] === ' ' || row[0] === '+') && newLeft > 0) {
        lines.new.add(newLine++)
        newLeft--
      }
    }
  }
  return files
}

/** Validate and anchor one review result against the reviewed patch. */
export function parseCodeReview(raw: string, patch: string): { summary: string, comments: AutoReviewComment[] } {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u.exec(raw)
  const parsed: unknown = JSON.parse(fenced?.[1] ?? raw)
  validateReviewResult(parsed)
  const locations = diffLineSets(patch)
  const comments = parsed.comments.map((value): AutoReviewComment => {
    const hasLine = value.line !== undefined && value.line !== null
    const start = Number(hasLine ? value.line : value.line_start)
    const end = Number(hasLine ? value.line : value.line_end)
    const valid = locations.get(value.file)?.[value.line_type]
    const locationValid = valid !== undefined && end - start + 1 <= valid.size
      && [...valid].filter(line => line >= start && line <= end).length === end - start + 1
    return {
      file: value.file,
      ...(hasLine ? { line: start } : { lineStart: start, lineEnd: end }),
      lineType: value.line_type,
      severity: value.severity,
      message: value.message,
      fallbackLine: value.fallback_line ?? start,
      locationValid,
    }
  })
  return { summary: parsed.summary, comments }
}
