import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateCloneName } from '../src/clone.ts'
import { resolveCommandTarget } from '../src/command-target.ts'
import { addSharedWorktree, isInsideDirectory, removeSharedWorktree, repoSlugFromRemote } from '../src/git.ts'
import { rollupChecks, summarizeChecks } from '../src/github.ts'
import { CLONES_ROOT } from '../src/config.ts'
import { codeWorkspaceFolders } from '../src/workspace.ts'
import { run, runOrThrow } from '../src/util.ts'
import { resolveUiAssetPath } from '../src/ui-static.ts'
import { observeBaseTip } from '../src/service.ts'
import { headlessDshArguments, parseDshOutcome, renderPromptTemplate, waitForDshWorker } from '../src/dsh.ts'
import { formatProgressEvent } from '../src/dsh-progress-plugin.ts'
import type { DshWorkerHandle } from '../src/types.ts'

test('treats a numeric command argument as a workspace repository id', () => {
  const workspace = '/Users/example/workspace'
  assert.deepEqual(resolveCommandTarget(undefined, '/current', workspace), { cloneName: undefined, cwd: '/current' })
  assert.deepEqual(resolveCommandTarget('named', '/current', workspace), { cloneName: 'named', cwd: '/current' })
  assert.deepEqual(resolveCommandTarget('0', '/anywhere', workspace), {
    cloneName: undefined,
    cwd: '/Users/example/workspace/deepseek-harness',
  })
  assert.deepEqual(resolveCommandTarget('3', '/anywhere', workspace), {
    cloneName: undefined,
    cwd: '/Users/example/workspace/deepseek-harness-3',
  })
  assert.deepEqual(resolveCommandTarget('003', '/anywhere', workspace), {
    cloneName: undefined,
    cwd: '/Users/example/workspace/deepseek-harness-3',
  })
})

test('recognizes repositories inside the workflow clone directory', () => {
  const clones = '/Users/example/workspace/dsh-workflow/clones'
  assert.equal(isInsideDirectory('/Users/example/workspace/dsh-workflow/clones/alice', clones), true)
  assert.equal(isInsideDirectory('/Users/example/workspace/dsh-workflow/clones', clones), true)
  assert.equal(isInsideDirectory('/Users/example/workspace/deepseek-harness', clones), false)
  assert.equal(isInsideDirectory('/Users/example/workspace/dsh-workflow/clones-other/alice', clones), false)
})

test('parses common GitHub origin URL forms', () => {
  assert.equal(repoSlugFromRemote('https://github.com/deepseek-harness/deepseek-harness.git'), 'deepseek-harness/deepseek-harness')
  assert.equal(repoSlugFromRemote('git@github.com:deepseek-harness/deepseek-harness.git'), 'deepseek-harness/deepseek-harness')
  assert.equal(repoSlugFromRemote('ssh://git@github.com/deepseek-harness/deepseek-harness'), 'deepseek-harness/deepseek-harness')
  assert.throws(() => repoSlugFromRemote('https://example.com/a/b.git'), /无法从 origin/)
})

test('validates clone names before using them as directories', () => {
  for (const name of ['ci-fix', 'alice_2', 'pr.42']) assert.doesNotThrow(() => validateCloneName(name))
  for (const name of ['', '../escape', 'has space', '-leading', 'two..dots', 'trailing.', 'branch.lock']) {
    assert.throws(() => validateCloneName(name))
  }
})

test('waits for all CI checks before classifying a completed failure', () => {
  assert.deepEqual(summarizeChecks([]), { status: 'none', summary: '尚无 CI checks' })
  assert.equal(summarizeChecks([
    { name: 'lint', bucket: 'fail', state: 'FAILURE', workflow: 'ci', link: '' },
    { name: 'test', bucket: 'pending', state: 'IN_PROGRESS', workflow: 'ci', link: '' },
  ]).status, 'pending')
  assert.equal(summarizeChecks([
    { name: 'lint', bucket: 'fail', state: 'FAILURE', workflow: 'ci', link: '' },
    { name: 'test', bucket: 'pass', state: 'SUCCESS', workflow: 'ci', link: '' },
  ]).status, 'failed')
  assert.equal(summarizeChecks([
    { name: 'lint', bucket: 'pass', state: 'SUCCESS', workflow: 'ci', link: '' },
  ]).status, 'passed')
})

test('normalizes GitHub PR status rollups for the live dashboard', () => {
  assert.deepEqual(rollupChecks([
    { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'https://ci/test' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/lint' },
    { __typename: 'StatusContext', context: 'review-bot', state: 'FAILURE', targetUrl: 'https://ci/review' },
  ]), [
    { name: 'test', bucket: 'pending', state: 'IN_PROGRESS', workflow: '', link: 'https://ci/test' },
    { name: 'lint', bucket: 'pass', state: 'COMPLETED', workflow: '', link: 'https://ci/lint' },
    { name: 'review-bot', bucket: 'fail', state: 'FAILURE', workflow: '', link: 'https://ci/review' },
  ])
})

test('terminates a cancellable process group', async () => {
  const controller = new AbortController()
  const startedAt = Date.now()
  const resultPromise = run(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
    killProcessGroup: true,
  })
  setTimeout(() => controller.abort(), 50)
  const result = await resultPromise
  assert.equal(result.cancelled, true)
  assert.ok(Date.now() - startedAt < 5_000)
})

test('keeps production UI assets inside the built UI directory', () => {
  assert.match(resolveUiAssetPath('/') ?? '', /\/ui\/dist\/index\.html$/)
  assert.match(resolveUiAssetPath('/assets/app.js') ?? '', /\/ui\/dist\/assets\/app\.js$/)
  assert.equal(resolveUiAssetPath('/..%2f..%2fprivate.txt'), undefined)
})

test('renders editable dsh markdown prompt placeholders', () => {
  assert.equal(renderPromptTemplate('PR {{ prNumber }} at {{clonePath}}', {
    prNumber: '42',
    clonePath: '/tmp/clone',
  }), 'PR 42 at /tmp/clone')
  assert.throws(() => renderPromptTemplate('{{unknown}}', {}), /未知占位符/)
})

test('recognizes a machine-readable blocked dsh result and its reason', () => {
  assert.deepEqual(parseDshOutcome('无法安全解决\nDSHW_RESULT: blocked\nDSHW_REASON: 缺少上游生成文件'), {
    blocked: true,
    reason: '缺少上游生成文件',
  })
  assert.deepEqual(parseDshOutcome('完成\nDSHW_RESULT: completed'), { blocked: false })
})

test('uses the current Harness headless profile CLI contract', () => {
  assert.deepEqual(headlessDshArguments('/tmp/progress.patch.yml', 'fix the checks'), [
    '--profile', 'headless', '--patch', '/tmp/progress.patch.yml', 'fix the checks',
  ])
  assert.deepEqual(headlessDshArguments('/tmp/progress.patch.yml', 'fix the checks', true), [
    'run', '--profile', 'headless', '--patch', '/tmp/progress.patch.yml', 'fix the checks',
  ])
})

test('tracks target branch tips independently from a PR base snapshot', () => {
  const sync = {
    baseOid: 'pr-snapshot',
  } as Parameters<typeof observeBaseTip>[0]
  assert.equal(observeBaseTip(sync, 'remote-a'), 'initialized')
  assert.equal(sync.baseOid, 'pr-snapshot')
  assert.equal(sync.observedBaseOid, 'remote-a')
  assert.equal(observeBaseTip(sync, 'remote-a'), 'unchanged')
  assert.equal(observeBaseTip(sync, 'remote-b'), 'changed')
  assert.equal(sync.baseOid, 'pr-snapshot')
  assert.equal(sync.observedBaseOid, 'remote-b')
})

test('formats dsh session steps as plain-text progress', () => {
  assert.equal(formatProgressEvent({ type: 'step/start', data: { turn: 1, step: 2 } }), '步骤 2 开始')
  assert.equal(formatProgressEvent({
    type: 'tool/call',
    data: { name: 'bash', arguments: '{"cmd":"pnpm test"}' },
  }), '调用工具 bash：{\n  "cmd": "pnpm test"\n}')
  assert.equal(formatProgressEvent({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '正在检查失败日志' }] } },
  }), 'Agent：正在检查失败日志')
})

test('launchd dsh worker survives its launcher and persists a result', async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'dshw-worker-'))
  const bin = join(root, 'bin')
  const fakePnpm = join(bin, 'pnpm')
  const launcher = join(root, 'launcher.mjs')
  try {
    await mkdir(bin)
    await writeFile(fakePnpm, '#!/bin/sh\nprintf "FAKE_DSH_OK cwd=%s permission=%s\\n" "$PWD" "$DSH_PERMISSION_MODE"\n')
    await chmod(fakePnpm, 0o755)
    const sync = {
      id: 'sync-test', cloneName: 'test', clonePath: root, sourcePath: root,
      remoteUrl: 'https://github.com/deepseek-harness/deepseek-harness', repoSlug: 'deepseek-harness/deepseek-harness',
      prNumber: 42, prUrl: 'https://example.invalid/42', branch: 'feature/test', baseRefName: 'master',
      baseOid: 'base', headOid: 'head', status: 'active', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), nextPrRefreshAt: new Date().toISOString(),
    }
    const dshModule = new URL('../src/dsh.ts', import.meta.url).href
    await writeFile(launcher, `
const { startDshWorker } = await import(${JSON.stringify(dshModule)})
const handle = await startDshWorker(${JSON.stringify(sync)}, 'fix-ci')
console.log(JSON.stringify(handle))
`)
    const launched = await runOrThrow(process.execPath, [launcher], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DSHW_DATA_ROOT: join(root, 'data'),
        DSHW_PORT: '1',
        DSHW_DSH_EXECUTABLE: fakePnpm,
      },
    })
    const handle = JSON.parse(launched.stdout) as DshWorkerHandle
    const result = await waitForDshWorker(handle)
    assert.equal(result.status, 'succeeded')
    assert.match(result.finalOutput, /^FAKE_DSH_OK cwd=.*\/dshw-worker-[^ ]+ permission=danger-full-access$/)
    const log = await readFile(join(root, 'data', 'logs', `${handle.runId}.log`), 'utf8')
    assert.match(log, /FAKE_DSH_OK/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('cancels a launchd dsh worker through its persisted handle', async () => {
  if (process.platform !== 'darwin') return
  const root = await mkdtemp(join(tmpdir(), 'dshw-worker-cancel-'))
  const bin = join(root, 'bin')
  const fakePnpm = join(bin, 'pnpm')
  const launcher = join(root, 'launcher.mjs')
  const progressBodies: Array<Record<string, unknown>> = []
  const progressServer = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      progressBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      response.writeHead(204)
      response.end()
    })()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      progressServer.once('error', reject)
      progressServer.listen(0, '127.0.0.1', resolve)
    })
    const address = progressServer.address()
    if (address === null || typeof address === 'string') throw new Error('progress test server 没有 TCP port')
    await mkdir(bin)
    await writeFile(fakePnpm, '#!/bin/sh\nprintf "FAKE_PROGRESS\\n"\nsleep 30\nprintf "SHOULD_NOT_FINISH\\n"\n')
    await chmod(fakePnpm, 0o755)
    const sync = {
      id: 'sync-cancel', cloneName: 'test', clonePath: root, sourcePath: root,
      remoteUrl: 'https://github.com/deepseek-harness/deepseek-harness', repoSlug: 'deepseek-harness/deepseek-harness',
      prNumber: 43, prUrl: 'https://example.invalid/43', branch: 'feature/test', baseRefName: 'master',
      baseOid: 'base', headOid: 'head', status: 'active', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), nextPrRefreshAt: new Date().toISOString(),
    }
    const dshModule = new URL('../src/dsh.ts', import.meta.url).href
    await writeFile(launcher, `
const { startDshWorker } = await import(${JSON.stringify(dshModule)})
const handle = await startDshWorker(${JSON.stringify(sync)}, 'fix-ci')
console.log(JSON.stringify(handle))
`)
    const launched = await runOrThrow(process.execPath, [launcher], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        DSHW_DATA_ROOT: join(root, 'data'),
        DSHW_PORT: String(address.port),
        DSHW_DSH_EXECUTABLE: fakePnpm,
      },
    })
    const handle = JSON.parse(launched.stdout) as DshWorkerHandle
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (progressBodies.some(body => String(body.line).includes('FAKE_PROGRESS'))) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(progressBodies.some(body => String(body.line).includes('FAKE_PROGRESS')))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)
    const result = await waitForDshWorker(handle, controller.signal)
    assert.equal(result.status, 'cancelled')
    assert.doesNotMatch(result.finalOutput, /SHOULD_NOT_FINISH/)
  } finally {
    await new Promise<void>(resolve => progressServer.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('orders code workspace clones by PR number, then keeps dshw before clones', () => {
  const folders = codeWorkspaceFolders([
    { name: 'dsh-9', path: `${CLONES_ROOT}/dsh-9`, prNumber: 120 },
    { name: 'dsh-2', path: `${CLONES_ROOT}/dsh-2`, prNumber: 7 },
  ])
  assert.deepEqual(folders, [
    { name: 'PR_7', path: './clones/dsh-2' },
    { name: 'PR_120', path: './clones/dsh-9' },
    { name: 'dshw', path: './dshw' },
    { name: 'clones', path: './clones' },
  ])
})

test('creates worktrees with a unique local branch tracking the PR branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-worktree-'))
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const managed = join(root, 'managed')
  const worktree = join(root, 'worktree')
  try {
    await runOrThrow('git', ['init', '--bare', remote])
    await mkdir(source)
    await runOrThrow('git', ['init', '-b', 'master'], { cwd: source })
    await runOrThrow('git', ['config', 'user.name', 'dshw test'], { cwd: source })
    await runOrThrow('git', ['config', 'user.email', 'dshw@example.invalid'], { cwd: source })
    await writeFile(join(source, 'README.md'), 'test\n')
    await runOrThrow('git', ['add', 'README.md'], { cwd: source })
    await runOrThrow('git', ['commit', '-m', 'initial'], { cwd: source })
    await runOrThrow('git', ['branch', 'feature/test'], { cwd: source })
    await runOrThrow('git', ['remote', 'add', 'origin', remote], { cwd: source })
    await runOrThrow('git', ['push', 'origin', 'master', 'feature/test'], { cwd: source })
    await runOrThrow('git', ['clone', remote, managed])

    const branch = await addSharedWorktree(managed, 'feature/test', 'dsh-1', worktree)
    assert.equal(branch, 'dshw/dsh-1')
    assert.match(await readFile(join(worktree, '.git'), 'utf8'), /^gitdir: /)
    assert.equal((await runOrThrow('git', ['branch', '--show-current'], { cwd: worktree })).stdout.trim(), 'dshw/dsh-1')
    assert.equal((await runOrThrow('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: worktree })).stdout.trim(), 'origin/feature/test')
    assert.equal((await runOrThrow('git', ['config', '--worktree', 'push.default'], { cwd: worktree })).stdout.trim(), 'upstream')

    await removeSharedWorktree(managed, branch, worktree)
    await assert.rejects(readFile(join(worktree, '.git'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
