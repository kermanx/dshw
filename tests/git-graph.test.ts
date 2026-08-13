import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseGitGraphLog, readGitGraph } from '../src/git-graph.ts'
import type { PrDashboardRecord } from '../src/types.ts'

const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const parent = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('parses real commit parents and attaches branch refs to their exact tips', () => {
  const output = [
    `${head}\x00${parent}\x00Alice\x00alice@example.test\x001700000000\x00PR head\x00Body\n\x1e`,
    `\n${parent}\x00\x00Bob\x00bob@example.test\x001699999000\x00Base commit\x00\x1e`,
    '\n',
  ].join('')

  assert.deepEqual(parseGitGraphLog(output, [
    { name: 'master', oid: parent },
    { name: 'PR #42 · feature/tree', oid: head },
  ]), [
    {
      hash: head,
      parents: [parent],
      subject: 'PR head',
      body: 'Body',
      author: { name: 'Alice', email: 'alice@example.test', timestamp: 1_700_000_000_000 },
      refs: ['PR #42 · feature/tree'],
    },
    {
      hash: parent,
      parents: [],
      subject: 'Base commit',
      body: '',
      author: { name: 'Bob', email: 'bob@example.test', timestamp: 1_699_999_000_000 },
      refs: ['master'],
    },
  ])
})

test('rejects malformed git log records before passing them to the renderer', () => {
  assert.throws(() => parseGitGraphLog('not-a-hash\x00\x00\x00\x00\x000\x00bad\x00\x1e', []), /无效 commit hash/u)
})

test('keeps the master first-parent chain continuous back to an open PR merge base', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshw-git-graph-'))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const commit = (name: string): string => {
    writeFileSync(join(root, 'history.txt'), `${name}\n`, { flag: 'a' })
    git('add', 'history.txt')
    git('commit', '-m', name)
    return git('rev-parse', 'HEAD')
  }
  try {
    git('init', '-b', 'master')
    git('config', 'user.name', 'Graph Test')
    git('config', 'user.email', 'graph@example.test')
    const base = commit('base')
    const masterOne = commit('master one')
    const masterTwo = commit('master two')
    git('checkout', '-b', 'feature', base)
    const feature = commit('feature')
    git('checkout', 'master')

    const snapshot = await readGitGraph(root, [{
      repoSlug: 'example/repo',
      branch: 'feature',
      number: 42,
      title: 'Feature',
      url: 'https://example.test/pr/42',
      isDraft: false,
      headOid: feature,
    } as PrDashboardRecord], 20)
    const visible = new Set(snapshot.commits.map(item => item.hash))
    assert.equal(snapshot.branches[0]?.kind, 'master')
    assert.equal(snapshot.branches[0]?.oid, masterTwo)
    assert.ok(visible.has(masterOne))
    assert.ok(visible.has(base))
    assert.ok(visible.has(feature))
    for (const item of snapshot.commits) {
      for (const parent of item.parents) assert.ok(visible.has(parent), `${item.hash} 的 parent ${parent} 不应被截断`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
