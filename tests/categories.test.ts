import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_ORDER, categoryOfPath, compareTreePaths, orderFilesByCategory, type ReviewCategoryId } from '../plugin/src/review/categories.ts'

test('categories: classifies common paths', () => {
  const cases: Array<[string, ReviewCategoryId]> = [
    ['src/session.ts', 'source'],
    ['apps/web/src/App.tsx', 'source'],
    ['src/util.test.ts', 'tests'],
    ['tests/core.test.ts', 'tests'],
    ['packages/scan/src/scanner.spec.ts', 'tests'],
    ['docs/interface.md', 'docs'],
    ['README.md', 'docs'],
    ['package.json', 'config'],
    ['tsconfig.json', 'config'],
    ['cordis.patch.yml', 'config'],
    ['.agents/notes/a.md', 'other'],
    ['assets/logo.png', 'other'],
  ]
  for (const [path, expected] of cases) {
    assert.equal(categoryOfPath(path), expected, path)
  }
})

test('categories: display order puts source before tests/docs/config/other', () => {
  const ordered = orderFilesByCategory([
    { path: '.agents/notes/n.md' },
    { path: 'package.json' },
    { path: 'docs/guide.md' },
    { path: 'src/x.test.ts' },
    { path: 'src/impl.ts' },
  ])
  assert.deepEqual(
    ordered.map(file => file.path),
    ['src/impl.ts', 'src/x.test.ts', 'docs/guide.md', 'package.json', '.agents/notes/n.md'],
  )
  assert.deepEqual(CATEGORY_ORDER, ['source', 'tests', 'docs', 'config', 'other'])
})

test('tree order: directory comes before sibling files sharing its prefix', () => {
  const sorted = orderFilesByCategory([{ path: 'x.txt' }, { path: 'x/sub.txt' }, { path: 'y.txt' }])
  assert.deepEqual(sorted.map(file => file.path), ['x/sub.txt', 'x.txt', 'y.txt'])
  assert.ok(compareTreePaths('x/sub.txt', 'x.txt') < 0, 'ancestor dir sorts before its sibling file')
})
