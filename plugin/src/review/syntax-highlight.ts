/** 语法着色前端：按行批量向 daemon 的 /api/syntax 请求 Shiki token，做文本级
 *  缓存，并按批渐进更新（不做一次性整文件高亮）。着色与行内变更高亮在
 *  渲染层用 mergeTokenSpans 合并。 */
import { useEffect, useState } from 'react'

export interface SyntaxToken {
  content: string
  color: string | null
  fontStyle: number
}

const MAX_BATCH = 1_500

const tokenCache = new Map<string, SyntaxToken[]>()
const langByPath = new Map<string, string | null>()
const inflightByPath = new Map<string, Promise<void>>()

function cacheKey(lang: string, text: string): string {
  return `${lang}\u0000${text}`
}

/** 同步取某一行的已知 token；语言未知/不着色返回 undefined。 */
function knownTokens(path: string, text: string): SyntaxToken[] | undefined {
  const lang = langByPath.get(path)
  if (lang === undefined || lang === null) return undefined
  return tokenCache.get(cacheKey(lang, text))
}

/** 批量请求并写缓存（去重 + 同路径并发合并）。失败则标记该路径不着色。 */
function requestTokens(baseUrl: string, path: string, texts: readonly string[]): Promise<void> {
  const missing = [...new Set(texts)].filter(text => knownTokens(path, text) === undefined)
  if (missing.length === 0 || langByPath.get(path) === null) return Promise.resolve()
  const inflightKey = `${path}\u0000${missing.join('\u0001').slice(0, 160)}`
  let pending = inflightByPath.get(inflightKey)
  if (pending === undefined) {
    pending = (async () => {
      try {
        const response = await fetch(`${baseUrl}/api/syntax`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, lines: missing }),
        })
        const value = await response.json() as { lang: string | null; tokens: Array<SyntaxToken[] | null>; error?: string }
        if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
        langByPath.set(path, value.lang)
        if (value.lang !== null) {
          missing.forEach((text, index) => {
            const tokens = value.tokens[index]
            if (tokens !== null) tokenCache.set(cacheKey(value.lang as string, text), tokens)
          })
        }
      } catch {
        langByPath.set(path, null) // 失败/网络问题：本次会话内不再重试该路径
      }
    })().finally(() => { inflightByPath.delete(inflightKey) })
    inflightByPath.set(inflightKey, pending)
  }
  return pending
}

export interface SyntaxMap {
  /** text → tokens（未就绪的文本不在 map 里）。 */
  get: (text: string) => SyntaxToken[] | undefined
  /** 当前是否还有未就绪的文本。 */
  pending: boolean
}

/** 渐进式批量着色：先用缓存立即返回，再分块请求并回填；回填会触发重渲染。 */
export function useSyntaxTokens(baseUrl: string, path: string, texts: readonly string[]): SyntaxMap {
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    const chunks: string[][] = []
    for (let index = 0; index < texts.length; index += MAX_BATCH) chunks.push(texts.slice(index, index + MAX_BATCH))
    const run = async (): Promise<void> => {
      for (const chunk of chunks) {
        const missing = [...new Set(chunk)].filter(text => knownTokens(path, text) === undefined)
        if (missing.length === 0) continue
        await requestTokens(baseUrl, path, missing)
        if (cancelled) return
        setNonce(value => value + 1)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [baseUrl, path, texts])
  void nonce
  return {
    get: text => knownTokens(path, text),
    pending: texts.some(text => knownTokens(path, text) === undefined),
  }
}

/** 行内变更区间（intraline 片段 → [start, end)）。 */
export function changedRangesOf(segments: readonly { text: string; changed: boolean }[] | undefined): Array<[number, number]> {
  if (segments === undefined) return []
  const ranges: Array<[number, number]> = []
  let offset = 0
  for (const segment of segments) {
    if (segment.changed) ranges.push([offset, offset + segment.text.length])
    offset += segment.text.length
  }
  return ranges
}

export interface CodeSpan {
  text: string
  color: string | null
  fontStyle: number
  changed: boolean
}

/** 语法 token + 变更区间 → 可直接渲染的 span 列表。 */
export function mergeTokenSpans(
  tokens: readonly SyntaxToken[] | undefined,
  changed: readonly [number, number][],
): CodeSpan[] {
  if (tokens === undefined || tokens.length === 0) return []
  const spans: CodeSpan[] = []
  let offset = 0
  for (const token of tokens) {
    const start = offset
    const end = start + token.content.length
    offset = end
    const touched = changed.some(([changeStart, changeEnd]) => changeStart < end && changeEnd > start)
    spans.push({ text: token.content, color: token.color, fontStyle: token.fontStyle, changed: touched })
  }
  return spans
}
