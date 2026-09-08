import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIntralineRenderer } from '../plugin/src/review/intraline.ts'
import type { ReviewDiffRow } from '../src/types.ts'

function rendererFor(oldText: string, newText: string): {
  added: ReturnType<typeof collect>
  removed: ReturnType<typeof collect>
  addedSegs?: unknown
} {
  const rows: ReviewDiffRow[] = [
    { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
    { kind: 'removed', text: oldText, oldLine: 1 },
    { kind: 'added', text: newText, newLine: 1 },
  ]
  const renderer = createIntralineRenderer(rows)
  return {
    added: collect(renderer.segmentsFor(2)),
    removed: collect(renderer.segmentsFor(1)),
  }
}

function collect(segments: readonly { text: string; changed: boolean }[] | undefined): { text: string; changed: string; plain: string } {
  if (segments === undefined) return { text: '', changed: '', plain: '' }
  return {
    text: segments.map(segment => segment.text).join(''),
    changed: segments.filter(segment => segment.changed).map(segment => segment.text).join(''),
    plain: segments.filter(segment => !segment.changed).map(segment => segment.text).join(''),
  }
}

test('intraline keeps the original character order', () => {
  const both = rendererFor('const old = 1', 'const old = 2')
  assert.equal(both.added.text, 'const old = 2')
  assert.equal(both.removed.text, 'const old = 1')
  assert.equal(both.added.changed, '2')
  assert.equal(both.removed.changed, '1')
})

test('intraline highlights changed words whole, not per character', () => {
  const swapped = rendererFor('this.field = mutableAttempt', 'this.field = attemptMutable')
  assert.equal(swapped.added.text, 'this.field = attemptMutable')
  assert.equal(swapped.removed.text, 'this.field = mutableAttempt')
  // 整词互换 → 两个整词各是一个高亮块，而不是字符碎片。
  assert.equal(swapped.added.changed, 'attemptMutable')
  assert.equal(swapped.removed.changed, 'mutableAttempt')
  assert.equal(swapped.added.plain, 'this.field = ')
  assert.equal(swapped.removed.plain, 'this.field = ')
})

test('intraline keeps partial-word edits as one whole word', () => {
  const partial = rendererFor('say abcXYZ end', 'say abcQW end')
  assert.equal(partial.added.text, 'say abcQW end')
  assert.equal(partial.removed.text, 'say abcXYZ end')
  assert.equal(partial.added.changed, 'abcQW')
  assert.equal(partial.removed.changed, 'abcXYZ')
  assert.equal(partial.added.plain, 'say  end')
})

test('intraline bails out on fully-rewritten lines (UI falls back to raw text)', () => {
  const both = rendererFor('a'.repeat(40), 'b'.repeat(40))
  assert.equal(both.added.text, '')
  assert.equal(both.removed.text, '')
})
