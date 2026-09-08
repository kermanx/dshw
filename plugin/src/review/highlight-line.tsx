/** 把 Shiki token + 行内变更区间渲染成高亮代码行。 */
import type { CSSProperties, ReactNode } from 'react'
import { mergeTokenSpans } from './syntax-highlight.ts'
import type { SyntaxToken } from './syntax-highlight.ts'

/** 与单/连续/分页 diff 一致的变更底色（token 色保留，变更段加底色/圆角）。 */
function changedStyleOf(kind: 'added' | 'removed' | 'context'): CSSProperties | undefined {
  if (kind === 'added') return { background: 'rgba(46, 160, 96, .30)', borderRadius: 2 }
  if (kind === 'removed') return { background: 'rgba(226, 78, 78, .30)', borderRadius: 2 }
  return undefined
}

export function CodeSpans({ text, tokens, ranges, kind, style }: {
  text: string
  tokens: readonly SyntaxToken[]
  ranges: readonly [number, number][]
  kind: 'added' | 'removed' | 'context'
  style?: CSSProperties
}): ReactNode {
  const spans = mergeTokenSpans(tokens, ranges)
  const changedStyle = changedStyleOf(kind)
  const content = spans.length > 0
    ? spans.map((span, index) => {
        const extra: CSSProperties = {}
        if (span.changed && changedStyle !== undefined) Object.assign(extra, changedStyle)
        if (span.color !== null) extra.color = span.color
        if ((span.fontStyle & 1) !== 0) extra.fontStyle = 'italic'
        if ((span.fontStyle & 2) !== 0) extra.fontWeight = 600
        return <span key={index} style={extra}>{span.text}</span>
      })
    : (text === '' ? ' ' : text)
  return <code style={style}>{content}</code>
}
