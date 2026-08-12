import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { removeCloneRecord, validateCloneName } from '../src/clone.ts'
import { resolveCommandTarget } from '../src/command-target.ts'
import { addSharedWorktree, cloneGitStatus, commitOid, fetchBranch, fetchRemoteBranchTip, gitCommonDir, isDocumentationConflictPath, isInsideDirectory, mergeConflictPaths, repoSlugFromRemote } from '../src/git.ts'
import { assessCiAutoFix, ciLaneKey, rollupChecks, selectCiAutoFixChecks, summarizeChecks } from '../src/github.ts'
import { AGENT_STEER_INTERVAL_MS, CLONES_ROOT, DSHW_ROOT } from '../src/config.ts'
import { codeWorkspaceFolders } from '../src/workspace.ts'
import { run, runOrThrow } from '../src/util.ts'
import { resolveUiAssetPath } from '../src/ui-static.ts'
import { DSHW_UPDATE_STEPS, HARNESS_RECONFIGURE_STEPS, observeBaseTip, readOutputPage, scheduleBaseCheck, summarizePrDashboardErrors, worktreeNeedsCleanupDecision } from '../src/service.ts'
import { pageJobs, readEventLogPage } from '../src/state.ts'
import { appendAdditionalInstruction, cancelDshWorker, dshWorkerLaunchSpec, headlessDshArguments, inspectDshWorker, missingTypertRuntimeArtifacts, parseDshOutcome, renderPeriodicAgentReminder, renderPromptTemplate, steerDshWorker } from '../src/dsh.ts'
import { dshLaunchEnvironmentXml, dshWorkerLaunchEnvironmentXml } from '../src/dsh-launch-env.ts'
import { formatProgressEvent } from '../src/dsh-progress-plugin.ts'
import { mergeProgressOutput, parseProgressOutput } from '../ui/src/progress-output.ts'
import type { DshWorkerHandle, EventRecord, JobRecord, SyncRecord } from '../src/types.ts'
import { parseServiceOwner, renderServicePlist } from '../src/service-manager.ts'
import { WorkerConfigStore } from '../src/worker-config.ts'
import { codexModelCatalogFrom, findCodexExecutable } from '../src/codex-runtime.ts'
import { codexThreadStartParams, codexTurnStartParams, formatCodexThreadItem } from '../src/codex-session-worker.ts'
import { dshModelCatalog } from '../src/worker-driver.ts'
import { jobExecutor } from '../ui/src/format.ts'

test('forwards the Harness credential and endpoint launch variables', () => {
  assert.equal(dshLaunchEnvironmentXml({
    DEEPSEEK_API_KEY: 'secret',
    DEEPSEEK_BASE_URL: 'https://chat.example.test?a=1&b=2',
    DEEPSEEK_SEARCH_BASE_URL: 'https://search.example.test',
  }), [
    '<key>DEEPSEEK_API_KEY</key><string>secret</string>',
    '    <key>DEEPSEEK_BASE_URL</key><string>https://chat.example.test?a=1&amp;b=2</string>',
    '    <key>DEEPSEEK_SEARCH_BASE_URL</key><string>https://search.example.test</string>',
  ].join('\n'))
  assert.equal(dshLaunchEnvironmentXml({}), '')
})

test('uses the standard Harness user .env as a worker fallback without overriding launch env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-user-env-'))
  const filename = join(root, '.env')
  try {
    await writeFile(filename, [
      'DEEPSEEK_API_KEY=file-key',
      'DEEPSEEK_BASE_URL=https://file.example.test',
      '',
    ].join('\n'))
    assert.equal(dshWorkerLaunchEnvironmentXml({
      DEEPSEEK_API_KEY: 'launch-key',
    }, filename), [
      '<key>DEEPSEEK_API_KEY</key><string>launch-key</string>',
      '    <key>DEEPSEEK_BASE_URL</key><string>https://file.example.test</string>',
    ].join('\n'))
    assert.equal(dshWorkerLaunchEnvironmentXml({}, filename, {
      DEEPSEEK_BASE_URL: 'https://worker.example.test/v1',
      DEEPSEEK_SEARCH_BASE_URL: 'https://worker-search.example.test',
    }), [
      '<key>DEEPSEEK_API_KEY</key><string>file-key</string>',
      '    <key>DEEPSEEK_BASE_URL</key><string>https://worker.example.test/v1</string>',
      '    <key>DEEPSEEK_SEARCH_BASE_URL</key><string>https://worker-search.example.test</string>',
    ].join('\n'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stores multiple worker configs separately from owner-only API keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-worker-config-'))
  const configFile = join(root, 'workers.json')
  const secretFile = join(root, 'worker-secrets.env')
  try {
    const store = await WorkerConfigStore.open({ configFile, secretFile, userEnvFile: join(root, 'missing.env') })
    assert.equal(store.list().length, 1)
    const codex = await store.create({ name: 'Local Codex', type: 'codex', enabled: true, model: 'gpt-5', reasoningEffort: 'high' })
    assert.equal(codex.enabled, true)
    assert.equal(codex.hasApiKey, true)
    assert.equal(codex.credentialSource, 'local')
    assert.equal(store.executionConfig(codex.id).reasoningEffort, 'high')
    assert.doesNotMatch(await readFile(configFile, 'utf8'), /secret-value/u)
    assert.equal((await stat(secretFile)).mode & 0o777, 0o600)
    const dsh = store.list().find(config => config.type === 'dsh')!
    const secondDsh = await store.create({ name: 'Second dsh', type: 'dsh', enabled: true, apiKeyMode: 'environment', apiKeyEnv: 'DEEPSEEK_API_KEY' })
    await store.update(secondDsh.id, {
      ...secondDsh,
      baseUrl: 'https://api.example.test/v1',
      searchBaseUrl: 'https://search.example.test',
    })
    await store.reorder([secondDsh.id, dsh.id, codex.id])
    assert.deepEqual(store.list().map(config => config.id), [secondDsh.id, dsh.id, codex.id])
    assert.equal(store.list()[0]?.isDefault, true)
    assert.equal(store.executionConfig().name, 'Second dsh')
    assert.equal(store.executionConfig().baseUrl, 'https://api.example.test/v1')
    assert.equal(store.executionConfig().searchBaseUrl, 'https://search.example.test')
    await store.update(dsh.id, { ...dsh, name: 'Primary dsh', apiKeyMode: 'value', apiKey: 'dsh-secret' })
    assert.match(await readFile(secretFile, 'utf8'), /dsh-secret/u)
    assert.equal(store.executionConfig().name, 'Second dsh')
    await store.reorder([dsh.id, codex.id, secondDsh.id])
    assert.equal(store.executionConfig().apiKey, 'dsh-secret')
    assert.equal(store.executionConfig(codex.id).name, 'Local Codex')
    assert.equal(store.list().find(config => config.id === dsh.id)?.credentialSource, 'saved')
    await assert.rejects(store.reorder([dsh.id, codex.id]), /排序列表无效/u)
    await store.remove(codex.id)
    assert.equal(store.list().length, 2)
    const reopened = await WorkerConfigStore.open({ configFile, secretFile, userEnvFile: join(root, 'missing.env') })
    assert.deepEqual(reopened.list().map(config => config.id), [dsh.id, secondDsh.id])
    assert.equal(reopened.list()[0]?.isDefault, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('finds an executable Codex CLI on PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-codex-path-'))
  const executable = join(root, 'codex')
  try {
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    assert.equal(await findCodexExecutable(root), executable)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('configures ephemeral Codex threads and formats native items', () => {
  assert.deepEqual(codexThreadStartParams({
    sync: { clonePath: '/repo' } as never,
    worker: { model: 'gpt-5.4' },
  }), {
    cwd: '/repo',
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    serviceName: 'dshw',
    model: 'gpt-5.4',
  })
  assert.deepEqual(formatCodexThreadItem({
    type: 'commandExecution', command: 'pnpm test', status: 'completed', exitCode: 0, aggregatedOutput: '37 passed',
  }), [
    '调用工具 exec_command：pnpm test',
    '工具结果 完成：37 passed',
  ])
  assert.deepEqual(formatCodexThreadItem({ type: 'agentMessage', text: '完成。' }), ['Agent：完成。'])
  assert.deepEqual(formatCodexThreadItem({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: '先检查失败测试' }],
    content: [],
  }), ['思考：先检查失败测试'])
  assert.deepEqual(codexTurnStartParams('thread-1', '继续', { model: 'gpt-5.4', reasoningEffort: 'xhigh' }), {
    threadId: 'thread-1',
    input: [{ type: 'text', text: '继续' }],
    effort: 'xhigh',
  })
})

test('normalizes native Worker model and reasoning catalogs', () => {
  assert.deepEqual(codexModelCatalogFrom({ config: { model: 'gpt-current', model_reasoning_effort: 'high' } }, [{
    id: 'gpt-current',
    model: 'gpt-current',
    displayName: 'GPT Current',
    description: 'Current model',
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'More reasoning' },
    ],
  }]), {
    type: 'codex',
    defaultModel: 'gpt-current',
    defaultReasoningEffort: 'high',
    models: [{
      id: 'gpt-current',
      name: 'GPT Current',
      description: 'Current model',
      reasoningEfforts: [
        { id: 'medium', name: 'medium', description: 'Balanced' },
        { id: 'high', name: 'high', description: 'More reasoning' },
      ],
      defaultReasoningEffort: 'medium',
    }],
  })
  const dsh = dshModelCatalog('deepseek-official')
  assert.deepEqual(dsh.models.map(model => model.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.deepEqual(dsh.models[0]?.reasoningEfforts.map(effort => effort.id), ['off', 'high', 'max'])
})

test('launches dsh workers from the pinned runtime without a target-worktree tsx hook', () => {
  assert.deepEqual(dshWorkerLaunchSpec('/runtime', '/worker/patch.yml', '/node'), {
    workingDirectory: '/runtime',
    programArguments: [
      '/node',
      '/runtime/apps/cli/lib/bin.js',
      '--profile', 'headless', '--patch', '/worker/patch.yml',
    ],
  })
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

test('updates dshw with a fast-forward pull before installing, checking, and rebuilding', () => {
  assert.deepEqual(DSHW_UPDATE_STEPS.map(step => [step.command, ...step.args]), [
    ['git', 'pull', '--ff-only'],
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', 'run', 'typecheck'],
    ['pnpm', 'run', 'build:ui'],
  ])
})

test('requires an explicit cleanup decision for local worktree content', () => {
  assert.equal(worktreeNeedsCleanupDecision({ staged: false, unstaged: false, merging: false, ahead: 0, behind: 3 }), false)
  assert.equal(worktreeNeedsCleanupDecision({ staged: true, unstaged: false, merging: false, ahead: 0, behind: 0 }), true)
  assert.equal(worktreeNeedsCleanupDecision({ staged: false, unstaged: true, merging: false, ahead: 0, behind: 0 }), true)
  assert.equal(worktreeNeedsCleanupDecision({ staged: false, unstaged: false, merging: false, ahead: 1, behind: 0 }), true)
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

test('labels job executors with the selected Worker name and legacy fallbacks', () => {
  const job: JobRecord = {
    id: 'job-executor',
    type: 'fix-ci',
    status: 'succeeded',
    createdAt: new Date(0).toISOString(),
    summary: 'test',
  }
  assert.equal(jobExecutor({ ...job, executor: 'Local Codex' }), 'Local Codex')
  assert.equal(jobExecutor(job), '内置')
  assert.equal(jobExecutor({
    ...job,
    dshWorker: { handle: { workerType: 'codex' } } as JobRecord['dshWorker'],
  }), 'Codex')
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

test('reads durable worker output backwards without dropping earlier lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-output-page-'))
  const path = join(root, 'output.log')
  const expected = Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行 output`).join('\n')
  try {
    await writeFile(path, `${expected}\n`)
    const pages: string[] = []
    let before: number | undefined
    do {
      const page = await readOutputPage(path, before, 48)
      pages.unshift(page.output)
      before = page.nextBefore
      if (!page.hasMore) break
    } while (before !== undefined)
    assert.equal(pages.filter(Boolean).join('\n'), expected)
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

test('does not auto-fix checks from the same failing base CI lane', () => {
  const check = (name: string, bucket: string, workflow: string) => ({ name, bucket, workflow, state: '', link: '' })
  assert.equal(
    ciLaneKey('CI', 'windows node 24 / native complete'),
    ciLaneKey('CI', 'serial / windows (self-hosted standby)'),
  )
  assert.deepEqual(selectCiAutoFixChecks([
    check('lint', 'fail', 'CI'),
  ], [{ name: 'lint', workflow: 'CI' }]).actionableChecks, [])
  assert.deepEqual(selectCiAutoFixChecks([
    check('lint', 'fail', 'CI'),
    check('test', 'fail', 'Tests'),
    check('external', 'fail', ''),
    check('still running', 'pending', 'CI'),
  ], [{ name: 'lint', workflow: 'CI' }]), {
    actionableChecks: [
      check('test', 'fail', 'Tests'),
      check('external', 'fail', ''),
    ],
    failingBaseChecks: [{ name: 'lint', workflow: 'CI' }],
  })
})

test('matches alternate Windows lane names without suppressing unrelated CI jobs', async () => {
  const check = (name: string) => ({ name, bucket: 'fail', workflow: 'CI', state: 'FAILURE', link: '' })
  const calls: string[][] = []
  const execute: typeof runOrThrow = async (_command, args) => {
    calls.push([...args])
    const json = args.includes('list')
      ? [
          { databaseId: 3, createdAt: '2026-08-12T12:00:00Z' },
          { databaseId: 2, createdAt: '2026-08-12T11:00:00Z' },
        ]
      : args.includes('3')
        ? { jobs: [
            { name: 'serial / windows (self-hosted standby)', status: 'completed', conclusion: 'cancelled' },
            { name: 'node 24 / static', status: 'completed', conclusion: 'success' },
          ] }
        : { jobs: [
            { name: 'serial / windows (self-hosted standby)', status: 'completed', conclusion: 'failure' },
          ] }
    return { code: 0, stdout: JSON.stringify(json), stderr: '', cancelled: false }
  }
  assert.deepEqual(await assessCiAutoFix('/repo', 'owner/repo', [
    check('windows node 24 / native complete'),
    check('node 24 / static'),
  ], 'master', undefined, execute), {
    actionableChecks: [check('node 24 / static')],
    failingBaseChecks: [{ name: 'windows node 24 / native complete', workflow: 'CI' }],
  })
  assert.deepEqual(calls.filter(args => args.includes('view')).map(args => args[2]), ['3', '2'])
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

test('allows every dsh worker to initialize its worktree dependencies', async () => {
  for (const filename of ['fix-ci.md', 'resolve-comments.md', 'merge-base.md']) {
    const prompt = await readFile(join(DSHW_ROOT, 'prompts', filename), 'utf8')
    assert.match(prompt, /你可以自行运行 `pnpm install` 等必要的初始化命令/, filename)
    assert.match(prompt, /push 成功后立即输出最终结果并结束本次 agent 任务/, filename)
    assert.match(prompt, /不得等待、轮询、重跑或尝试触发 push 后的新 CI/, filename)
  }
})

test('steers running agents every 20 minutes with the original task boundary', () => {
  assert.equal(AGENT_STEER_INTERVAL_MS, 20 * 60 * 1000)
  const prompt = renderPeriodicAgentReminder({
    handle: {} as DshWorkerHandle,
    kind: 'fix-ci',
    sync: { prNumber: 1768 } as SyncRecord,
    oldHead: 'old-head',
    label: '修复 CI',
  })
  assert.match(prompt, /这不是新任务/)
  assert.match(prompt, /PR #1768.*失败的 CI checks/)
  assert.match(prompt, /立即提交并 push.*结束本次 agent 任务/)
  assert.match(prompt, /不得等待、轮询、重跑或尝试触发 push 后的新 CI/)
  assert.match(prompt, /由 dshw 负责/)
})

test('appends optional user instructions to the worker prompt', () => {
  assert.equal(appendAdditionalInstruction('Base prompt', '  Keep the API stable.  '), 'Base prompt\n\n## 用户额外指令\n\nKeep the API stable.')
  assert.equal(appendAdditionalInstruction('Base prompt', '   '), 'Base prompt')
  assert.equal(appendAdditionalInstruction('Base prompt'), 'Base prompt')
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
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: 'missing credential' } } },
  }), '任务结束：error：missing credential')
  assert.equal(formatProgressEvent({
    type: 'tool/call',
    data: { name: 'bash', arguments: '{"cmd":"pnpm test"}' },
  }), '调用工具 bash：{\n  "cmd": "pnpm test"\n}')
  assert.equal(formatProgressEvent({
    type: 'assistant/message',
    data: { message: { content: [
      { type: 'reasoning', text: '先定位失败测试' },
      { type: 'text', text: '正在检查失败日志' },
    ] } },
  }), '思考：先定位失败测试\nAgent：正在检查失败日志')
})

test('groups live progress into lightweight display blocks', () => {
  assert.deepEqual(parseProgressOutput([
    '步骤 2 开始',
    '思考：先定位测试范围',
    'Agent：正在检查失败日志',
    '下一行说明',
    '调用工具 bash：{',
    '  "cmd": "pnpm test"',
    '}',
    '工具结果 完成：18 tests passed',
  ].join('\n')), [
    { kind: 'step', body: '步骤 2 开始', preview: '步骤 2 开始' },
    { kind: 'thinking', title: '思考', body: '先定位测试范围', preview: '先定位测试范围' },
    { kind: 'agent', title: 'Agent', body: '正在检查失败日志\n下一行说明', preview: '正在检查失败日志' },
    { kind: 'tool-call', title: 'bash', body: '{\n  "cmd": "pnpm test"\n}', preview: '"cmd": "pnpm test"' },
    { kind: 'tool-result', title: '完成', body: '18 tests passed', failed: false, preview: '18 tests passed' },
  ])
})

test('recognizes controls injected into live progress', () => {
  assert.deepEqual(parseProgressOutput([
    '用户指令：只修复这个测试',
    '补充说明',
    '系统：已请求暂停任务',
  ].join('\n')), [
    { kind: 'user', title: '你', body: '只修复这个测试\n补充说明', preview: '只修复这个测试' },
    { kind: 'system', title: '系统', body: '已请求暂停任务', preview: '已请求暂停任务' },
  ])
})

test('merges durable output pages with their overlapping live tail', () => {
  assert.equal(mergeProgressOutput('一\n二\n三\n', '二\n三\n四\n'), '一\n二\n三\n四\n')
  assert.equal(mergeProgressOutput('一\n二', '三\n四'), '一\n二\n三\n四')
})

test('steers and pauses a persisted dsh session over its Unix JSON-RPC socket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-worker-rpc-'))
  const socketPath = join(tmpdir(), `dshw-rpc-${process.pid}-${Date.now()}.sock`)
  const frames: Array<{ method: string; params: Record<string, unknown> }> = []
  const server = createNetServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const frame = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> }
      frames.push({ method: frame.method, params: frame.params })
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { accepted: true } })}\n`)
    })
  })
  const handle: DshWorkerHandle = {
    runId: 'dsh-rpc', label: 'worker', domain: 'domain', plistPath: join(root, 'worker.plist'),
    requestPath: join(root, 'request.json'), resultPath: join(root, 'result.json'), controlSocketPath: socketPath,
    progressProtocol: 'session-control-v1', startedAt: new Date().toISOString(),
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    await steerDshWorker(handle, '改成只修复这个测试')
    await cancelDshWorker(handle)
    assert.deepEqual(frames, [
      { method: 'session.steer', params: { prompt: '改成只修复这个测试' } },
      { method: 'session.cancel', params: {} },
    ])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(socketPath, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('reconstructs live dsh progress from the durable session event tail after reconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshw-worker-resume-'))
  const socketPath = join(tmpdir(), `dshw-resume-${process.pid}-${Date.now()}.sock`)
  const eventLogPath = join(root, 'session-events.ndjson')
  const server = createNetServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const frame = JSON.parse(buffer.slice(0, newline)) as { id: string }
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { phase: 'paused' } })}\n`)
    })
  })
  const startedAt = new Date().toISOString()
  const handle: DshWorkerHandle = {
    runId: 'dsh-resume', label: 'worker', domain: 'domain', plistPath: join(root, 'worker.plist'),
    requestPath: join(root, 'request.json'), resultPath: join(root, 'result.json'), controlSocketPath: socketPath,
    eventLogPath, progressProtocol: 'session-control-v1', startedAt,
  }
  try {
    await writeFile(eventLogPath, [
      { type: 'step/start', seq: 1, data: { step: 2 } },
      { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '等待新指令' }] } } },
    ].map(event => `${JSON.stringify(event)}\n`).join(''))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const progress = await inspectDshWorker(handle)
    assert.equal(progress.phase, 'paused')
    assert.match(progress.outputTail, /步骤 2 开始/)
    assert.match(progress.outputTail, /Agent：等待新指令/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(socketPath, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps code workspace PR folders in dashboard order without an all-worktrees folder', () => {
  const folders = codeWorkspaceFolders([
    { name: 'dsh-9', path: `${CLONES_ROOT}/dsh-9`, prNumber: 120 },
    { name: 'dsh-2', path: `${CLONES_ROOT}/dsh-2`, prNumber: 7 },
  ])
  assert.deepEqual(folders, [
    { name: 'PR_120', path: './worktrees/dsh-9' },
    { name: 'PR_7', path: './worktrees/dsh-2' },
    { name: 'dshw', path: './..' },
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
  const clonesRoot = join(root, 'worktrees')
  const metadataRoot = join(root, 'metadata')
  const worktree = join(clonesRoot, 'dsh-1')
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
    await mkdir(clonesRoot)
    await mkdir(metadataRoot)

    const branch = await addSharedWorktree(managed, 'feature/test', 'dsh-1', worktree)
    assert.equal(branch, 'dshw/dsh-1')
    assert.match(await readFile(join(worktree, '.git'), 'utf8'), /^gitdir: /)
    assert.equal((await runOrThrow('git', ['branch', '--show-current'], { cwd: worktree })).stdout.trim(), 'dshw/dsh-1')
    assert.equal((await runOrThrow('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: worktree })).stdout.trim(), 'origin/feature/test')
    assert.equal((await runOrThrow('git', ['config', '--worktree', 'push.default'], { cwd: worktree })).stdout.trim(), 'upstream')
    assert.equal(await gitCommonDir(worktree), await gitCommonDir(managed))

    const clone = {
      name: 'dsh-1', path: worktree, sourcePath: managed, remoteUrl: remote,
      repoSlug: 'deepseek-harness/deepseek-harness', branch: 'feature/test', worktreeBranch: branch, createdAt: new Date().toISOString(),
    }
    await writeFile(join(metadataRoot, 'dsh-1.json'), JSON.stringify(clone))
    await removeCloneRecord(clone, { managedRoot: managed, clonesRoot, metadataRoot })
    await assert.rejects(readFile(join(worktree, '.git'), 'utf8'))
    await assert.rejects(readFile(join(metadataRoot, 'dsh-1.json'), 'utf8'))
    assert.notEqual((await run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/dshw/dsh-1'], { cwd: managed })).code, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
