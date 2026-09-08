/** 变更文件分类：浏览顺序的大层次。规则内置、纯函数；类别内再按“文件树顺序”
 *  （目录先于同层文件、段内 numeric/base 排序）。分类优先级：
 *  测试 > 元数据目录(噪音→其它) > 文档 > 配置 > 源码扩展名 > 其它。 */
import type { ReviewDiffFile } from '../../../src/types.ts'

export type ReviewCategoryId = 'source' | 'tests' | 'docs' | 'config' | 'other'

export const CATEGORY_ORDER: readonly ReviewCategoryId[] = ['source', 'tests', 'docs', 'config', 'other']

export const CATEGORY_META: Record<ReviewCategoryId, { label: string }> = {
  source: { label: '源码' },
  tests: { label: '测试' },
  docs: { label: '文档' },
  config: { label: '配置' },
  other: { label: '其它' },
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|c|cc|cpp|cxx|h|hpp|hh|cs|kt|kts|swift|rb|php|sh|bash|zsh|fish|pl|pm|ex|exs|erl|lua|scala|clj|dart|sql|graphql|proto)$/iu
const DOCS_EXT = /\.(md|mdx|txt|adoc|rst)$/iu
const CONFIG_EXT = /\.(ya?ml|json|toml|ini|lock|conf|cfg)$/iu

/** 判断路径属于哪个类别。 */
export function categoryOfPath(path: string): ReviewCategoryId {
  // 测试
  if (/(^|\/)(__tests__|tests?|specs?)(\/|$)/iu.test(path) || /\.(test|spec|e2e|it)\.[^/]+$/iu.test(path)) return 'tests'
  // 元数据/噪音目录：与实现无关，统一归“其它”，避免污染源码/文档类别。
  if (/(^|\/)(\.agents|\.changeset|\.github|\.gitlab|\.vscode|\.idea|vendor|third_party)(\/|$)/iu.test(path)) return 'other'
  // 文档
  if (/(^|\/)(docs?|documentation)(\/|$)/iu.test(path) || DOCS_EXT.test(path)) return 'docs'
  if (/(^|\/)(readme|changelog|license|contributing|code_of_conduct)(\.[^/]*)?$/iu.test(path)) return 'docs'
  // 配置
  if (CONFIG_EXT.test(path)) return 'config'
  if (/(^|\/)(tsconfig[^/]*|\.(eslintrc|prettierrc|npmrc|nvmrc|gitignore|gitattributes))$/iu.test(path)) return 'config'
  if (/\.config\.[^/.]+$/iu.test(path)) return 'config'
  // 源码
  if (SOURCE_EXT.test(path)) return 'source'
  return 'other'
}

/** 段间比较：numeric + base（与文件树命名一致）。 */
function compareSegments(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

/** 路径比较：祖先（目录）先于其后代文件，段内 numeric/base。 */
export function compareTreePaths(left: string, right: string): number {
  const l = left.split('/')
  const r = right.split('/')
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const a = l[index]
    const b = r[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const compared = compareSegments(a, b)
    if (compared !== 0) return compared
  }
  return 0
}

/** 主顺序：类别顺序 → 类别内文件树顺序。 */
export function compareCategoryPaths(left: string, right: string): number {
  const lc = CATEGORY_ORDER.indexOf(categoryOfPath(left))
  const rc = CATEGORY_ORDER.indexOf(categoryOfPath(right))
  if (lc !== rc) return lc - rc
  return compareTreePaths(left, right)
}

/** 把文件按 (类别, 文件树顺序) 排序。 */
export function orderFilesByCategory<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => compareCategoryPaths(left.path, right.path))
}

/** 每类文件计数（供类别分隔条/树分组表头）。 */
export function categoryCounts<T extends { path: string }>(files: readonly T[]): Map<ReviewCategoryId, number> {
  const counts = new Map<ReviewCategoryId, number>()
  for (const file of files) {
    const category = categoryOfPath(file.path)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return counts
}

export function categoryOfFile(file: ReviewDiffFile): ReviewCategoryId {
  return categoryOfPath(file.path)
}
