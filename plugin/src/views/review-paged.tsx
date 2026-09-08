/** Paged browsing mode: the diff is split into “区块” — each page packs as many
 *  consecutive hunks (of one file) as fit the current content viewport, so the
 *  reviewer reads one screenful at a time, marks it read or skips ahead, and
 *  moves between pages. Read marks are keyed by the page's content fingerprint
 *  and persisted through the daemon (manifest.paged).
 *
 *  “隐藏已读”（hideRead）开启时，已读区块与已读文件（viewedFiles）的区块不会
 *  出现在可浏览列表里；打包始终基于完整内容（rawPages），因此切换开关不会让
 *  区块边界漂移。页面结构通过 onPagesState 上报给外层（左侧栏按区块镜像）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  ReviewDiffFile,
  ReviewDiffManifest,
  ReviewDiffRow,
  ReviewRequestRecord,
} from '../../../src/types.ts'
import { createIntralineRenderer } from '../review/intraline.ts'
import type { IntralineSegment } from '../review/intraline.ts'
import { fetchReviewDiffPayload } from '../review/use-review-diff.ts'
import { statusLabel, statusLetter, statusTone } from '../review/diff-status.ts'
import { StatusDot } from '../icons.tsx'
import { changedRangesOf, useSyntaxTokens } from '../review/syntax-highlight.ts'
import type { SyntaxToken } from '../review/syntax-highlight.ts'
import { CodeSpans } from '../review/highlight-line.tsx'
import { isPageHidden, packPages, rowHeightOf, type FileRowGroup, type ReviewPage } from '../review/page-pack.ts'
import { C_ACCENT, C_BORDER, C_HOVER, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, FONT_MONO } from '../theme.ts'

const ROW_HEIGHT = 23
const HUNK_HEIGHT = 26
const LABEL_HEIGHT = 26

/** 页面列表快照，由 PagedPane 上报给外层（用于左侧栏按区块展示与高亮当前页）。 */
export interface PagedStateInfo {
  /** 当前可浏览（含隐藏过滤后）的区块列表，与内容区逐页对应。 */
  pages: readonly ReviewPage[]
  /** 当前区块在 pages 里的下标。 */
  current: number
}

export function PagedPane({ baseUrl, review, manifest, files, paged, viewedFiles, hideRead, onTogglePage, focus, onPagesState, onUndo, canUndo, onShowRead }: {
  baseUrl: string
  review: ReviewRequestRecord
  manifest: ReviewDiffManifest
  files: readonly ReviewDiffFile[]
  /** 分页模式已读区块（页面指纹 → true）。 */
  paged: Readonly<Record<string, boolean>>
  /** 文件级已读（整文件视为已读，区块随之隐藏）。 */
  viewedFiles: ReadonlySet<string>
  /** 隐藏已读区块/文件（列表与 diff 中不再出现，默认开启）。 */
  hideRead: boolean
  onTogglePage: (key: string, value: boolean) => void
  /** 跳转请求：pageKey 优先（左侧栏点区块），否则跳到该文件第一个区块。 */
  focus?: { path: string; pageKey?: string; nonce: number }
  /** 页面结构或当前页变化时上报（左侧栏据此镜像）。 */
  onPagesState?: (state: PagedStateInfo) => void
  onUndo?: () => void
  /** 是否还有可撤销的历史（完成态按钮置灰）。 */
  canUndo?: boolean
  /** 关闭“隐藏已读”，让全部区块（含已读）重新出现。 */
  onShowRead?: () => void
}): ReactNode {
  const labelRef = useRef<HTMLDivElement>(null)
  const rowsInnerRef = useRef<HTMLDivElement>(null)
  // 默认可视高度给一个保守值（≈720px），即使 DOM 测量晚到，页面也不会
  // 退化成两三行；measure 一到就用真实值覆盖。
  const [avail, setAvail] = useState(720)
  const [labelH, setLabelH] = useState(LABEL_HEIGHT)
  /** 预测行高 → 实际渲染行高 的比例（仅在大页面上做受限校准）。 */
  const [rowScale, setRowScale] = useState(1)
  const [loaded, setLoaded] = useState<{ done: number; total: number }>()
  const [groups, setGroups] = useState<FileRowGroup[]>([])
  const [current, setCurrent] = useState(0)

  // Watch the content area size: pages are sized to fit it. content 会随区块
  // 切换而重挂载（key 变化），因此按元素身份重建 observer，避免盯住旧节点；
  // 同时做几次延时重测兜底。
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = contentEl
    if (element === null) return
    const measure = (): void => {
      const height = element.clientHeight
      if (height > 0) setAvail(height)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    const retries = [80, 250, 700].map(delay => window.setTimeout(measure, delay))
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      retries.forEach(timer => window.clearTimeout(timer))
    }
  }, [contentEl])

  // 行预算（预测像素）：可见区减去 8px 余量与实测标签高，再除以校准比例。
  const budget = Math.max(60, (avail - 8 - labelH) / rowScale)

  // Load every text payload (module-cached) and flatten hunks in diff order.
  useEffect(() => {
    let cancelled = false
    setLoaded({ done: 0, total: files.length })
    setCurrent(0)
    const collected: FileRowGroup[] = []
    let done = 0
    const loadOne = async (index: number): Promise<void> => {
      const file = files[index]
      if (file === undefined) return
      try {
        const payload = await fetchReviewDiffPayload(baseUrl, review, manifest, file.index)
        if (!cancelled && payload.kind === 'text' && payload.rows.length > 0) {
          collected.push({ file, rows: [...payload.rows] })
        }
      } catch {
        // 单个文件失败不阻塞分页（比如文件过大），跳过即可。
      }
    }
    const workers = Array.from({ length: Math.min(4, files.length) }, async (_, worker) => {
      for (let index = worker; index < files.length && !cancelled; index += 4) {
        await loadOne(index)
        done += 1
        if (!cancelled) setLoaded({ done, total: files.length })
      }
    })
    void Promise.all(workers).then(() => {
      if (cancelled) return
      collected.sort((left, right) => {
        const a = files.findIndex(file => file.index === left.file.index)
        const b = files.findIndex(file => file.index === right.file.index)
        return a - b
      })
      setGroups(collected)
    })
    return () => { cancelled = true }
  }, [baseUrl, files, manifest, review])

  // 打包始终基于完整内容：切换“隐藏已读”只过滤展示列表，不改变区块边界。
  const rawPages = useMemo(() => packPages(groups, budget), [groups, budget])
  const pages = useMemo(
    () => (hideRead ? rawPages.filter(page => !isPageHidden(page, paged, viewedFiles)) : rawPages),
    [rawPages, hideRead, paged, viewedFiles],
  )
  // 当前区块跟随列表变化：按区块 key 保持位置（前面区块被标记已读而移除时
  // 列表会整体前移，纯按下标会跳到错误区块）。若当前区块本身被移除（刚被
  // 标记已读/整文件已读），优先落到其后第一个仍可见的区块，否则退回末尾。
  // 打包边界漂移（重新打包产生新 key）时无法按 key 对齐，退回按下标收缩。
  const prevPagesRef = useRef<readonly ReviewPage[]>([])
  useEffect(() => {
    const previous = prevPagesRef.current
    prevPagesRef.current = pages
    setCurrent(index => {
      if (pages.length === 0) return 0
      const wasKey = previous[index]?.key
      if (wasKey === undefined) return Math.min(index, pages.length - 1)
      const kept = pages.findIndex(page => page.key === wasKey)
      if (kept >= 0) return kept
      // 纯移除（当前区块之外没有其它 key 消失）→ 向后找下一个仍可见的区块。
      const surviving = previous.filter(page => pages.some(candidate => candidate.key === page.key)).length
      if (surviving === pages.length) {
        for (let after = index + 1; after < previous.length; after += 1) {
          const key = previous[after]?.key
          if (key === undefined) continue
          const found = pages.findIndex(page => page.key === key)
          if (found >= 0) return found
        }
      }
      return Math.min(index, pages.length - 1)
    })
  }, [pages])

  // 上报给外层：页面结构与当前页（左侧栏镜像 + 高亮）。
  const onPagesStateRef = useRef(onPagesState)
  onPagesStateRef.current = onPagesState
  useEffect(() => {
    onPagesStateRef.current?.({ pages, current })
  }, [pages, current])

  // 跳转：左侧栏点区块（pageKey 优先）或点文件（首个区块）。
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const lastFocusNonce = useRef<number>()
  useEffect(() => {
    if (focus === undefined || focus.nonce === lastFocusNonce.current) return
    lastFocusNonce.current = focus.nonce
    let target = focus.pageKey === undefined ? -1 : pagesRef.current.findIndex(page => page.key === focus.pageKey)
    if (target < 0) target = pagesRef.current.findIndex(page => page.file.path === focus.path)
    if (target >= 0) setCurrent(target)
  }, [focus])

  const page = pages[current]
  const pageKey = page === undefined ? undefined : page.key
  const pageRead = pageKey !== undefined && paged[pageKey] === true

  // DOM 实测校准：仅当页面行数足够多时，用实际渲染行高微调打包比例，
  // 并把比例限制在 [0.8, 1.2]，避免时序异常把预算压到极小。
  useEffect(() => {
    if (page === undefined || page.rows.length < 5) return
    const rowsEl = rowsInnerRef.current
    const actualRows = rowsEl?.getBoundingClientRect().height ?? 0
    if (actualRows < 40) return
    let predictedRows = 0
    for (const row of page.rows) predictedRows += rowHeightOf(row)
    if (predictedRows <= 0) return
    const next = predictedRows / actualRows
    if (next < 0.8 || next > 1.2) return
    setRowScale(previous => (Math.abs(previous - next) < 0.02 ? previous : next))
    const labelEl = labelRef.current
    const actualLabel = labelEl?.getBoundingClientRect().height ?? 0
    if (actualLabel > 4) {
      setLabelH(previous => (Math.abs(previous - actualLabel) < 1 ? previous : actualLabel))
    }
  }, [page])

  // 前后切换（区块导航）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'ArrowRight') { event.preventDefault(); setCurrent(index => Math.min(pages.length - 1, index + 1)) }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); setCurrent(index => Math.max(0, index - 1)) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [pages.length])

  const go = useCallback((next: number) => {
    setCurrent(Math.max(0, Math.min(pages.length - 1, next)))
  }, [pages.length])

  const intraline = useMemo(() => createIntralineRenderer(page?.rows ?? []), [page?.rows])
  const pageTexts = useMemo(() => (page === undefined ? [] : page.rows.map(row => row.text)), [page])
  const tokens = useSyntaxTokens(baseUrl, page?.file.path ?? '', pageTexts)

  if (files.length === 0) {
    return (
      <div style={emptyStyle}>
        {manifest.files.length === 0 ? '该 PR 没有可展示的文件改动' : '没有匹配的文件'}
      </div>
    )
  }
  // 隐藏已读 + 全部文件已读：不必等分页加载，直接给完成态。
  const allFilesRead = hideRead && manifest.files.length > 0 && manifest.files.every(file => viewedFiles.has(file.path))
  if (hideRead && allFilesRead) {
    return <DoneOverlay title="所有文件都已标记为已读" canUndo={canUndo} onUndo={onUndo} onShowRead={onShowRead} />
  }
  if (loaded !== undefined && loaded.done < loaded.total) {
    return (
      <div style={emptyStyle}>
        <StatusDot tone="accent" pulse />
        <span>正在准备分页…（{loaded.done}/{loaded.total} 文件）</span>
      </div>
    )
  }
  if (rawPages.length === 0) {
    return <div style={emptyStyle}>该 PR 没有可展示的文本变更区块</div>
  }
  // 隐藏已读开启后所有区块都被过滤掉：给“完成态”，并提供撤销/重新显示入口。
  if (pages.length === 0) {
    const filteredAllRead = files.length > 0 && files.every(file => viewedFiles.has(file.path))
    return (
      <DoneOverlay
        title={filteredAllRead ? '过滤出的文件都已标记为已读（可调整过滤条件或关闭隐藏）' : `所有区块都已标记为已读（共 ${rawPages.length} 个区块）`}
        canUndo={canUndo}
        onUndo={onUndo}
        onShowRead={onShowRead}
        showLabel={filteredAllRead ? '显示已读文件' : '显示已读区块'}
      />
    )
  }

  const readCount = pages.filter(candidate => paged[candidate.key] === true).length

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: C_SURFACE }}>
      <div ref={setContentEl} style={contentStyle} key={pageKey}>
        {page !== undefined && (
          <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
            <div ref={labelRef} style={fileLabelStyle(pageRead)}>
              <span style={{ ...fileStatusStyle, color: statusTone(page.file.status) }} title={statusLabel(page.file.status)}>{statusLetter(page.file.status)}</span>
              <strong style={filePathStyle} title={page.file.path}>{page.file.path}</strong>
              {pageRead && <span style={readChipStyle}>已读</span>}
            </div>
            <div style={rowsScrollStyle}>
              <div ref={rowsInnerRef} style={{ width: 'max-content', minWidth: '100%' }}>
                {page.rows.map((row, index) => (
                  <div key={index} role="row" style={diffRowStyle(row.kind)}>
                    <PageRowCells row={row} intraline={intraline} index={index} tokensOf={tokens.get} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <footer style={footerStyle}>
        <button type="button" className="dshw-btn-ghost" style={navButtonStyle} aria-label="上一区块" title="上一区块（←）" disabled={current <= 0} onClick={() => { go(current - 1) }}>‹</button>
        <span style={pageIndicatorStyle} title={`已读 ${String(readCount)} / ${String(pages.length)} 区块`}>
          区块 {current + 1} / {pages.length}
          {readCount > 0 && <span style={readCountStyle}>· 已读 {readCount}</span>}
        </span>
        <button type="button" className="dshw-btn-ghost" style={navButtonStyle} aria-label="下一区块" title="下一区块（→）" disabled={current >= pages.length - 1} onClick={() => { go(current + 1) }}>›</button>
        <div style={{ flex: 1 }} />
        <button type="button" className="dshw-btn-ghost" style={skipButtonStyle} title="忽略，不做标记并查看下一区块" disabled={current >= pages.length - 1} onClick={() => { go(current + 1) }}>
          忽略
        </button>
        {pageKey !== undefined && (
          <button
            type="button"
            style={readButtonStyle}
            title={pageRead ? '该区块已读，前往下一区块' : '标记为已读并前往下一区块'}
            onClick={() => {
              if (!pageRead) onTogglePage(pageKey, true)
              go(current + 1)
            }}
          >
            已读
          </button>
        )}
      </footer>
    </div>
  )
}

function PageRowCells({ row, intraline, index, tokensOf }: {
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
        : <code style={codeTextStyle}>{segments === undefined || row.kind === 'context' ? (row.text === '' ? ' ' : row.text) : <PageIntralineText segments={segments} kind={row.kind} />}</code>}
    </>
  )
}

function PageIntralineText({ segments, kind }: { segments: readonly IntralineSegment[]; kind: 'added' | 'removed' }): ReactNode {
  return segments.map((segment, index) => segment.changed
    ? <span key={index} style={inlineChangeStyle(kind)}>{segment.text}</span>
    : segment.text)
}

/** 隐藏已读后没有可继续浏览的区块：完成态 + 撤销/重新显示入口。 */
function DoneOverlay({ title, canUndo, onUndo, onShowRead, showLabel }: {
  title: string
  canUndo?: boolean
  onUndo?: () => void
  onShowRead?: () => void
  showLabel?: string
}): ReactNode {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: C_SURFACE, color: C_MUTED, fontSize: 12.5 }}>
      <span>{title}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" className="dshw-btn-ghost" style={doneButtonStyle} disabled={!canUndo} onClick={onUndo} title="撤销上一步（⌘Z / Ctrl+Z）">撤销</button>
        <button type="button" style={doneButtonStyle} onClick={onShowRead} title="关闭隐藏已读，重新显示所有区块">{showLabel ?? '显示已读区块'}</button>
      </div>
    </div>
  )
}

/* ── styles ── */

const emptyStyle: CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 12.5, color: C_MUTED, minHeight: 0 }

const contentStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  background: C_SURFACE,
}

const fileLabelStyle = (read: boolean): CSSProperties => ({
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: LABEL_HEIGHT,
  padding: '0 8px',
  boxSizing: 'border-box',
  background: read ? 'rgba(56, 138, 52, .10)' : C_HOVER,
  borderBottom: `1px solid ${C_BORDER}`,
})

const fileStatusStyle: CSSProperties = { flex: 'none', width: 18, textAlign: 'center', fontWeight: 700, fontSize: 12 }

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

const readChipStyle: CSSProperties = { flex: 'none', marginLeft: 'auto', fontSize: 11, color: '#388a34', fontWeight: 600 }

/** 行容器不设内部滚动条：长行溢出交给外层横向滚动，避免内部滚动条
 *  偷走竖向空间导致行被裁或高度估算失准。 */
const rowsScrollStyle: CSSProperties = { display: 'block' }

const lineNumberCellStyle: CSSProperties = {
  flex: 'none', width: 44, textAlign: 'right', paddingRight: 8, color: C_SECONDARY, userSelect: 'none',
}

const hunkTextStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 12, color: '#0b4a9c', whiteSpace: 'pre' }

const codeTextStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 12, lineHeight: `${ROW_HEIGHT}px`, whiteSpace: 'pre', color: C_TEXT }

function diffRowStyle(kind: ReviewDiffRow['kind']): CSSProperties {
  const base: CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 8px' }
  if (kind === 'hunk') return { ...base, height: HUNK_HEIGHT, background: '#ddf4ff' }
  if (kind === 'added') return { ...base, height: ROW_HEIGHT, background: 'rgba(46, 160, 96, .11)' }
  if (kind === 'removed') return { ...base, height: ROW_HEIGHT, background: 'rgba(226, 78, 78, .11)' }
  return { ...base, height: ROW_HEIGHT, background: C_SURFACE }
}

const footerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 48,
  padding: '0 10px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${C_BORDER}`,
  background: C_SURFACE,
}

const navButtonStyle: CSSProperties = { width: 28, height: 28, fontSize: 18, lineHeight: 1, borderRadius: 6, color: C_SECONDARY, flex: 'none' }

const pageIndicatorStyle: CSSProperties = { fontSize: 12, color: C_SECONDARY, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }

const readCountStyle: CSSProperties = { color: '#388a34' }

const skipButtonStyle: CSSProperties = {
  height: 30,
  minWidth: 'min(104px, 22vw)',
  padding: '0 20px',
  borderRadius: 6,
  fontSize: 13,
  color: C_SECONDARY,
  textAlign: 'center',
  whiteSpace: 'nowrap',
}

const readButtonStyle: CSSProperties = {
  height: 30,
  minWidth: 'min(104px, 22vw)',
  padding: '0 20px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  color: '#ffffff',
  background: C_ACCENT,
  textAlign: 'center',
  whiteSpace: 'nowrap',
}

const doneButtonStyle: CSSProperties = {
  height: 28,
  padding: '0 14px',
  borderRadius: 6,
  fontSize: 12.5,
  color: C_TEXT,
  background: C_HOVER,
  border: `1px solid ${C_BORDER}`,
}

function inlineChangeStyle(kind: 'added' | 'removed'): CSSProperties {
  return kind === 'added'
    ? { background: 'rgba(46, 160, 96, .28)', color: '#0b5423', borderRadius: 2 }
    : { background: 'rgba(226, 78, 78, .28)', color: '#8b1a1a', borderRadius: 2 }
}
