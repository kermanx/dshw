/** Stacked-PR 检测与"连续排列"排序（纯展示层，不改后端数据）。
 *
 * 一个 PR 的 baseRefName 命中同仓库另一个被追踪 PR 的 head 分支时，即视为叠在
 * 那个 PR 之上；这样逐层向上构成一条线性链（base → top）。一个分支只认第一个
 * 子 PR，出现叉形（多个 PR 以同一分支为 base）时其余子 PR 按非 stack 处理。
 */

import type { PrDashboardRecord } from '../../src/types.ts'

/** 排序后的一行：PR 本体 + 在 stack 中的树深度。 */
export interface PrStackRow {
  pr: PrDashboardRecord
  /** 0 = stack 根部（直接 base 在 trunk）；每往上叠一层 +1。 */
  depth: number
  /** 该 PR 的 head 分支是否被 stack 中下一层 PR 作为 base（即下面还有 PR）。 */
  hasChild: boolean
}

/**
 * 把一组（同一仓库的）PR 整理成"连续排列"的列表：
 * - 同一 stack 的 PR 彼此相邻，按 base → top 排列（根部在最上面）；
 * - stack 放在其成员在原列表中最先出现的位置，其余 PR 保持原相对顺序；
 * - 每个成员带 depth / hasChild，供视图绘制缩进与连接线；
 * - 不在任何 stack 中的 PR 返回 depth 0、hasChild false（视图据此不画连接线）。
 */
export function orderStackedPrs(records: readonly PrDashboardRecord[]): PrStackRow[] {
  const byBranch = new Map<string, PrDashboardRecord>()
  for (const record of records) {
    if (!byBranch.has(record.branch)) byBranch.set(record.branch, record)
  }
  const parent = new Map<PrDashboardRecord, PrDashboardRecord>()
  const child = new Map<PrDashboardRecord, PrDashboardRecord>()
  for (const record of records) {
    const base = byBranch.get(record.baseRefName)
    if (base === undefined || base === record || child.has(base)) continue
    parent.set(record, base)
    child.set(base, record)
  }
  /** 返回包含 member 的完整链（根部在前），不成链（长度 < 2 或成环）返回 undefined。 */
  const chainOf = (member: PrDashboardRecord): PrDashboardRecord[] | undefined => {
    const seenUp = new Set<PrDashboardRecord>()
    let root: PrDashboardRecord = member
    while (parent.has(root) && !seenUp.has(root)) {
      seenUp.add(root)
      root = parent.get(root)!
    }
    const chain: PrDashboardRecord[] = []
    const seen = new Set<PrDashboardRecord>()
    let node: PrDashboardRecord | undefined = root
    while (node !== undefined && !seen.has(node)) {
      seen.add(node)
      chain.push(node)
      node = child.get(node)
    }
    return node === undefined && chain.length >= 2 ? chain : undefined
  }
  const emitted = new Set<PrDashboardRecord>()
  const rows: PrStackRow[] = []
  for (const record of records) {
    if (emitted.has(record)) continue
    const chain = chainOf(record)
    if (chain !== undefined) {
      chain.forEach((pr, index) => {
        emitted.add(pr)
        rows.push({ pr, depth: index, hasChild: index < chain.length - 1 })
      })
      continue
    }
    emitted.add(record)
    rows.push({ pr: record, depth: 0, hasChild: false })
  }
  return rows
}
