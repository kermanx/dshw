import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packPages, pageKeyOf, rowHeightOf, isPageHidden, type FileRowGroup, type ReviewPage } from '../plugin/src/review/page-pack.ts'
import type { ReviewDiffFile, ReviewDiffRow } from '../src/types.ts'

function fileOf(index: number, path = `src/f${String(index)}.ts`): ReviewDiffFile {
  return { index, status: 'modified', path }
}

function rowsOf(prefix: string, count: number): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = []
  for (let index = 0; index < count; index += 1) {
    if (index % 5 === 0) rows.push({ kind: 'hunk', text: `@@ -${index},1 +${index},1 @@ ${prefix}` })
    rows.push(index % 3 === 0 ? { kind: 'context', text: `${prefix} c${String(index)}`, oldLine: index, newLine: index } : index % 2 === 0
      ? { kind: 'added', text: `${prefix} +${String(index)}`, newLine: index }
      : { kind: 'removed', text: `${prefix} -${String(index)}`, oldLine: index })
  }
  return rows
}

test('packPages: 行不重不漏、不跨文件、填满预算', () => {
  const groups: FileRowGroup[] = [
    { file: fileOf(0), rows: rowsOf('a', 30) },
    { file: fileOf(1), rows: rowsOf('b', 3) },
  ]
  const budget = 5 * 23 + 2 * 26 // 可以放的行数不确定，但每页必须 ≤ 预算
  const pages = packPages(groups, budget)
  assert.ok(pages.length >= 2)
  // 行 → 所属文件映射，校验页内不跨文件
  const fileOfRow = new Map<ReviewDiffRow, ReviewDiffFile>()
  for (const group of groups) for (const row of group.rows) fileOfRow.set(row, group.file)
  for (const page of pages) {
    assert.ok(page.height <= budget)
    assert.ok(page.rows.length > 0)
    for (const row of page.rows) assert.equal(fileOfRow.get(row), page.file)
  }
  // 全部行恰好出现一次，顺序保持
  const flattened = pages.flatMap(page => page.rows)
  const expected = groups.flatMap(group => group.rows)
  assert.equal(flattened.length, expected.length)
  flattened.forEach((row, index) => assert.equal(row, expected[index]))
})

test('packPages: ordinal/filePageTotal 每文件内连续编号', () => {
  const groups: FileRowGroup[] = [
    { file: fileOf(0), rows: rowsOf('a', 100) },
    { file: fileOf(1), rows: rowsOf('b', 1) },
  ]
  const pages = packPages(groups, 8 * 23)
  const perFile = new Map<number, ReviewPage[]>()
  for (const page of pages) {
    const bucket = perFile.get(page.file.index)
    if (bucket === undefined) perFile.set(page.file.index, [page])
    else bucket.push(page)
  }
  assert.equal(perFile.size, 2)
  for (const bucket of perFile.values()) {
    bucket.forEach((page, index) => {
      assert.equal(page.ordinal, index + 1)
      assert.equal(page.filePageTotal, bucket.length)
    })
  }
  // 空行组不产生页
  assert.equal(packPages([{ file: fileOf(2), rows: [] }], 100).length, 0)
})

test('packPages: 预算相同则打包稳定（键与切分可复现）', () => {
  const groups: FileRowGroup[] = [{ file: fileOf(0), rows: rowsOf('a', 41) }]
  const first = packPages(groups, 7 * 23 + 26)
  const second = packPages(groups, 7 * 23 + 26)
  assert.equal(first.length, second.length)
  first.forEach((page, index) => {
    assert.equal(page.key, second[index]!.key)
    assert.equal(page.rows.length, second[index]!.rows.length)
  })
})

test('pageKeyOf: 变更内容/路径不同则键不同，打包键只依赖变更行', () => {
  const file = fileOf(0)
  const base = rowsOf('a', 12)
  const key = pageKeyOf({ file, rows: base })
  assert.ok(key.startsWith('p'))
  // 相同的行 → 相同键（忽略 context 差异以外的部分）
  assert.equal(pageKeyOf({ file, rows: [...base] }), key)
  // 加了一行 → 键变化
  const extended: ReviewDiffRow[] = [...base, { kind: 'added', text: 'x', newLine: 99 }]
  assert.notEqual(pageKeyOf({ file, rows: extended }), key)
  // 只改 context 文本 → 键不变（键只对变更行敏感）
  const contextShifted: ReviewDiffRow[] = base.map(row => row.kind === 'context'
    ? { kind: 'context', text: `${row.text}?`, oldLine: row.oldLine, newLine: row.newLine }
    : row)
  assert.equal(pageKeyOf({ file, rows: contextShifted }), key)
  // 路径不同 → 键变化
  assert.notEqual(pageKeyOf({ file: fileOf(1), rows: base }), key)
})

test('rowHeightOf: hunk 与内容行高不同', () => {
  assert.equal(rowHeightOf({ kind: 'hunk', text: '@@ -1 +1 @@' }), 26)
  assert.equal(rowHeightOf({ kind: 'added', text: 'a', newLine: 1 }), 23)
  assert.equal(rowHeightOf(undefined), 0)
})

test('isPageHidden: 页面已读或整文件已读才算隐藏', () => {
  const page: ReviewPage = { key: 'pk1', file: fileOf(0), rows: [], height: 0, ordinal: 1, filePageTotal: 1 }
  assert.equal(isPageHidden(page, {}, new Set()), false)
  assert.equal(isPageHidden(page, { pk1: true }, new Set()), true)
  assert.equal(isPageHidden(page, {}, new Set(['src/f0.ts'])), true)
  assert.equal(isPageHidden(page, { other: true }, new Set(['src/other.ts'])), false)
})
