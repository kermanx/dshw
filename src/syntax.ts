/**
 * Shiki 语法着色（服务端、懒加载）。
 *
 * - 使用 JavaScript 正则引擎（无需 wasm），语言按需动态加载并注册；
 * - 只对“文本行”逐行 token 化（行级着色，块注释跨行等会退化为行级近似）；
 * - 结果按 (语言, 文本) 缓存，服务端有界；前端按可见/渲染行分批请求，
 *   实现渐进式高亮，不要求一次高亮整个文件。
 */
import { createHighlighterCore } from 'shiki/core'
import type { HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

export interface HighlightToken {
  content: string
  /** 主题前景色（hex）；null = 无覆盖色。 */
  color: string | null
  fontStyle: number
}

interface LangLoader {
  id: string
  file: string
}

const GITHUB_LIGHT_FILE = 'shiki/dist/themes/github-light.mjs'

/** 支持的语言（路径 → shiki 语言 id / 语言模块文件名）。 */
const LANG_BY_PREFIX: Array<{ test: RegExp; loader: LangLoader }> = [
  { test: /\.tsx$/iu, loader: { id: 'tsx', file: 'tsx' } },
  { test: /\.ts$/iu, loader: { id: 'typescript', file: 'typescript' } },
  { test: /\.jsx$/iu, loader: { id: 'jsx', file: 'jsx' } },
  { test: /\.m?js$/iu, loader: { id: 'javascript', file: 'javascript' } },
  { test: /\.(jsonc?|code-workspace)$/iu, loader: { id: 'json', file: 'json' } },
  { test: /\.ya?ml$/iu, loader: { id: 'yaml', file: 'yaml' } },
  { test: /\.py$/iu, loader: { id: 'python', file: 'python' } },
  { test: /\.go$/iu, loader: { id: 'go', file: 'go' } },
  { test: /\.rs$/iu, loader: { id: 'rust', file: 'rust' } },
  { test: /\.mdx?$/iu, loader: { id: 'markdown', file: 'markdown' } },
  { test: /\.(sh|bash|zsh|fish)$/iu, loader: { id: 'shellscript', file: 'shellscript' } },
  { test: /\.vue$/iu, loader: { id: 'vue', file: 'vue' } },
  { test: /\.css$/iu, loader: { id: 'css', file: 'css' } },
  { test: /\.html$/iu, loader: { id: 'html', file: 'html' } },
  { test: /\.java$/iu, loader: { id: 'java', file: 'java' } },
  { test: /\.(c|h|cc|cpp|cxx|hpp|hh)$/iu, loader: { id: 'c', file: 'c' } },
]

/** 由路径推断 shiki 语言（无匹配返回 undefined → 不着色）。 */
export function shikiLangFor(path: string): LangLoader | undefined {
  return LANG_BY_PREFIX.find(candidate => candidate.test.test(path))?.loader
}

const MAX_CACHE_ENTRIES = 30_000
const lineCache = new Map<string, HighlightToken[]>()

let highlighterPromise: Promise<HighlighterCore> | undefined
let loadedLangs = new Set<string>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const theme = (await import(GITHUB_LIGHT_FILE)).default
    const highlighter = await createHighlighterCore({
      themes: [theme],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
    return highlighter
  })()
  return highlighterPromise
}

async function ensureLang(lang: LangLoader): Promise<void> {
  if (loadedLangs.has(lang.id)) return
  const highlighter = await getHighlighter()
  const grammar = (await import(`shiki/dist/langs/${lang.file}.mjs`)).default
  await highlighter.loadLanguage(grammar)
  loadedLangs.add(lang.id)
}

/** 对单个代码行做着色；未知文本长度过大时直接放弃。 */
export async function highlightLine(lang: LangLoader, text: string): Promise<HighlightToken[]> {
  const cacheKey = `${lang.id}\u0000${text}`
  const cached = lineCache.get(cacheKey)
  if (cached !== undefined) return cached
  await ensureLang(lang)
  const highlighter = await getHighlighter()
  const line = highlighter.codeToTokens(text, { lang: lang.id, theme: 'github-light', includeExplanation: false }).tokens[0] ?? []
  const tokens = line.map(token => ({
    content: token.content,
    color: token.color ?? null,
    fontStyle: token.fontStyle ?? 0,
  }))
  lineCache.set(cacheKey, tokens)
  if (lineCache.size > MAX_CACHE_ENTRIES) {
    const oldest = lineCache.keys().next().value
    if (oldest !== undefined) lineCache.delete(oldest)
  }
  return tokens
}

/** 批量着色（texts 去重后返回同序数组；单次上限由调用方控制）。 */
export async function highlightLines(lang: LangLoader, texts: readonly string[]): Promise<HighlightToken[][]> {
  return await Promise.all(texts.map(text => highlightLine(lang, text)))
}
