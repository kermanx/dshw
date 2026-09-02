import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, runOrThrow } from '../src/util.ts'
import { fingerprintOfRows, parseReviewDiff } from '../src/review-diff.ts'

test('parseReviewDiff: added / modified / deleted / renamed files', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/a.ts',
    '@@ -0,0 +1,2 @@',
    '+const a = 1',
    '+const b = 2',
    '',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 0000000..1111111 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,3 +1,3 @@',
    ' const x',
    '-const old = 1',
    '+const old = 2',
    ' const y',
    '',
    'diff --git a/src/c.ts b/src/c.ts',
    'deleted file mode 100644',
    '--- a/src/c.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-removed',
    '',
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 80%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -1 +1 @@',
    '-old content',
    '+new content',
  ].join('\n')
  const { files, payloads } = parseReviewDiff(diff)
  assert.equal(files.length, 4)
  assert.equal(files[0]?.status, 'added')
  assert.equal(files[0]?.path, 'src/a.ts')
  assert.equal(files[1]?.status, 'modified')
  assert.equal(files[1]?.path, 'src/b.ts')
  assert.equal(files[2]?.status, 'deleted')
  assert.equal(files[2]?.path, 'src/c.ts')
  assert.equal(files[3]?.status, 'renamed')
  assert.equal(files[3]?.path, 'src/new.ts')
  assert.equal(files[3]?.oldPath, 'src/old.ts')
  // payload row counts
  assert.equal(payloads[1]?.kind, 'text')
  const bRows = payloads[1]!
  // hunk header + context + removed + added + context
  assert.equal(bRows.rows.length, 5)
  assert.equal(bRows.additions, 1)
  assert.equal(bRows.deletions, 1)
  assert.equal(payloads[2]?.kind, 'text')
  assert.equal(payloads[3]?.kind, 'text')
})

test('parseReviewDiff: binary and empty-newname unavailable', () => {
  const diff = [
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/logo.png',
    'Binary files /dev/null and b/logo.png differ',
  ].join('\n')
  const { payloads } = parseReviewDiff(diff)
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0]?.kind, 'unavailable')
})

test('file fingerprints track changed-line content, ignoring context and line numbers', () => {
  const text = (oldStart: number, newStart: number, extraContext: string): string => [
    'diff --git a/src/b.ts b/src/b.ts',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    `@@ -${String(oldStart)},3 +${String(newStart)},3 @@`,
    extraContext,
    '-const old = 1',
    '+const old = 2',
  ].join('\n')
  const { files: first } = parseReviewDiff(text(1, 1, ' const x'))
  const { files: shifted } = parseReviewDiff(text(100, 120, ' const x'))
  const { files: changedContext } = parseReviewDiff(text(1, 1, ' const other'))
  const { files: changedLine } = parseReviewDiff(text(1, 1, ' const x').replace('+const old = 2', '+const old = 9'))
  assert.equal(first[0]?.fingerprint, shifted[0]?.fingerprint, 'absolute line shifts must not change the fingerprint')
  assert.equal(first[0]?.fingerprint, changedContext[0]?.fingerprint, 'context-only changes must not change the fingerprint')
  assert.notEqual(first[0]?.fingerprint, changedLine[0]?.fingerprint, 'a changed added line must change the fingerprint')
  assert.equal(first[0]?.fingerprint, fingerprintOfRows([{ kind: 'hunk', text: '@@ -1,3 +1,3 @@' }, { kind: 'removed', text: 'const old = 1', oldLine: 2 }, { kind: 'added', text: 'const old = 2', newLine: 2 }]))
})

test('git diff path: modified + added file in a throwaway repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-review-diff-'))
  try {
    await runOrThrow('git', ['init', '-q'], { cwd: root })
    await runOrThrow('git', ['config', 'user.email', 'test@test'], { cwd: root })
    await runOrThrow('git', ['config', 'user.name', 'test'], { cwd: root })
    await writeFile(join(root, 'base.txt'), 'a\nb\nc\n')
    await runOrThrow('git', ['add', '.'], { cwd: root })
    await runOrThrow('git', ['commit', '-qm', 'base'], { cwd: root })
    const base = (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()

    await writeFile(join(root, 'base.txt'), 'a\nB\nc\n')
    await writeFile(join(root, 'new.txt'), 'hello\nworld\n')
    await runOrThrow('git', ['add', '.'], { cwd: root })
    await runOrThrow('git', ['commit', '-qm', 'feat'], { cwd: root })
    const head = (await runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()

    const result = await run('git', ['diff', '--no-color', '--find-renames', '--unified=3', base, head, '--'], { cwd: root })
    assert.equal(result.code, 0)
    const { files, payloads } = parseReviewDiff(result.stdout)
    assert.equal(files.length, 2)
    const baseFile = files.find(file => file.path === 'base.txt')
    assert.equal(baseFile?.status, 'modified')
    const newFile = files.find(file => file.path === 'new.txt')
    assert.equal(newFile?.status, 'added')
    assert.equal(payloads.filter(p => p.kind === 'text').length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
