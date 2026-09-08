/** Reviewed (viewed) files per review, persisted in the daemon data directory
 *  (NOT browser localStorage). One record per `repoSlug#number`: the total
 *  changed-file count and the map path → diff fingerprint captured when the
 *  file was last read. The fingerprint lets the manifest open reconcile and
 *  auto-unview files whose diff changed after a PR head update. */
import { join } from 'node:path'
import { DATA_ROOT } from './config.ts'
import { readJson, writeJsonAtomic } from './util.ts'

export const REVIEW_VIEWED_FILE = join(DATA_ROOT, 'review-viewed.json')

/** One review's read-status record. */
export interface ViewedRecord {
  total: number
  /** Changed-file path → fingerprint of the diff the user last read. */
  viewed: Record<string, string>
  /** 分页浏览模式：已读页面的内容指纹（页面由客户端按视口打包，服务端只存不校验）。 */
  paged?: Record<string, boolean>
}

interface ViewedDocument {
  version: 1
  records: Record<string, ViewedRecord>
}

export function reviewViewedKey(repoSlug: string, prNumber: number): string {
  return `${repoSlug}#${String(prNumber)}`
}

/** Write-through, atomic, serialized store for viewed-file records. */
export class ReviewViewedStore {
  readonly #file: string
  #records: Record<string, ViewedRecord> = {}
  #writes: Promise<void> = Promise.resolve()

  private constructor(file: string) {
    this.#file = file
  }

  static async open(file = REVIEW_VIEWED_FILE): Promise<ReviewViewedStore> {
    const store = new ReviewViewedStore(file)
    const document = await readJson<ViewedDocument>(file)
    if (document?.version === 1 && typeof document.records === 'object' && document.records !== null) {
      store.#records = document.records
    }
    return store
  }

  /** Return a copy of one record (undefined when nothing stored yet). */
  get(key: string): ViewedRecord | undefined {
    const record = this.#records[key]
    return record === undefined
      ? undefined
      : { total: record.total, viewed: { ...record.viewed }, ...(record.paged === undefined ? {} : { paged: { ...record.paged } }) }
  }

  /** Replace one record; persisted atomically behind earlier writes. */
  set(key: string, record: ViewedRecord): void {
    this.#records[key] = {
      total: record.total,
      viewed: { ...record.viewed },
      ...(record.paged === undefined ? {} : { paged: { ...record.paged } }),
    }
    this.#writes = this.#writes
      .then(() => writeJsonAtomic(this.#file, { version: 1 as const, records: this.#records }))
      .catch((error: unknown) => {
        // Persistence must never crash the daemon; the in-memory copy stays authoritative.
        console.error(`[review-viewed] 保存已读状态失败：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Read-status summaries for the snapshot (list badges). */
  summary(key: string): { count: number; total: number } | undefined {
    const record = this.#records[key]
    if (record === undefined) return undefined
    return { count: Object.keys(record.viewed).length, total: record.total }
  }
}
