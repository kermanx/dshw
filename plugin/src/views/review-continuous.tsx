/** Continuous browsing mode: every changed file stacked in diff order inside
 *  one scrollable page (like GitHub's files-changed view). Each file shows its
 *  diff-only body by default and can be collapsed or expanded to the full file
 *  content at the PR head. Bodies near the viewport mount lazily and stay
 *  mounted once seen; read-state lives with the shared detail view. */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type {
  ReviewDiffFile,
  ReviewDiffManifest,
  ReviewDiffPayload,
  ReviewDiffRow,
  ReviewRequestRecord,
} from '../../../src/types.ts'
import { createIntralineRenderer } from '../review/intraline.ts'
import type { IntralineSegment } from '../review/intraline.ts'
import { useReviewDiffPayload, useReviewFileContent } from '../review/use-review-diff.ts'
import { statusLabel, statusLetter, statusTone } from '../review/diff-status.ts'
import { CATEGORY_META, categoryOfPath, type ReviewCategoryId } from '../review/categories.ts'
import { changedRangesOf, useSyntaxTokens } from '../review/syntax-highlight.ts'
import type { SyntaxToken } from '../review/syntax-highlight.ts'
import { CodeSpans } from '../review/highlight-line.tsx'
import { GCaretDown, GCaretRight, GMaximize, GMinimize, StatusDot } from '../icons.tsx'
import { C_ACCENT_SOFT, C_BORDER, C_HOVER, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, FONT_MONO } from '../theme.ts'

type TextPayload = ReviewDiffPayload & { kind: 'text' }

const FILE_ROW_HEIGHT = 23
const FILE_HUNK_HEIGHT = 26
const NEAR_MARGIN = '1600px 0px'

export interface ContinuousFocus {
  path: string
  /** 分页模式优先按区块键跳转；连续模式忽略该字段。 */
  pageKey?: string
  nonce: number
}

export function ContinuousPane({ baseUrl, review, manifest, files, viewed, onViewedMany, focus, hideRead }: {
  baseUrl: string
  review: ReviewRequestRecord
  manifest: ReviewDiffManifest
  files: readonly ReviewDiffFile[]
  viewed: ReadonlySet<string>
  onViewedMany: (paths: readonly string[], value: boolean) => void
  focus?: ContinuousFocus
  /** 隐藏已读：files 已由外层过滤为未读文件；列表首位变化时把视图钉到新首位。 */
  hideRead: boolean
}): ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [full, setFull] = useState<ReadonlySet<string>>(new Set())
  const [flashPath, setFlashPath] = useState<string>()

  // 隐藏已读时，一旦顶部文件被标记已读（或过滤变化导致首位切换），
  // 把滚动位置钉到新的第一个区块，形成“读完一个自动顶上”的顺滑流。
  const prevFirstIndexRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    const first = files[0]
    const firstIndex = first === undefined ? undefined : first.index
    const previous = prevFirstIndexRef.current
    prevFirstIndexRef.current = firstIndex
    if (!hideRead) return
    if (previous !== undefined && firstIndex !== undefined && firstIndex !== previous) {
      document.getElementById(fileSectionId(firstIndex))?.scrollIntoView({ block: 'start' })
    }
  }, [files, hideRead])

  const setCollapsedFor = useCallback((path: string, value: boolean): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (value) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const setFullFor = useCallback((path: string, value: boolean): void => {
    setFull(current => {
      const next = new Set(current)
      if (value) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const setViewedFor = useCallback((path: string, value: boolean) => {
    onViewedMany([path], value)
  }, [onViewedMany])

  // 类别统计 + 类别边界（files 已按 类别→文件树 排序）。
  const categoryInfo = useMemo(() => {
    const counts = new Map<ReviewCategoryId, number>()
    const read = new Map<ReviewCategoryId, number>()
    const boundaryAt = new Set<number>()
    files.forEach((file, index) => {
      const category = categoryOfPath(file.path)
      if (index > 0 && category !== categoryOfPath(files[index - 1]!.path)) boundaryAt.add(index)
      counts.set(category, (counts.get(category) ?? 0) + 1)
      if (viewed.has(file.path)) read.set(category, (read.get(category) ?? 0) + 1)
    })
    return { counts, read, boundaryAt }
  }, [files, viewed])

  // Jump to the focused file from the sidebar; expand it and flash its header.
  useEffect(() => {
    if (focus === undefined) return
    const file = files.find(candidate => candidate.path === focus.path)
    if (file === undefined) return
    setCollapsedFor(focus.path, false)
    document.getElementById(fileSectionId(file.index))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFlashPath(focus.path)
    const timer = window.setTimeout(() => { setFlashPath(undefined) }, 1_500)
    return () => { window.clearTimeout(timer) }
  }, [focus, files, setCollapsedFor])

  return (
    <div ref={containerRef} style={continuousScrollStyle} data-dshw-kanban="continuous">
      {files.length === 0 && <div style={emptyStyle}>没有匹配的文件</div>}
      {files.map(file => {
        const index = file.index
        const category = categoryOfPath(file.path)
        return (
          <Fragment key={index}>
            {categoryInfo.boundaryAt.has(index) && (
              <div style={categoryBarStyle} data-dshw-kanban="categorybar">
                <span style={categoryBarLabelStyle}>{CATEGORY_META[category].label}</span>
                <span style={categoryBarCountStyle}>{categoryInfo.counts.get(category) ?? 0} 个文件{categoryInfo.read.get(category) !== undefined && categoryInfo.read.get(category)! > 0 ? ` · 已读 ${categoryInfo.read.get(category)}` : ''}</span>
              </div>
            )}
            <FileBlock
              file={file}
              index={index}
              containerRef={containerRef}
              baseUrl={baseUrl}
              review={review}
              manifest={manifest}
              viewed={viewed.has(file.path)}
              collapsed={collapsed.has(file.path)}
              full={full.has(file.path)}
              onCollapsedChange={value => { setCollapsedFor(file.path, value) }}
              onFullChange={value => { setFullFor(file.path, value) }}
              onViewed={value => { setViewedFor(file.path, value) }}
              flash={flashPath === file.path}
            />
          </Fragment>
        )
      })}
    </div>
  )
}

function fileSectionId(index: number): string {
  return `dshw-cw-${String(index)}`
}

function FileBlock({ file, index, containerRef, baseUrl, review, manifest, viewed, collapsed, full, onCollapsedChange, onFullChange, onViewed, flash }: {
  file: ReviewDiffFile
  index: number
  containerRef: RefObject<HTMLDivElement>
  baseUrl: string
  review: ReviewRequestRecord
  manifest: ReviewDiffManifest
  viewed: boolean
  collapsed: boolean
  full: boolean
  onCollapsedChange: (value: boolean) => void
  onFullChange: (value: boolean) => void
  onViewed: (value: boolean) => void
  flash: boolean
}): ReactNode {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const wrapper = wrapperRef.current
    const root = containerRef.current
    if (wrapper === null || root === null || typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setNear(true)
          observer.disconnect()
          break
        }
      }
    }, { root, rootMargin: NEAR_MARGIN })
    observer.observe(wrapper)
    return () => { observer.disconnect() }
  }, [containerRef])

  const open = !collapsed

  return (
    <section id={fileSectionId(index)} ref={wrapperRef} style={fileBlockStyle} data-dshw-kanban="cwfile">
      <header style={{ ...fileHeaderStyle, ...(flash ? { background: C_ACCENT_SOFT } : {}) }}>
        <button
          type="button"
          className="dshw-icon"
          style={chevronButtonStyle}
          aria-label={collapsed ? `展开 ${file.path}` : `收起 ${file.path}`}
          onClick={() => { onCollapsedChange(!collapsed) }}
        >
          {collapsed ? <GCaretRight size={13} /> : <GCaretDown size={13} />}
        </button>
        <span style={{ ...fileStatusStyle, color: statusTone(file.status) }} title={statusLabel(file.status)}>{statusLetter(file.status)}</span>
        <strong style={filePathStyle} title={file.path}>{file.path}</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flex: 'none' }}>
          <label style={viewedLabelStyle}>
            <input
              type="checkbox"
              data-dshw-kanban="reviewcheck"
              checked={viewed}
              aria-label={`标记已读（${file.path}）`}
              title={`标记已读（${file.path}）`}
              style={{ flex: 'none', margin: 0, accentColor: '#007acc', cursor: 'pointer' }}
              onClick={event => { event.stopPropagation() }}
              onChange={event => { onViewed(event.currentTarget.checked) }}
            />
            <span>已读</span>
          </label>
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            style={fileIconButtonStyle}
            aria-label={full ? '收起完整文件' : '查看完整文件'}
            title={full ? '收起完整文件（回到 diff 视图）' : '查看完整文件（PR head 全量内容）'}
            onClick={() => { onFullChange(!full); if (full === false && collapsed) onCollapsedChange(false) }}
          >
            {full ? <GMinimize size={14} /> : <GMaximize size={14} />}
          </button>
        </div>
      </header>
      {open && near && (full
        ? <FullFileBody baseUrl={baseUrl} review={review} manifest={manifest} path={file.path} />
        : <DiffFileBody baseUrl={baseUrl} review={review} manifest={manifest} file={file} />)}
    </section>
  )
}

function DiffFileBody({ baseUrl, review, manifest, file }: {
  baseUrl: string
  review: ReviewRequestRecord
  manifest: ReviewDiffManifest
  file: ReviewDiffFile
}): ReactNode {
  const { payload, loading, error } = useReviewDiffPayload(baseUrl, review, manifest, file.index)
  if (loading) return <div style={bodyNoticeStyle}><StatusDot tone="accent" pulse /><span>正在加载 diff…</span></div>
  if (error !== undefined) return <div style={bodyNoticeStyle}>加载失败：{error}</div>
  if (payload === undefined) return null
  if (payload.kind === 'unavailable') return <div style={bodyNoticeStyle}>{payload.reason ?? '该文件没有可展示的文本改动'}</div>
  return <InlineDiffRows payload={payload} baseUrl={baseUrl} />
}

function InlineDiffRows({ payload, baseUrl }: { payload: TextPayload; baseUrl: string }): ReactNode {
  const rows = payload.rows
  const intraline = useMemo(() => createIntralineRenderer(rows), [rows])
  const texts = useMemo(() => rows.map(row => row.text), [rows])
  const tokens = useSyntaxTokens(baseUrl, payload.file.path, texts)
  return (
    <div style={rowsScrollStyle} role="table" aria-label={payload.file.path}>
      <div style={{ width: 'max-content', minWidth: '100%' }}>
        {rows.map((row, index) => (
          <div key={index} role="row" style={diffRowStyle(row.kind)}>
            <DiffRowCells row={row} intraline={intraline} index={index} tokensOf={tokens.get} />
          </div>
        ))}
      </div>
    </div>
  )
}

function DiffRowCells({ row, intraline, index, tokensOf }: {
  row: ReviewDiffRow
  intraline: ReturnType<typeof createIntralineRenderer>
  index: number
  tokensOf: (text: string) => SyntaxToken[] | undefined
}): ReactNode {
  if (row.kind === 'hunk') return <code style={hunkTextStyle}>{row.text}</code>
  const segments = intraline.segmentsFor(index)
  const tokens = tokensOf(row.text)
  const ranges = segments === undefined || row.kind === 'context' ? [] : changedRangesOf(segments)
  return (
    <>
      <span style={lineNumberCellStyle}>{row.oldLine ?? ''}</span>
      <span style={lineNumberCellStyle}>{row.newLine ?? ''}</span>
      {tokens !== undefined && tokens.length > 0
        ? <CodeSpans text={row.text} tokens={tokens} ranges={ranges} kind={row.kind} style={codeTextStyle} />
        : <code style={codeTextStyle}>{segments === undefined || row.kind === 'context' ? (row.text === '' ? ' ' : row.text) : <IntralineText segments={segments} kind={row.kind} />}</code>}
    </>
  )
}

function IntralineText({ segments, kind }: { segments: readonly IntralineSegment[]; kind: 'added' | 'removed' }): ReactNode {
  return segments.map((segment, index) => segment.changed
    ? <span key={index} style={inlineChangeStyle(kind)}>{segment.text}</span>
    : segment.text)
}

function FullFileBody({ baseUrl, review, manifest, path }: {
  baseUrl: string
  review: ReviewRequestRecord
  manifest: ReviewDiffManifest
  path: string
}): ReactNode {
  const { content, truncated, loading, error } = useReviewFileContent(baseUrl, review, manifest, path)
  if (loading) return <div style={bodyNoticeStyle}><StatusDot tone="accent" pulse /><span>正在加载完整文件…</span></div>
  if (error !== undefined) return <div style={bodyNoticeStyle}>{error}</div>
  if (content === undefined) return null
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const visible = truncated ? lines.slice(0, 15_000) : lines
  const tokens = useSyntaxTokens(baseUrl, path, visible)
  return (
    <div style={rowsScrollStyle} role="table" aria-label={path}>
      <div style={{ width: 'max-content', minWidth: '100%' }}>
        {visible.map((line, index) => {
          const lineTokens = tokens.get(line)
          return (
            <div key={index} role="row" style={plainRowStyle}>
              <span style={lineNumberCellStyle}>{index + 1}</span>
              {lineTokens !== undefined && lineTokens.length > 0
                ? <CodeSpans text={line} tokens={lineTokens} ranges={[]} kind="context" style={codeTextStyle} />
                : <code style={codeTextStyle}>{line === '' ? ' ' : line}</code>}
            </div>
          )
        })}
      </div>
      {truncated && <div style={bodyNoticeStyle}>文件较大，仅展示前 15,000 行</div>}
    </div>
  )
}

/* ── styles ── */

const continuousScrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  background: C_SURFACE,
}

const emptyStyle: CSSProperties = { padding: 24, fontSize: 12.5, color: C_MUTED }

const categoryBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 30,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  background: 'rgba(0, 122, 204, .08)',
}

const categoryBarLabelStyle: CSSProperties = { fontSize: 12, fontWeight: 700, color: '#0b4a9c', whiteSpace: 'nowrap' }

const categoryBarCountStyle: CSSProperties = { fontSize: 11.5, color: C_SECONDARY, whiteSpace: 'nowrap' }

const fileBlockStyle: CSSProperties = {
  borderBottom: `1px solid ${C_BORDER}`,
  background: C_SURFACE,
}

const fileHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 34,
  padding: '0 8px 0 4px',
  position: 'sticky',
  top: 0,
  background: C_HOVER,
  zIndex: 1,
}

const chevronButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  color: C_SECONDARY,
  flex: 'none',
}

const fileStatusStyle: CSSProperties = {
  flex: 'none',
  width: 18,
  textAlign: 'center',
  fontWeight: 700,
  fontSize: 12,
}

const filePathStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
  fontWeight: 600,
  color: C_TEXT,
  fontFamily: FONT_MONO,
}

const viewedLabelStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  color: C_SECONDARY,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const fileIconButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  color: C_SECONDARY,
  flex: 'none',
}

const bodyNoticeStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  fontSize: 12.5,
  color: C_MUTED,
}

const rowsScrollStyle: CSSProperties = {
  overflowX: 'auto',
  overflowY: 'hidden',
}

const lineNumberCellStyle: CSSProperties = {
  flex: 'none',
  width: 44,
  textAlign: 'right',
  paddingRight: 8,
  color: C_SECONDARY,
  userSelect: 'none',
}

const hunkTextStyle: CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 12,
  color: '#0b4a9c',
  whiteSpace: 'pre',
}

const codeTextStyle: CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: 12,
  lineHeight: '23px',
  whiteSpace: 'pre',
  color: C_TEXT,
}

function diffRowStyle(kind: ReviewDiffRow['kind']): CSSProperties {
  const base: CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 8px' }
  if (kind === 'hunk') return { ...base, height: FILE_HUNK_HEIGHT, background: '#ddf4ff' }
  if (kind === 'added') return { ...base, height: FILE_ROW_HEIGHT, background: 'rgba(46, 160, 96, .11)' }
  if (kind === 'removed') return { ...base, height: FILE_ROW_HEIGHT, background: 'rgba(226, 78, 78, .11)' }
  return { ...base, height: FILE_ROW_HEIGHT, background: C_SURFACE }
}

const plainRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  height: FILE_ROW_HEIGHT,
  padding: '0 8px',
  background: C_SURFACE,
}

function inlineChangeStyle(kind: 'added' | 'removed'): CSSProperties {
  return kind === 'added'
    ? { background: 'rgba(46, 160, 96, .28)', color: '#0b5423', borderRadius: 2 }
    : { background: 'rgba(226, 78, 78, .28)', color: '#8b1a1a', borderRadius: 2 }
}
