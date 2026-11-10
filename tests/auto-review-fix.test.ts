import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, it } from 'node:test'
import { captureFixDiff, formatFixDiff, parseFixSummary } from '../src/auto-review-fix.ts'

const run = promisify(execFile)

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshw-fix-'))
  await run('git', ['-C', dir, 'init', '--quiet'])
  await run('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
  await run('git', ['-C', dir, 'config', 'user.name', 'test'])
  await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
  await run('git', ['-C', dir, 'add', '.'])
  await run('git', ['-C', dir, 'commit', '--quiet', '-m', 'init'])
  return dir
}

describe('fix working-tree capture', () => {
  it('returns undefined for a clean tree', async () => {
    const dir = await repo()
    try {
      assert.equal(await captureFixDiff(dir), undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('captures the uncommitted diff and counts lines', async () => {
    const dir = await repo()
    try {
      await writeFile(join(dir, 'a.ts'), 'export const a = 2\nexport const b = 3\n')
      await writeFile(join(dir, 'new.ts'), 'export const c = 1\n')
      const diff = await captureFixDiff(dir)
      assert.ok(diff !== undefined)
      assert.match(diff.patch, /-export const a = 1/u)
      assert.match(diff.patch, /\+export const a = 2/u)
      assert.equal(diff.additions, 2)
      assert.equal(diff.deletions, 1)
      assert.ok(diff.files.some(file => file.endsWith('a.ts')))
      assert.ok(diff.files.some(file => file.endsWith('new.ts')), 'untracked files are listed')
      assert.match(formatFixDiff(diff), /2 个文件 · \+2 −1/u)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('parses the summary turn output', () => {
    const parsed = parseFixSummary('SUMMARY: 修了浮点误差，并改了取整方式。\nNOTES:\n- 需要补一个边界测试\n- 改变了 p=1 的行为\nDSHW_RESULT: completed')
    assert.equal(parsed.summary, '修了浮点误差，并改了取整方式。')
    assert.deepEqual(parsed.notes, ['需要补一个边界测试', '改变了 p=1 的行为'])
  })

  it('treats an empty notes block as no notes', () => {
    const parsed = parseFixSummary('SUMMARY: 只改了注释。\nNOTES: 无\nDSHW_RESULT: completed')
    assert.equal(parsed.summary, '只改了注释。')
    assert.deepEqual(parsed.notes, [])
  })
})
