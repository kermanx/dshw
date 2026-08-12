import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { validateCloneName } from '../src/clone.ts'
import { resolveCommandTarget } from '../src/command-target.ts'
import { addSharedWorktree, cloneGitStatus, commitOid, fetchBranch, fetchRemoteBranchTip, gitCommonDir, isDocumentationConflictPath, isInsideDirectory, mergeConflictPaths, removeSharedWorktree, repoSlugFromRemote } from '../src/git.ts'
import { rollupChecks, summarizeChecks } from '../src/github.ts'
import { CLONES_ROOT, DSHW_ROOT } from '../src/config.ts'
import { codeWorkspaceFolders } from '../src/workspace.ts'
import { run, runOrThrow } from '../src/util.ts'
import { resolveUiAssetPath } from '../src/ui-static.ts'
import { HARNESS_RECONFIGURE_STEPS, observeBaseTip, scheduleBaseCheck, summarizePrDashboardErrors } from '../src/service.ts'
import { pageJobs, readEventLogPage } from '../src/state.ts'
import { headlessDshArguments, missingTypertRuntimeArtifacts, parseDshOutcome, renderPromptTemplate, waitForDshWorker } from '../src/dsh.ts'
import { dshLaunchEnvironmentXml } from '../src/dsh-launch-env.ts'
import { formatProgressEvent } from '../src/dsh-progress-plugin.ts'
import { parseProgressOutput } from '../ui/src/progress-output.ts'
import type { DshWorkerHandle, EventRecord, JobRecord } from '../src/types.ts'
import { parseServiceOwner, renderServicePlist } from '../src/service-manager.ts'

test('forwards only endpoint variables that Harness requires at launch', () => {
  assert.equal(dshLaunchEnvironmentXml({
    DEEPSEEK_BASE_URL: 'https://chat.example.test?a=1&b=2',
    DEEPSEEK_SEARCH_BASE_URL: 'https://search.example.test',
    DEEPSEEK_API_KEY: 'must-not-enter-plist',
  }), [
    '<key>DEEPSEEK_BASE_URL</key><string>https://chat.example.test?a=1&amp;b=2</string>',
    '    <key>DEEPSEEK_SEARCH_BASE_URL</key><string>https://search.example.test</string>',
  ].join('\n'))
  assert.equal(dshLaunchEnvironmentXml({}), '')
})

test('finds declared Host TypeRT runtime artifacts that a fresh clone still needs to build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-typert-artifacts-'))
  try {
    const contributor = join(root, 'packages', 'feature', 'contributor')
    const ready = join(root, 'packages', 'feature', 'ready')
    await mkdir(join(contributor, 'lib'), { recursive: true })
    await mkdir(join(ready, 'src'), { recursive: true })
    await writeFile(join(contributor, 'package.json'), JSON.stringify({
      exports: { './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' } },
    }))
    await writeFile(join(ready, 'package.json'), JSON.stringify({ exports: { './typert': './src/typert.ts' } }))
    await writeFile(join(ready, 'src', 'typert.ts'), 'export const ready = true\n')
    assert.deepEqual(await missingTypertRuntimeArtifacts(root), [join(contributor, 'lib', 'typert.host.js')])
    await writeFile(join(contributor, 'lib', 'typert.host.js'), 'export const ready = true\n')
    assert.deepEqual(await missingTypertRuntimeArtifacts(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('defines the destructive main-repository reset as clean, pull, clean, and first-time setup', () => {
  assert.deepEqual(HARNESS_RECONFIGURE_STEPS.map(step => [step.command === process.execPath ? 'node' : step.command, ...step.args]), [
    ['git', 'clean', '-fdx'],
    ['git', 'pull', '--ff-only', 'origin', 'master'],
    ['git', 'clean', '-fdx'],
    ['pnpm', 'install', '--frozen-lockfile'],
    ['node', 'scripts/install-lefthook.mjs'],
    ['pnpm', 'run', 'typecheck'],
  ])
})

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

test('pages jobs from newest to oldest without overlaps', () => {
  const jobs: JobRecord[] = Array.from({ length: 80 }, (_, index) => ({
    id: `job-${index}`,
    type: 'fix-ci',
    status: 'succeeded',
    createdAt: new Date(index * 1_000).toISOString(),
    summary: `job ${index}`,
  }))
  const first = pageJobs(jobs, undefined, 35)
  assert.deepEqual(first.records.map(job => job.id), Array.from({ length: 35 }, (_, index) => `job-${79 - index}`))
  assert.equal(first.hasMore, true)
  const second = pageJobs(jobs, first.nextCursor, 35)
  assert.deepEqual(second.records.map(job => job.id), Array.from({ length: 35 }, (_, index) => `job-${44 - index}`))
  const third = pageJobs(jobs, second.nextCursor, 35)
  assert.deepEqual(third.records.map(job => job.id), Array.from({ length: 10 }, (_, index) => `job-${9 - index}`))
  assert.equal(third.hasMore, false)
})

test('reads append-only event logs backwards in pages of 35', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-event-log-'))
  const path = join(root, 'events.ndjson')
  try {
    const records: EventRecord[] = Array.from({ length: 80 }, (_, index) => ({
      id: `event-${index}`,
      time: new Date(index * 1_000).toISOString(),
      level: index % 3 === 0 ? 'error' : index % 2 === 0 ? 'warning' : 'info',
      kind: 'test',
      message: `日志 ${index}\n仍在同一条记录`,
    }))
    await writeFile(path, records.map(record => `${JSON.stringify(record)}\n`).join(''))
    const first = await readEventLogPage(path, undefined, 35)
    assert.deepEqual(first.records.map(record => record.id), Array.from({ length: 35 }, (_, index) => `event-${79 - index}`))
    assert.equal(first.hasMore, true)
    const second = await readEventLogPage(path, Number(first.nextCursor), 35)
    assert.deepEqual(second.records.map(record => record.id), Array.from({ length: 35 }, (_, index) => `event-${44 - index}`))
    const third = await readEventLogPage(path, Number(second.nextCursor), 35)
    assert.deepEqual(third.records.map(record => record.id), Array.from({ length: 10 }, (_, index) => `event-${9 - index}`))
    assert.equal(third.hasMore, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('summarizes local staged, unstaged, merging, ahead, and behind state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-local-status-'))
  try {
    await runOrThrow('git', ['init', '-b', 'main'], { cwd: root })
    await runOrThrow('git', ['config', 'user.name', 'dshw test'], { cwd: root })
    await runOrThrow('git', ['config', 'user.email', 'dshw@example.invalid'], { cwd: root })
    await writeFile(join(root, 'base.txt'), 'base\n')
    await runOrThrow('git', ['add', 'base.txt'], { cwd: root })
    await runOrThrow('git', ['commit', '-m', 'base'], { cwd: root })
    await runOrThrow('git', ['branch', 'remote'], { cwd: root })
    await runOrThrow('git', ['checkout', 'remote'], { cwd: root })
    await writeFile(join(root, 'remote.txt'), 'remote\n')
    await runOrThrow('git', ['add', 'remote.txt'], { cwd: root })
    await runOrThrow('git', ['commit', '-m', 'remote'], { cwd: root })
    const remoteHead = await commitOid(root, 'HEAD')
    await runOrThrow('git', ['checkout', 'main'], { cwd: root })
    await writeFile(join(root, 'local.txt'), 'local\n')
    await runOrThrow('git', ['add', 'local.txt'], { cwd: root })
    await runOrThrow('git', ['commit', '-m', 'local'], { cwd: root })
    await writeFile(join(root, 'staged.txt'), 'staged\n')
    await runOrThrow('git', ['add', 'staged.txt'], { cwd: root })
    await writeFile(join(root, 'unstaged.txt'), 'unstaged\n')

    assert.deepEqual(await cloneGitStatus(root, remoteHead), {
      unstaged: true,
      staged: true,
      merging: false,
      ahead: 1,
      behind: 1,
    })

    await runOrThrow('git', ['add', 'unstaged.txt'], { cwd: root })
    await runOrThrow('git', ['commit', '-m', 'local files'], { cwd: root })
    await runOrThrow('git', ['merge', '--no-commit', 'remote'], { cwd: root })
    assert.equal((await cloneGitStatus(root, remoteHead)).merging, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('only treats Markdown and translation pairing YAML as documentation conflicts', () => {
  for (const path of ['README.md', 'docs/guide.zh.md', 'docs/guide.i18n.yaml', 'docs/guide.i18n.yml']) {
    assert.equal(isDocumentationConflictPath(path), true)
  }
  for (const path of ['pnpm-lock.yaml', 'examples/app.cordis.yml', 'docs/config.yaml', 'docs/guide.mdx']) {
    assert.equal(isDocumentationConflictPath(path), false)
  }
})

test('finds merge conflicts without changing the worktree or index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-merge-tree-'))
  try {
    await runOrThrow('git', ['init', '-b', 'master'], { cwd: root })
    await runOrThrow('git', ['config', 'user.name', 'dshw test'], { cwd: root })
    await runOrThrow('git', ['config', 'user.email', 'dshw@example.invalid'], { cwd: root })
    await runOrThrow('git', ['config', 'merge.dsh-translation-pairing.driver', 'true'], { cwd: root })
    await writeFile(join(root, '.gitattributes'), '*.i18n.yaml merge=dsh-translation-pairing\n')
    await writeFile(join(root, 'README.md'), 'base\n')
    await writeFile(join(root, 'config.yaml'), 'value: base\n')
    await writeFile(join(root, 'pair.i18n.yaml'), 'value: base\n')
    await runOrThrow('git', ['add', '.'], { cwd: root })
    await runOrThrow('git', ['commit', '-m', 'base'], { cwd: root })
    await runOrThrow('git', ['branch', 'feature'], { cwd: root })

    await writeFile(join(root, 'README.md'), 'master\n')
    await writeFile(join(root, 'config.yaml'), 'value: master\n')
    await writeFile(join(root, 'pair.i18n.yaml'), 'value: master\n')
    await runOrThrow('git', ['commit', '-am', 'master changes'], { cwd: root })
    await runOrThrow('git', ['checkout', 'feature'], { cwd: root })
    await writeFile(join(root, 'README.md'), 'feature\n')
    await writeFile(join(root, 'config.yaml'), 'value: feature\n')
    await writeFile(join(root, 'pair.i18n.yaml'), 'value: feature\n')
    await runOrThrow('git', ['commit', '-am', 'feature changes'], { cwd: root })

    assert.deepEqual(await mergeConflictPaths(root, 'feature', 'master'), ['README.md', 'config.yaml', 'pair.i18n.yaml'])
    assert.equal((await runOrThrow('git', ['status', '--porcelain=v1'], { cwd: root })).stdout, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fetches a newer remote head before computing its merge conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-remote-head-'))
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const clone = join(root, 'clone')
  try {
    await mkdir(source)
    await runOrThrow('git', ['init', '--bare', remote])
    await runOrThrow('git', ['init', '-b', 'master'], { cwd: source })
    await runOrThrow('git', ['config', 'user.name', 'dshw test'], { cwd: source })
    await runOrThrow('git', ['config', 'user.email', 'dshw@example.invalid'], { cwd: source })
    await writeFile(join(source, 'file.txt'), 'base\n')
    await runOrThrow('git', ['add', 'file.txt'], { cwd: source })
    await runOrThrow('git', ['commit', '-m', 'base'], { cwd: source })
    await runOrThrow('git', ['branch', 'feature'], { cwd: source })
    await runOrThrow('git', ['remote', 'add', 'origin', remote], { cwd: source })
    await runOrThrow('git', ['push', 'origin', 'master', 'feature'], { cwd: source })
    await runOrThrow('git', ['clone', remote, clone])

    await writeFile(join(source, 'file.txt'), 'master\n')
    await runOrThrow('git', ['commit', '-am', 'master changes'], { cwd: source })
    await runOrThrow('git', ['push', 'origin', 'master'], { cwd: source })
    await runOrThrow('git', ['checkout', 'feature'], { cwd: source })
    await writeFile(join(source, 'file.txt'), 'feature\n')
    await runOrThrow('git', ['commit', '-am', 'feature changes'], { cwd: source })
    const headOid = await commitOid(source, 'HEAD')
    await runOrThrow('git', ['push', 'origin', 'feature'], { cwd: source })

    assert.notEqual((await run('git', ['cat-file', '-e', `${headOid}^{commit}`], { cwd: clone })).code, 0)
    await fetchBranch(clone, 'master')
    await fetchBranch(clone, 'feature')
    assert.deepEqual(await mergeConflictPaths(clone, headOid, 'origin/master'), ['file.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('computes conflicts against the latest target tip instead of the PR base snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-latest-target-'))
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const clone = join(root, 'clone')
  try {
    await mkdir(source)
    await runOrThrow('git', ['init', '--bare', remote])
    await runOrThrow('git', ['init', '-b', 'master'], { cwd: source })
    await runOrThrow('git', ['config', 'user.name', 'dshw test'], { cwd: source })
    await runOrThrow('git', ['config', 'user.email', 'dshw@example.invalid'], { cwd: source })
    await writeFile(join(source, 'file.txt'), 'base\n')
    await runOrThrow('git', ['add', 'file.txt'], { cwd: source })
    await runOrThrow('git', ['commit', '-m', 'base'], { cwd: source })
    const baseSnapshot = await commitOid(source, 'HEAD')
    await runOrThrow('git', ['branch', 'feature'], { cwd: source })
    await runOrThrow('git', ['remote', 'add', 'origin', remote], { cwd: source })
    await runOrThrow('git', ['push', 'origin', 'master', 'feature'], { cwd: source })
    await runOrThrow('git', ['clone', remote, clone])

    await runOrThrow('git', ['checkout', 'feature'], { cwd: source })
    await writeFile(join(source, 'file.txt'), 'feature\n')
    await runOrThrow('git', ['commit', '-am', 'feature changes'], { cwd: source })
    const headOid = await commitOid(source, 'HEAD')
    await runOrThrow('git', ['push', 'origin', 'feature'], { cwd: source })

    await runOrThrow('git', ['checkout', 'master'], { cwd: source })
    await writeFile(join(source, 'file.txt'), 'latest master\n')
    await runOrThrow('git', ['commit', '-am', 'master changes'], { cwd: source })
    const latestTarget = await commitOid(source, 'HEAD')
    await runOrThrow('git', ['push', 'origin', 'master'], { cwd: source })

    await fetchBranch(clone, 'feature')
    assert.deepEqual(await mergeConflictPaths(clone, headOid, baseSnapshot), [])
    assert.equal(await fetchRemoteBranchTip(clone, 'master'), latestTarget)
    assert.deepEqual(await mergeConflictPaths(clone, headOid, latestTarget), ['file.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reports the underlying merge-tree error when a commit is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-merge-tree-error-'))
  try {
    await runOrThrow('git', ['init', '-b', 'master'], { cwd: root })
    await runOrThrow('git', ['config', 'user.name', 'dshw test'], { cwd: root })
    await runOrThrow('git', ['config', 'user.email', 'dshw@example.invalid'], { cwd: root })
    await writeFile(join(root, 'file.txt'), 'base\n')
    await runOrThrow('git', ['add', 'file.txt'], { cwd: root })
    await runOrThrow('git', ['commit', '-m', 'base'], { cwd: root })

    await assert.rejects(
      mergeConflictPaths(root, '0000000000000000000000000000000000000000', 'master'),
      /not something we can merge|not a valid object/iu,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves the commit behind a git ref', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-commit-oid-'))
  try {
    await runOrThrow('git', ['init'], { cwd: root })
    await runOrThrow('git', ['config', 'user.email', 'dshw@example.com'], { cwd: root })
    await runOrThrow('git', ['config', 'user.name', 'dshw'], { cwd: root })
    await writeFile(join(root, 'file.txt'), 'base\n')
    await runOrThrow('git', ['add', 'file.txt'], { cwd: root })
    await runOrThrow('git', ['commit', '-m', 'base'], { cwd: root })
    assert.match(await commitOid(root, 'HEAD'), /^[0-9a-f]{40,64}$/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

test('caps repeated target push debounce at 30 minutes from the first push', () => {
  const sync = {} as Parameters<typeof scheduleBaseCheck>[0]
  const startedAt = Date.parse('2026-08-11T00:00:00.000Z')

  assert.equal(scheduleBaseCheck(sync, startedAt), '2026-08-11T00:10:00.000Z')
  assert.equal(sync.pendingBaseCheckStartedAt, '2026-08-11T00:00:00.000Z')
  assert.equal(scheduleBaseCheck(sync, startedAt + 9 * 60_000), '2026-08-11T00:19:00.000Z')
  assert.equal(scheduleBaseCheck(sync, startedAt + 25 * 60_000), '2026-08-11T00:30:00.000Z')
  assert.equal(scheduleBaseCheck(sync, startedAt + 35 * 60_000), '2026-08-11T00:30:00.000Z')
})

test('summarizes dashboard failures without duplicating or flooding the UI', () => {
  assert.equal(summarizePrDashboardErrors([]), 'PR 状态刷新失败，原因未知')
  assert.equal(summarizePrDashboardErrors(['  GitHub\n timed out  ', 'GitHub timed out']), 'GitHub timed out')
  assert.equal(
    summarizePrDashboardErrors(['GitHub timed out', 'git fetch failed']),
    '2 项刷新失败；GitHub timed out',
  )
  assert.equal(summarizePrDashboardErrors(['x'.repeat(400)]).length, 361)
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

test('groups live progress into lightweight display blocks', () => {
  assert.deepEqual(parseProgressOutput([
    '步骤 2 开始',
    'Agent：正在检查失败日志',
    '下一行说明',
    '调用工具 bash：{',
    '  "cmd": "pnpm test"',
    '}',
    '工具结果 完成：18 tests passed',
  ].join('\n')), [
    { kind: 'step', body: '步骤 2 开始', preview: '步骤 2 开始' },
    { kind: 'agent', title: 'Agent', body: '正在检查失败日志\n下一行说明', preview: '正在检查失败日志' },
    { kind: 'tool-call', title: 'bash', body: '{\n  "cmd": "pnpm test"\n}', preview: '"cmd": "pnpm test"' },
    { kind: 'tool-result', title: '完成', body: '18 tests passed', failed: false, preview: '18 tests passed' },
  ])
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

test('orders code workspace clones by PR number, then keeps dshw before worktrees', () => {
  const folders = codeWorkspaceFolders([
    { name: 'dsh-9', path: `${CLONES_ROOT}/dsh-9`, prNumber: 120 },
    { name: 'dsh-2', path: `${CLONES_ROOT}/dsh-2`, prNumber: 7 },
  ])
  assert.deepEqual(folders, [
    { name: 'PR_7', path: './worktrees/dsh-2' },
    { name: 'PR_120', path: './worktrees/dsh-9' },
    { name: 'dshw', path: './..' },
    { name: 'worktrees', path: './worktrees' },
  ])
})

test('embeds a verifiable installation owner in the service plist', () => {
  const installation = {
    version: 1 as const,
    id: 'installation-test-id',
    dshwRoot: DSHW_ROOT,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const plist = renderServicePlist(installation)
  assert.deepEqual(parseServiceOwner(plist), {
    version: 1,
    installationId: installation.id,
    dshwRoot: installation.dshwRoot,
    serviceLabel: process.env.DSHW_SERVICE_LABEL ?? 'com.deepseek-harness.dshw',
  })
  assert.equal(parseServiceOwner(plist.replace(/<!-- dshw-owner:[^>]+ -->/u, '')), undefined)
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
    assert.equal(await gitCommonDir(worktree), await gitCommonDir(managed))

    await removeSharedWorktree(managed, branch, worktree)
    await assert.rejects(readFile(join(worktree, '.git'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
