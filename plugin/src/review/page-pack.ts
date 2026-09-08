/** Pure helpers for paged browsing（“区块”）：把一个文件的 diff 行按可用视口
 *  高度打包成页，并为每页生成内容指纹（读状态键）。无 DOM 依赖，便于单测。 */
import type { ReviewDiffFile, ReviewDiffRow } from '../../../src/types.ts'

export const PAGE_ROW_HEIGHT = 23
export const PAGE_HUNK_HEIGHT = 26

/** 一个文件的全部 diff 行（hunk 头 + 上下文 + 增删行，顺序拼接）。 */
export interface FileRowGroup {
  file: ReviewDiffFile
  rows: ReviewDiffRow[]
}

/** 一屏一个区块（打包结果）。同一文件内 ordinal 从 1 编号。 */
export interface ReviewPage {
  /** 页面内容指纹（文件路径 + 页内变更行文本），读状态按它持久化。 */
  key: string
  file: ReviewDiffFile
  rows: ReviewDiffRow[]
  /** 预测像素高度（行高 × 行数）。 */
  height: number
  /** 页在其文件内的序号（1 起）。 */
  ordinal: number
  /** 该文件在这次打包里的总页数。 */
  filePageTotal: number
}

export function rowHeightOf(row: ReviewDiffRow | undefined): number {
  if (row === undefined) return 0
  return row.kind === 'hunk' ? PAGE_HUNK_HEIGHT : PAGE_ROW_HEIGHT
}

/**
 * 行级精确装填：把每个文件的 diff 行按顺序切成连续的行段，每页尽量装满
 * （累计行高 ≤ rowsBudget），切分点可以在任意行之间（甚至把一个 hunk
 * 拆到两页），不重不漏；只有当文件总行数极少时页面才会不满。页面不跨文件。
 */
export function packPages(groups: readonly FileRowGroup[], rowsBudget: number): ReviewPage[] {
  const pages: ReviewPage[] = []
  for (const group of groups) {
    const filePages: ReviewPage[] = []
    let start = 0
    while (start < group.rows.length) {
      let height = 0
      let end = start
      while (end < group.rows.length) {
        const next = height + rowHeightOf(group.rows[end])
        if (next > rowsBudget) break
        height = next
        end += 1
      }
      if (end === start) end = start + 1 // 理论不可达：单行高度也超预算
      filePages.push({ key: '', file: group.file, rows: group.rows.slice(start, end), height, ordinal: 0, filePageTotal: 0 })
      start = end
    }
    const total = filePages.length
    filePages.forEach((page, index) => {
      page.ordinal = index + 1
      page.filePageTotal = total
      page.key = pageKeyOf(page)
    })
    pages.push(...filePages)
  }
  return pages
}

/** 64-bit FNV-1a over the page's changed-line content + file path; stable as
 *  long as the packed content does not change. */
export function pageKeyOf(page: Pick<ReviewPage, 'file' | 'rows'>): string {
  const parts: Array<string | null> = []
  for (const row of page.rows) {
    if (row.kind === 'hunk') parts.push(null)
    else if (row.kind !== 'context') parts.push(row.text)
  }
  let hash = 0xcbf29ce484222325n
  const input = `${page.file.path}\u0000${JSON.stringify(parts)}`
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `p${hash.toString(16)}`
}

/** 页面是否应该因“已读”而被隐藏：页面本身已读，或（文件级）整文件已读。 */
export function isPageHidden(page: Pick<ReviewPage, 'key' | 'file'>, paged: Readonly<Record<string, boolean>>, viewedFiles: ReadonlySet<string>): boolean {
  return paged[page.key] === true || viewedFiles.has(page.file.path)
}
