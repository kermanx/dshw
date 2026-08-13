import type { GitGraphBranch, GitGraphCommit, GitGraphSnapshot, PrDashboardRecord } from './types.ts'
import { commitOid } from './git.ts'
import { now, runOrThrow } from './util.ts'

export const GIT_GRAPH_COMMIT_LIMIT = 2_000
const MIN_MASTER_COMMITS = 80

interface GitGraphRef {
  name: string
  oid: string
}

/** Parse the NUL-delimited format emitted by readGitGraph. */
export function parseGitGraphLog(output: string, refs: readonly GitGraphRef[]): GitGraphCommit[] {
  const refsByOid = new Map<string, string[]>()
  for (const ref of refs) {
    const names = refsByOid.get(ref.oid) ?? []
    names.push(ref.name)
    refsByOid.set(ref.oid, names)
  }

  return output.split('\x1e').flatMap(rawRecord => {
    const record = rawRecord.replace(/^\n/u, '')
    if (record.trim() === '') return []
    const fields = record.split('\x00')
    const [hash, parentsText, authorName, authorEmail, timestampText, subject, ...bodyParts] = fields
    if (hash === undefined || !/^[0-9a-f]{40,64}$/u.test(hash)) {
      throw new Error(`git log 返回了无效 commit hash：${JSON.stringify(hash)}`)
    }
    const timestamp = Number(timestampText)
    return [{
      hash,
      parents: parentsText === undefined || parentsText === '' ? [] : parentsText.split(' '),
      subject: subject ?? '',
      body: bodyParts.join('\x00').replace(/\n$/u, ''),
      author: {
        name: authorName ?? '',
        email: authorEmail ?? '',
        timestamp: Number.isFinite(timestamp) ? timestamp * 1_000 : 0,
      },
      refs: refsByOid.get(hash) ?? [],
    }]
  })
}

async function masterOid(root: string): Promise<string> {
  try {
    return await commitOid(root, 'refs/remotes/origin/master')
  } catch {
    return await commitOid(root, 'master')
  }
}

async function revList(root: string, limit: number, ...revisions: string[]): Promise<string[]> {
  const result = await runOrThrow('git', ['rev-list', '--topo-order', `--max-count=${limit}`, ...revisions], {
    cwd: root,
    timeoutMs: 30_000,
  })
  return result.stdout.trim().split('\n').filter(Boolean)
}

export async function readGitGraph(
  root: string,
  prs: readonly PrDashboardRecord[],
  limit = GIT_GRAPH_COMMIT_LIMIT,
): Promise<GitGraphSnapshot> {
  const master = await masterOid(root)
  const repoSlug = prs[0]?.repoSlug ?? 'deepseek-harness/deepseek-harness'
  const matchingPrs = prs.filter(pr => pr.repoSlug === repoSlug && pr.headOid !== undefined)
  const branches: GitGraphBranch[] = [
    { name: 'master', label: 'master', oid: master, kind: 'master' },
    ...matchingPrs.map(pr => ({
      name: pr.branch,
      label: `PR #${pr.number} · ${pr.branch}`,
      oid: pr.headOid!,
      kind: 'pr' as const,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
    })),
  ]
  const uniqueTips = [...new Set(branches.map(branch => branch.oid))]
  if (uniqueTips.some(oid => !/^[0-9a-f]{40,64}$/u.test(oid))) throw new Error('Git graph 包含无效的 branch tip')

  // A bounded recent-master window can detach an older PR's merge base and
  // fabricate a second root. Read a continuous first-parent mainline back to
  // the oldest open-PR base, plus each PR's complete unique history.
  const prBases = await Promise.all(matchingPrs.map(async pr => {
    const mergeBaseResult = await runOrThrow('git', ['merge-base', master, pr.headOid!], { cwd: root, timeoutMs: 30_000 })
    const mergeBase = mergeBaseResult.stdout.trim()
    if (!/^[0-9a-f]{40,64}$/u.test(mergeBase)) throw new Error(`PR #${pr.number} merge-base 无效`)
    const distanceResult = await runOrThrow('git', [
      'rev-list', '--first-parent', '--count', `${mergeBase}..${master}`,
    ], { cwd: root, timeoutMs: 30_000 })
    const masterDistance = Number(distanceResult.stdout.trim())
    if (!Number.isSafeInteger(masterDistance) || masterDistance < 0) throw new Error(`PR #${pr.number} master 距离无效`)
    return { pr, mergeBase, masterDistance }
  }))
  const masterLimit = matchingPrs.length === 0
    ? limit
    : Math.max(MIN_MASTER_COMMITS, ...prBases.map(item => item.masterDistance + 1))
  const [masterHistory, ...prHistories] = await Promise.all([
    // The dashboard compares open PR branches with the master mainline. Walking
    // every merge parent also pulls in already-merged PR histories and turns
    // the graph into unrelated branch noise.
    revList(root, masterLimit, '--first-parent', master),
    ...prBases.map(async ({ pr, mergeBase }) => ({
      history: await revList(root, limit, pr.headOid!, '--not', master),
      mergeBase,
    })),
  ])
  const selected = new Set(masterHistory)
  for (const prHistory of prHistories) {
    for (const oid of prHistory.history) selected.add(oid)
    if (/^[0-9a-f]{40,64}$/u.test(prHistory.mergeBase)) selected.add(prHistory.mergeBase)
  }

  const result = await runOrThrow('git', [
    'log', '--no-walk=sorted',
    '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x1e',
    ...selected,
  ], { cwd: root, timeoutMs: 30_000 })
  const commits = parseGitGraphLog(result.stdout, branches.map(branch => ({ name: branch.label, oid: branch.oid })))
  return {
    repoSlug,
    generatedAt: now(),
    commits,
    branches,
    truncated: matchingPrs.length === 0
      ? masterHistory.length >= limit
      : prHistories.some(history => history.history.length >= limit),
  }
}
