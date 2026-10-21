/** Stacked-PR 检测与排序（纯展示层，不改后端数据）。
 *
 * 以 target master 的 PR 为根，收纳直接或间接 target 其 head 分支的所有 PR。
 * 根部不缩进，所有后代统一缩进一层，并按深度优先顺序连续排列。
 */

import type { PrDashboardRecord } from '../../src/types.ts'

/** 排序后的一行：PR 本体 + 展示缩进与依赖关系。 */
export interface PrStackRow {
  pr: PrDashboardRecord
  /** 0 = target master 的根部或非 stack PR；1 = stack 中的任意后代。 */
  depth: number
  /** 该 PR 的 head 分支是否被 stack 中其他 PR 作为 base。 */
  hasChild: boolean
}

/**
 * 把一组（同一仓库的）PR 整理成"连续排列"的列表：
 * - 同一 stack 的 PR 彼此相邻，根部在前，各分叉按原列表顺序深度优先遍历；
 * - stack 放在其成员在原列表中最先出现的位置，其余 PR 保持原相对顺序；
 * - 所有后代返回 depth 1，hasChild 保留直接依赖关系；
 * - 无法追溯到 target master 根部的 PR 返回 depth 0、hasChild false。
 */
export function orderStackedPrs(records: readonly PrDashboardRecord[]): PrStackRow[] {
  const byBranch = new Map<string, PrDashboardRecord>()
  for (const record of records) {
    if (!byBranch.has(record.branch)) byBranch.set(record.branch, record)
  }
  const children = new Map<PrDashboardRecord, PrDashboardRecord[]>()
  for (const record of records) {
    if (record.baseRefName === 'master') continue
    const base = byBranch.get(record.baseRefName)
    if (base === undefined || base === record) continue
    const siblings = children.get(base) ?? []
    siblings.push(record)
    children.set(base, siblings)
  }

  const stackByPr = new Map<PrDashboardRecord, PrStackRow[]>()
  for (const root of records) {
    if (root.baseRefName !== 'master') continue
    const stack: PrStackRow[] = []
    const visit = (pr: PrDashboardRecord, depth: number): void => {
      if (stackByPr.has(pr)) return
      stackByPr.set(pr, stack)
      const directChildren = children.get(pr) ?? []
      stack.push({ pr, depth, hasChild: directChildren.length > 0 })
      for (const child of directChildren) visit(child, 1)
    }
    visit(root, 0)
  }

  const emitted = new Set<PrDashboardRecord>()
  const rows: PrStackRow[] = []
  for (const record of records) {
    if (emitted.has(record)) continue
    const stack = stackByPr.get(record)
    if (stack !== undefined) {
      for (const row of stack) {
        emitted.add(row.pr)
        rows.push(row)
      }
      continue
    }
    emitted.add(record)
    rows.push({ pr: record, depth: 0, hasChild: false })
  }
  return rows
}
