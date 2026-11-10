/**
 * Diff between the reviewed head and the PR's current head.
 *
 * This is what the review panel shows under "改动": everything that happened
 * after the reviewer looked — the fix session's commits, plus anything else
 * pushed since. It reuses the review-diff parser, so files, hunks and rows are
 * the same shapes the review workspace already renders.
 */
import { randomUUID } from 'node:crypto'
import { run } from './util.ts'
import type { AutoReviewRecord, ReviewDiffFile, ReviewDiffPayload } from './types.ts'
import { parseReviewDiff } from './review-diff.ts'

/** Manifest of the fix-side diff, plus the per-file payload lookup. */
export interface AutoReviewDiffManifest {
  available: boolean
  token: string
  files: ReviewDiffFile[]
  /** Commit whose review produced the findings. */
  fromOid: string
  /** Current head of the PR branch. */
  toOid: string
  additions: number
  deletions: number
  error?: string
}

interface Entry {
  manifest: AutoReviewDiffManifest
  payloads: ReviewDiffPayload[]
  capturedAt: number
}

/** Most diff caches kept at once (one per open PR panel). */
const MAX_ENTRIES = 8

/** Cache of captured fix diffs keyed by record id + commit pair. */
export class AutoReviewDiffCache {
  readonly #entries = new Map<string, Entry>()

  /** Capture (or reuse) the diff for one record, with its per-file payloads. */
  async capture(record: AutoReviewRecord, clonePath: string, options: { refresh?: boolean } = {}): Promise<{ manifest: AutoReviewDiffManifest, payloads: ReviewDiffPayload[] }> {
    const from = record.reviewedHeadOid ?? record.headOid
    const to = record.observedHeadOid
    const key = `${record.id}\n${from}\n${to}`
    const existing = this.#entries.get(key)
    if (existing !== undefined && options.refresh !== true) return { manifest: existing.manifest, payloads: existing.payloads }
    const output = await run('git', ['diff', '--no-color', '--unified=3', '--no-ext-diff', from, to, '--'], {
      cwd: clonePath,
      timeoutMs: 2 * 60 * 1000,
    })
    if (output.code !== 0) {
      return {
        manifest: {
          available: false,
          token: '',
          files: [],
          fromOid: from,
          toOid: to,
          additions: 0,
          deletions: 0,
          error: `无法读取改动：${output.stderr.trim().slice(-400)}`,
        },
        payloads: [],
      }
    }
    const capture = parseReviewDiff(output.stdout)
    const manifest: AutoReviewDiffManifest = {
      available: true,
      token: randomUUID(),
      files: capture.files,
      fromOid: from,
      toOid: to,
      additions: capture.payloads.reduce((sum, payload) => sum + payload.additions, 0),
      deletions: capture.payloads.reduce((sum, payload) => sum + payload.deletions, 0),
    }
    this.#entries.set(key, { manifest, payloads: capture.payloads, capturedAt: Date.now() })
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = [...this.#entries.entries()].sort((left, right) => left[1].capturedAt - right[1].capturedAt)[0]
      if (oldest === undefined) break
      this.#entries.delete(oldest[0])
    }
    return { manifest, payloads: capture.payloads }
  }

  /** Manifest only (the review panel fetches payloads lazily). */
  async open(record: AutoReviewRecord, clonePath: string, options: { refresh?: boolean } = {}): Promise<AutoReviewDiffManifest> {
    return (await this.capture(record, clonePath, options)).manifest
  }

  /** One file of a previously captured manifest. */
  payload(token: string, fileIndex: number): ReviewDiffPayload | undefined {
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) return undefined
    for (const entry of this.#entries.values()) {
      if (entry.manifest.token !== token) continue
      return entry.payloads[fileIndex]
    }
    return undefined
  }
}
