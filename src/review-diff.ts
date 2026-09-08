/**
 * Review workspace diff source (angry-turtle-review port).
 *
 * Everything is derived from the local review-only worktree clone: opening a
 * review guarantees the clone exists and is synchronized to the latest PR head,
 * then computes the PR's commit diff against the merge-base of its base ref.
 * Per-file payloads are parsed from a single `git diff` run and served from a
 * small in-memory cache keyed by review, never re-fetched per file.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReviewClone, listClones, reviewCloneName } from './clone.ts'
import { commitOid, fetchPullRequestHead, synchronizeReviewWorktree } from './git.ts'
import type { ReviewViewedStore } from './review-viewed.ts'
import type {
  ReviewDiffFile,
  ReviewDiffManifest,
  ReviewDiffPayload,
  ReviewDiffRow,
  ReviewRequestRecord,
} from './types.ts'
import { run, runOrThrow } from './util.ts'

/** Bounded in-memory cache of one prepared review diff. */
interface ReviewDiffEntry {
  token: string
  files: ReviewDiffFile[]
  payloads: ReviewDiffPayload[]
  baseRefName: string
  headRefName: string
  clonePath: string
  /** PR head OID this diff was captured against (freshness key). */
  headOid: string
}

const MAX_DIFF_BYTES = 8 * 1024 * 1024
const MAX_DIFF_LINES = 100_000
const MAX_DIFF_FILES = 2_000
const MAX_CACHE_ENTRIES = 12

/** Review diff cache owned by the daemon; keyed by `repoSlug#number`. */
export class ReviewDiffCache {
  private readonly entries = new Map<string, ReviewDiffEntry>()
  readonly #viewed: ReviewViewedStore

  constructor(viewed: ReviewViewedStore) {
    this.#viewed = viewed
  }

  /**
   * Always verify the PR head against GitHub first (review shows the uploaded
   * version). The cached diff is served only when the head has not moved;
   * otherwise the worktree is re-synced and the diff recomputed. Before the
   * manifest is returned, the persisted viewed record is reconciled against
   * this diff: files whose path vanished or whose diff fingerprint changed are
   * automatically unviewed.
   */
  async open(
    review: ReviewRequestRecord,
    managedRoot: string,
    options: { refresh?: boolean } = {},
  ): Promise<ReviewDiffManifest> {
    const key = reviewKey(review)
    const cached = this.entries.get(key)
    const prepared = await prepareReviewClone(review, managedRoot, { refresh: options.refresh })
    if (cached !== undefined && cached.headOid === prepared.headOid && options.refresh !== true) {
      const viewed = this.#reconcileViewed(key, cached.files)
      return { ...this.#manifest(cached), viewed, paged: this.#viewed.get(key)?.paged ?? {} }
    }

    const baseRefName = review.baseRefName || 'master'
    const captured = await computeReviewDiff(prepared.path, managedRoot, baseRefName)
    const entry: ReviewDiffEntry = {
      token: randomBytes(24).toString('base64url'),
      files: captured.files,
      payloads: captured.payloads,
      baseRefName,
      headRefName: review.headRefName,
      clonePath: prepared.path,
      headOid: prepared.headOid,
    }
    this.entries.set(key, entry)
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    const viewed = this.#reconcileViewed(key, entry.files)
    return { ...this.#manifest(entry), viewed, paged: this.#viewed.get(key)?.paged ?? {} }
  }

  /**
   * Reconcile the persisted viewed record with the current file set: drop
   * viewed files that no longer exist in the diff, or whose diff fingerprint
   * changed (the file's content in this head differs from what was read), and
   * refresh the stored total. Files whose diff is unchanged keep their read
   * state; files without a textual diff (binary etc.) cannot be verified and
   * are kept as long as the path still exists.
   */
  #reconcileViewed(key: string, files: readonly ReviewDiffFile[]): Record<string, string> {
    const record = this.#viewed.get(key)
    const byPath = new Map(files.map(file => [file.path, file]))
    if (record !== undefined && record.total === files.length) {
      const stale = Object.entries(record.viewed).some(([path, fingerprint]) => {
        const current = byPath.get(path)?.fingerprint
        return current === undefined ? byPath.has(path) === false : current !== fingerprint
      })
      if (!stale) return record.viewed
    }
    const viewed: Record<string, string> = {}
    for (const [path, fingerprint] of Object.entries(record?.viewed ?? {})) {
      const current = byPath.get(path)?.fingerprint
      if (current === undefined ? byPath.has(path) : current === fingerprint) viewed[path] = fingerprint
    }
    this.#viewed.set(key, { total: files.length, viewed, ...(record?.paged === undefined ? {} : { paged: record.paged }) })
    return viewed
  }

  /** Drop a cached review diff (used when a review conversation restarts the head). */
  invalidate(review: ReviewRequestRecord): void {
    this.entries.delete(reviewKey(review))
  }

  /** Serve one file's payload by its manifest token and file index. */
  payload(token: string, fileIndex: number): ReviewDiffPayload | undefined {
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return undefined
    for (const entry of this.entries.values()) {
      if (entry.token !== token) continue
      const payload = entry.payloads[fileIndex]
      return payload !== undefined && payload.file.index === fileIndex ? payload : undefined
    }
    return undefined
  }

  /** The review clone hosting `path` for a manifest token, or undefined when the
   *  token is unknown or the path is not one of the changed files (allowlist). */
  clonePathFor(token: string, path: string): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.token !== token) continue
      if (!entry.files.some(file => file.path === path)) return undefined
      return entry.clonePath
    }
    return undefined
  }

  #manifest(entry: ReviewDiffEntry): ReviewDiffManifest {
    return {
      available: true,
      token: entry.token,
      files: entry.files,
      baseRefName: entry.baseRefName,
      headRefName: entry.headRefName,
      clonePath: entry.clonePath,
      viewed: {},
      paged: {},
    }
  }
}

/**
 * Guarantee a local review clone whose checked-out HEAD is the PR version
 * currently uploaded to GitHub (`refs/pull/<n>/head`).
 *
 * - The PR head ref is always re-fetched from GitHub first, so the review can
 *   never silently show an older local checkout.
 * - A missing clone is created once at that head (git worktree, ~1s).
 * - An existing clone is reset only when the head actually moved AND the
 *   worktree is clean; a dirty worktree belongs to a running review
 *   conversation and is never discarded (the commit-to-commit diff still
 *   describes the version it was synced to).
 */
export async function prepareReviewClone(
  review: ReviewRequestRecord,
  managedRoot: string,
  options: { refresh?: boolean } = {},
): Promise<{ path: string; headOid: string }> {
  const head = await fetchPullRequestHead(managedRoot, review.number)
  const name = reviewCloneName(review.number, review.repoSlug)
  const existing = (await listClones()).find(clone => clone.name === name)
  if (existing === undefined) {
    const clone = await createReviewClone({ ...review, headRefName: review.headRefName || head.ref }, managedRoot, head.ref)
    // A fresh `git worktree add` already checks out the exact head cleanly.
    return { path: clone.path, headOid: head.oid }
  }

  const current = await commitOid(existing.path, 'HEAD')
  if (current === head.oid && options.refresh !== true) return { path: existing.path, headOid: current }

  const dirty = (await runOrThrow('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: existing.path,
    timeoutMs: 30_000,
  })).stdout.trim() !== ''
  if (!dirty) {
    await synchronizeReviewWorktree(existing.path, head.ref, false, `dshw review ${review.repoSlug}#${String(review.number)}`)
    return { path: existing.path, headOid: head.oid }
  }
  // Dirty + moved head: keep the checked-out commit (a conversation owns the
  // worktree); the caller diffs it commit-to-commit.
  return { path: existing.path, headOid: current }
}

interface ReviewDiffCapture {
  files: ReviewDiffFile[]
  payloads: ReviewDiffPayload[]
}

/** Compute the PR commit diff against the merge-base of its base ref. */
async function computeReviewDiff(
  clonePath: string,
  managedRoot: string,
  baseRefName: string,
): Promise<ReviewDiffCapture> {
  const baseRef = await resolveBaseRef(managedRoot, baseRefName)
  const mergeBase = (await runOrThrow('git', ['merge-base', baseRef, 'HEAD'], { cwd: clonePath, timeoutMs: 30_000 })).stdout.trim()
  if (mergeBase === '') throw new Error(`无法计算 ${baseRefName} 与 PR head 的 merge-base`)

  const result = await run('git', [
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames',
    '--unified=3', mergeBase, 'HEAD', '--',
  ], { cwd: clonePath, timeoutMs: 60_000 })

  if (result.code !== 0) {
    throw new Error(`git diff 失败：${(result.stderr || result.stdout).trim() || `exit ${String(result.code)}`}`)
  }
  if (Buffer.byteLength(result.stdout) > MAX_DIFF_BYTES) throw new Error('review diff 超过 8MB 上限')
  if (countLines(result.stdout) > MAX_DIFF_LINES) throw new Error('review diff 超过 10 万行显示上限')

  const parsed = parseReviewDiff(result.stdout)
  if (parsed.files.length > MAX_DIFF_FILES) throw new Error('review diff 文件数超过 2000 上限')
  return parsed
}

function countLines(value: string): number {
  let count = 0
  for (const character of value) if (character === '\n') count += 1
  return count
}

/** Ensure the base branch ref is locally available in the managed clone. */
async function resolveBaseRef(managedRoot: string, baseRefName: string): Promise<string> {
  const candidate = `refs/remotes/origin/${baseRefName}`
  const verify = await run('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { cwd: managedRoot })
  if (verify.code === 0) return candidate
  await runOrThrow('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${baseRefName}:${candidate}`], {
    cwd: managedRoot,
    timeoutMs: 5 * 60 * 1000,
  })
  return candidate
}

/* ── unified-diff parsing (git diff --unified=3 output) ──────────────────── */

interface MutableReviewFile {
  status: ReviewDiffFile['status']
  oldPath?: string
  newPath?: string
  newFile: boolean
  deletedFile: boolean
}

function reviewKey(review: ReviewRequestRecord): string {
  return `${review.repoSlug}#${String(review.number)}`
}

export function parseReviewDiff(output: string): ReviewDiffCapture {
  const files: ReviewDiffFile[] = []
  const payloads: ReviewDiffPayload[] = []
  let current: MutableReviewFile | undefined
  let currentFile: ReviewDiffFile | undefined
  let currentRows: ReviewDiffRow[] = []
  let inHunk = false
  let oldLine = 0
  let newLine = 0
  let additions = 0
  let deletions = 0
  let binary = false

  const flush = (): void => {
    if (currentFile === undefined) return
    const textPayload = !binary && currentRows.length > 0
    const fingerprint = textPayload ? fingerprintOfRows(currentRows) : undefined
    const file: ReviewDiffFile = fingerprint === undefined ? currentFile : { ...currentFile, fingerprint }
    files.push(file)
    if (binary) {
      payloads.push({
        kind: 'unavailable',
        file,
        rows: [],
        additions: 0,
        deletions: 0,
        reason: '二进制文件无法展示',
      })
    } else if (currentRows.length === 0) {
      payloads.push({
        kind: 'unavailable',
        file,
        rows: [],
        additions: 0,
        deletions: 0,
        reason: '该文件没有可展示的文本改动（可能仅包含元数据变更）',
      })
    } else {
      payloads.push({ kind: 'text', file, rows: currentRows, additions, deletions })
    }
    current = undefined
    currentFile = undefined
    currentRows = []
    inHunk = false
    additions = 0
    deletions = 0
    binary = false
  }

  for (const raw of splitLines(output)) {
    const line = raw
    if (line.startsWith('diff --git ')) {
      flush()
      current = { status: 'modified', newFile: false, deletedFile: false }
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('new file mode')) {
      current.newFile = true
      current.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      current.deletedFile = true
      current.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length)
      current.status = 'renamed'
      continue
    }
    if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length)
      current.status = 'renamed'
      continue
    }
    if (line.startsWith('copy from ')) {
      current.oldPath = line.slice('copy from '.length)
      current.status = 'copied'
      continue
    }
    if (line.startsWith('copy to ')) {
      current.newPath = line.slice('copy to '.length)
      current.status = 'copied'
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true
      continue
    }
    if (!inHunk && line.startsWith('--- ')) {
      current.oldPath = parseDiffPath(line.slice(4))
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      current.newPath = parseDiffPath(line.slice(4))
      if (currentFile === undefined) currentFile = finalizeFile(current, files.length)
      continue
    }
    if (line.startsWith('@@ ')) {
      // First hunk: finalize the file row once the paths are known.
      if (currentFile === undefined) currentFile = finalizeFile(current, files.length)
      const header = parseHunkHeader(line)
      if (header !== undefined) {
        ;({ oldLine, newLine } = header)
      }
      currentRows.push({ kind: 'hunk', text: line })
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      currentRows.push({ kind: 'added', text: line.slice(1), newLine })
      newLine += 1
      additions += 1
      continue
    }
    if (line.startsWith('-')) {
      currentRows.push({ kind: 'removed', text: line.slice(1), oldLine })
      oldLine += 1
      deletions += 1
      continue
    }
    if (line.startsWith(' ')) {
      currentRows.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
      oldLine += 1
      newLine += 1
      continue
    }
    // Unknown prefix inside a hunk: drop to keep rows aligned with git's file.
  }
  flush()
  return { files, payloads }
}

/**
 * Fingerprint of a file's changed-line content: the removed/added line texts
 * in diff order, with hunk boundaries kept as separators but absolute line
 * numbers and context lines ignored. Two heads whose diff for this file is
 * identical (including when base and PR head shift together outside the
 * changes) therefore produce the same fingerprint, so read status survives;
 * any real change to the file's diff changes it.
 */
export function fingerprintOfRows(rows: readonly ReviewDiffRow[]): string {
  const parts: Array<string | null> = []
  for (const row of rows) {
    if (row.kind === 'hunk') parts.push(null)
    else if (row.kind === 'added' || row.kind === 'removed') parts.push(row.text)
  }
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex')
}

function finalizeFile(current: MutableReviewFile, index: number): ReviewDiffFile {
  const path = current.newPath ?? current.oldPath ?? `unknown-${String(index)}`
  return {
    index,
    status: current.status,
    path,
    ...(current.oldPath !== undefined && current.oldPath !== path ? { oldPath: current.oldPath } : {}),
  }
}

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | undefined {
  // @@ -oldStart[,oldCount] +newStart[,newCount] @@ heading
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line)
  if (match === null) return undefined
  return { oldLine: Number(match[1]), newLine: Number(match[2]) }
}

function parseDiffPath(marker: string): string | undefined {
  const value = marker.trim()
  if (value === '' || value === '/dev/null') return undefined
  if (value.startsWith('"') && value.endsWith('"')) return unquoteGitPath(value)
  return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value
}

function unquoteGitPath(value: string): string {
  const inner = value.slice(1, -1)
  return inner
    .replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function splitLines(output: string): string[] {
  if (output === '') return []
  const lines = output.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/* ── full-file content at the PR head (continuous browsing) ── */

const MAX_CONTENT_BYTES = 4 * 1024 * 1024
const MAX_CONTENT_LINES = 15_000

/** Read one changed file's full content at the review clone's HEAD commit.
 *  `path` must have come from the diff manifest (allowlist checked by the
 *  caller via {@link ReviewDiffCache.clonePathFor}). */
export async function readFileAtHead(clonePath: string, path: string): Promise<{ content: string; truncated: boolean }> {
  const sizeResult = await run('git', ['cat-file', '-s', `HEAD:${path}`], { cwd: clonePath, timeoutMs: 30_000 })
  if (sizeResult.code !== 0) throw new Error('该文件在 PR head 中不存在（可能已被删除），无法查看完整文件')
  const bytes = Number(sizeResult.stdout.trim())
  if (!Number.isSafeInteger(bytes) || bytes > MAX_CONTENT_BYTES) throw new Error('文件过大（超过 4MB），无法完整展示')

  const result = await runOrThrow('git', ['cat-file', 'blob', `HEAD:${path}`], { cwd: clonePath, timeoutMs: 60_000 })
  // run() 已经把 git 输出按 utf-8 解码；非 UTF-8 内容会出现替换字符 U+FFFD。
  if (result.stdout.includes('\uFFFD')) throw new Error('该文件不是有效的 UTF-8 文本，无法完整展示')
  const content = result.stdout
  let truncated = false
  let lineCount = 1
  for (const character of content) {
    if (character === '\n') lineCount += 1
    if (lineCount > MAX_CONTENT_LINES) {
      truncated = true
      break
    }
  }
  return { content, truncated }
}
