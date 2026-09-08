/** Lazy character-level highlighting for paired removed and added diff rows.
 *  Self-contained port of the angry-turtle intraline renderer; the character
 *  diff is a bounded Myers/LCS over a single added+removed pair, so no external
 *  `diff` dependency is required for the plugin bundle. */
import type { ReviewDiffRow } from '../../../src/types.ts'

const MAX_INTRALINE_TEXT_CODE_UNITS = 20_000
const MAX_INTRALINE_DP_CELLS = 500_000

/** One visible fragment of a diff line. */
export interface IntralineSegment {
  text: string
  changed: boolean
}

/** Computes and caches character fragments only for rows requested by the renderer. */
export interface IntralineRenderer {
  segmentsFor: (rowIndex: number) => readonly IntralineSegment[] | undefined
}

/** Pair adjacent removed and added rows and prepare lazy character comparisons. */
export function createIntralineRenderer(rows: readonly ReviewDiffRow[]): IntralineRenderer {
  const pairs = pairChangedRows(rows)
  const cache = new Map<number, readonly IntralineSegment[] | undefined>()
  const resolved = new Set<number>()

  return {
    segmentsFor(rowIndex) {
      if (resolved.has(rowIndex)) return cache.get(rowIndex)
      const pairIndex = pairs.get(rowIndex)
      if (pairIndex === undefined) {
        resolved.add(rowIndex)
        return undefined
      }
      const row = rows[rowIndex]
      const pair = rows[pairIndex]
      if (row === undefined || pair === undefined || row.kind === 'hunk' || pair.kind === 'hunk') return undefined
      const oldIndex = row.kind === 'removed' ? rowIndex : pairIndex
      const newIndex = row.kind === 'added' ? rowIndex : pairIndex
      const oldRow = rows[oldIndex]
      const newRow = rows[newIndex]
      if (oldRow === undefined || newRow === undefined || oldRow.kind !== 'removed' || newRow.kind !== 'added') return undefined

      const comparison = compareCharacters(oldRow.text, newRow.text)
      resolved.add(oldIndex)
      resolved.add(newIndex)
      cache.set(oldIndex, comparison?.old)
      cache.set(newIndex, comparison?.new)
      return cache.get(rowIndex)
    },
  }
}

function pairChangedRows(rows: readonly ReviewDiffRow[]): ReadonlyMap<number, number> {
  const pairs = new Map<number, number>()
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row?.kind !== 'removed' && row?.kind !== 'added') {
      index += 1
      continue
    }
    const removed: number[] = []
    const added: number[] = []
    while (index < rows.length) {
      const changedRow = rows[index]
      if (changedRow?.kind === 'removed') removed.push(index)
      else if (changedRow?.kind === 'added') added.push(index)
      else break
      index += 1
    }
    const pairCount = Math.min(removed.length, added.length)
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const oldIndex = removed[pairIndex]
      const newIndex = added[pairIndex]
      if (oldIndex === undefined || newIndex === undefined) continue
      pairs.set(oldIndex, newIndex)
      pairs.set(newIndex, oldIndex)
    }
  }
  return pairs
}

function compareCharacters(oldText: string, newText: string): { old: readonly IntralineSegment[]; new: readonly IntralineSegment[] } | undefined {
  if (oldText === newText) return undefined
  if (oldText.length + newText.length > MAX_INTRALINE_TEXT_CODE_UNITS) return undefined
  if (oldText.length * newText.length > MAX_INTRALINE_DP_CELLS) return undefined
  const changes = tokenDiff(oldText, newText)
  if (changes === undefined) return undefined
  const sharedCharacters = changes.reduce((total, change) => total + (!change.added && !change.removed ? change.value.length : 0), 0)
  if (sharedCharacters * 4 < Math.max(oldText.length, newText.length)) return undefined

  const old: IntralineSegment[] = []
  const next: IntralineSegment[] = []
  for (const change of changes) {
    if (!change.added) old.push({ text: change.value, changed: change.removed === true })
    if (!change.removed) next.push({ text: change.value, changed: change.added === true })
  }
  return { old, new: next }
}

interface CharChange {
  value: string
  added?: boolean
  removed?: boolean
}

interface DiffToken {
  text: string
}

/** 按“词/记号”切分：标识符（含下划线/字母/数字/$）整块、空白整块、其余单字符。 */
function tokenizeLine(text: string): DiffToken[] {
  const tokens: DiffToken[] = []
  const pattern = /[A-Za-z0-9_$]+|\s+|./gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0] })
  }
  return tokens
}

/** VS Code 风格的行内 diff：token 级 LCS，变化以“整词”为高亮单位，而不是
 *  把一个词内部的每个字符都拆开。返回编辑段，或 undefined（整行近似重写）。 */
function tokenDiff(oldText: string, newText: string): CharChange[] | undefined {
  const oldTokens = tokenizeLine(oldText)
  const newTokens = tokenizeLine(newText)
  const n = oldTokens.length
  const m = newTokens.length
  const maxEdits = Math.min(1_024, n + m)
  const dp = new Int32Array((n + 1) * (m + 1))
  const column = m + 1
  for (let i = 1; i <= n; i += 1) dp[i * column] = 0
  for (let j = 1; j <= m; j += 1) dp[j] = 0
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i * column + j] = oldTokens[i - 1]!.text === newTokens[j - 1]!.text
        ? (dp[(i - 1) * column + (j - 1)] ?? 0) + 1
        : Math.max(dp[(i - 1) * column + j] ?? 0, dp[i * column + (j - 1)] ?? 0)
    }
  }
  const edits = (n + m) - 2 * (dp[n * column + m] ?? 0)
  if (edits > maxEdits) return undefined

  const changes: CharChange[] = []
  let i = n
  let j = m
  const emitGap = (oldFrom: number, oldTo: number, newFrom: number, newTo: number): void => {
    if (oldTo > oldFrom) {
      changes.push({ value: oldTokens.slice(oldFrom, oldTo).map(token => token.text).join(''), removed: true })
    }
    if (newTo > newFrom) {
      changes.push({ value: newTokens.slice(newFrom, newTo).map(token => token.text).join(''), added: true })
    }
  }
  let oldGapEnd = n
  let newGapEnd = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTokens[i - 1]!.text === newTokens[j - 1]!.text) {
      // 回溯到最近匹配 token：其后的空隙按“整词”输出删除/新增。
      emitGap(i, oldGapEnd, j, newGapEnd)
      changes.push({ value: oldTokens[i - 1]!.text })
      i -= 1
      j -= 1
      oldGapEnd = i
      newGapEnd = j
    } else if (j > 0 && (i === 0 || (dp[i * column + (j - 1)] ?? 0) >= (dp[(i - 1) * column + j] ?? 0))) {
      j -= 1
    } else {
      i -= 1
    }
  }
  emitGap(0, oldGapEnd, 0, newGapEnd)
  changes.reverse()
  return changes
}
