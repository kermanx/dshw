/** Review detail workspace (angry-turtle-review port, dshw styled).
 *  Rendered inside the kanban view area; a back button returns to the list. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  JobRecord,
  ReviewDiffFile,
  ReviewDiffManifest,
  ReviewDiffPayload,
  ReviewDiffRow,
  ReviewRequestRecord,
} from '../../../src/types.ts'
import { findWorkingReview } from '../data.ts'
import type { KanbanSnapshot } from '../data.ts'
import { useReviewDiff, useReviewDiffPayload } from '../review/use-review-diff.ts'
import { createIntralineRenderer } from '../review/intraline.ts'
import type { IntralineSegment } from '../review/intraline.ts'
import { useVirtualRange } from '../review/virtual.ts'
import { DiffMinimap } from '../review/diff-minimap.tsx'
import { statusTone, statusLabel, statusLetter } from '../review/diff-status.ts'
import { GCaretRight, GCaretDown, GAlert, StatusDot } from '../icons.tsx'
import { C_ACCENT, C_BORDER, C_DANGER, C_HOVER, C_LINK, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, FONT_MONO } from '../theme.ts'

/** Read-status state: changed-file path → fingerprint of the diff last read. */
type ViewedMap = Record<string, string>

const HISTORY_LIMIT = 100
const FILE_ROW_HEIGHT = 30
const DIFF_ROW_HEIGHT = 23
const DIFF_HUNK_HEIGHT = 26
const OVERSCAN = 12

const fileTreeStyle = { flex: 'none', width: 260, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C_BORDER}`, background: C_SURFACE } as const
const diffPaneStyle = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: C_SURFACE } as const

export interface ReviewDetailProps {
  baseUrl: string
  review: ReviewRequestRecord
  snapshot?: KanbanSnapshot
  pending: ReadonlySet<string>
  showToast: (message: string, bad?: boolean) => void
  post: (path: string, body: object, key: string) => Promise<void>
  onBack: () => void
  openReviewWorkerPicker: (repoSlug: string, prNumber: number) => void
  openJob: (job: JobRecord) => void
}

export function ReviewDetailView({ baseUrl, review, snapshot, showToast, onBack, openReviewWorkerPicker, openJob }: ReviewDetailProps): ReactNode {
  const detail = useReviewDiff(baseUrl, review)
  const working = snapshot === undefined ? undefined : findWorkingReview(review, snapshot.jobs)
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: C_SURFACE }} data-dshw-kanban="root">
      <header style={detailHeaderStyle}>
        <button type="button" data-dshw-kanban="trigger" className="dshw-btn-ghost" style={backButtonStyle} onClick={onBack}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>←</span>
          <span>返回 Reviews</span>
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={detailTitleStyle}>
            <span style={detailNumberStyle}>#{review.number}</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{review.title}</span>
            {working !== undefined && <span style={chatStatusChipStyle}>AI 对话中</span>}
          </div>
          <div style={detailSubtitleStyle}>
            <span>@{review.author}</span>
            <span>·</span>
            <span title={review.headRefName}>{review.headRefName} → {review.baseRefName}</span>
            <span>·</span>
            <a style={{ color: C_LINK }} href={review.url} target="_blank" rel="noreferrer">打开 PR ↗</a>
          </div>
        </div>
        <button
          type="button"
          className="dshw-btn-ghost"
          style={chatButtonStyle}
          title={working !== undefined ? '打开 Review 对话（AI 聊天）' : '发起一个 Review 对话（AI 聊天）'}
          onClick={() => { if (working !== undefined) openJob(working); else openReviewWorkerPicker(review.repoSlug, review.number) }}
        >
          {working !== undefined ? <StatusDot tone="accent" pulse /> : <span style={chatIdleDotStyle} />}
          <span>{working !== undefined ? '对话中 · 查看' : '发起 Review 对话'}</span>
        </button>
        <button type="button" data-dshw-kanban="icon" className="dshw-icon" aria-label="刷新 diff" title="刷新 diff（重新同步本地克隆并计算差异）" onClick={detail.refresh} style={iconButtonStyle}>
          <span style={refreshGlyphStyle}>⟳</span>
        </button>
      </header>
      {detail.error !== undefined && (
        <div style={errorBannerStyle}>
          <span style={{ display: 'inline-flex', flex: 'none', color: C_DANGER }}><GAlert size={13} /></span>
          <span style={{ minWidth: 0 }}>{detail.error}</span>
          <button type="button" className="dshw-link" style={{ flex: 'none', color: C_LINK }} onClick={detail.refresh}>重试</button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <DiffBrowser baseUrl={baseUrl} review={review} manifest={detail.manifest} loading={detail.loading} error={detail.error} showToast={showToast} />
      </div>
    </div>
  )
}

function DiffBrowser({ baseUrl, review, manifest, loading, error, showToast }: {
  baseUrl: string
  review: ReviewRequestRecord
  manifest?: ReviewDiffManifest
  loading: boolean
  error?: string
  showToast: (message: string, bad?: boolean) => void
}): ReactNode {
  const files = manifest?.files ?? []
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(files[0]?.index)
  const selected = files.find(file => file.index === selectedIndex) ?? files[0]
  // Read-status lives in the daemon data directory; the manifest carries the
  // server-reconciled map (files whose diff changed since they were read were
  // already unviewed). Toggles are PUT there; undo/redo replay snapshots.
  const [viewedMap, setViewedMap] = useState<ViewedMap>(() => manifest?.viewed ?? {})
  const viewedMapRef = useRef(viewedMap)
  viewedMapRef.current = viewedMap
  const viewed = useMemo(() => new Set(Object.keys(viewedMap)), [viewedMap])
  const fpByPath = useMemo(() => new Map(files.map(file => [file.path, file.fingerprint])), [files])
  const undoStack = useRef<ViewedMap[]>([])
  const redoStack = useRef<ViewedMap[]>([])

  // A new manifest (fresh head / re-open) replaces the map and resets history.
  useEffect(() => {
    const next = manifest?.viewed ?? {}
    setViewedMap(next)
    undoStack.current = []
    redoStack.current = []
  }, [manifest])

  useEffect(() => {
    setSelectedIndex(current => files.some(file => file.index === current) ? current : files[0]?.index)
  }, [files])

  const sendViewed = useCallback((next: ViewedMap): void => {
    void fetch(`${baseUrl}/api/reviews/${review.repoSlug}/${String(review.number)}/viewed`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ total: files.length, viewed: next }),
    }).then(async response => {
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(value.error ?? `HTTP ${response.status}`)
      }
    }).catch((error: unknown) => {
      showToast(`保存已读状态失败：${error instanceof Error ? error.message : String(error)}`, true)
    })
  }, [baseUrl, files.length, review.repoSlug, review.number, showToast])

  const applyViewed = useCallback((next: ViewedMap): void => {
    setViewedMap(next)
    sendViewed(next)
  }, [sendViewed])

  const undo = useCallback((): void => {
    const previous = undoStack.current.pop()
    if (previous === undefined) return
    redoStack.current = [...redoStack.current, viewedMapRef.current].slice(-HISTORY_LIMIT)
    applyViewed(previous)
  }, [applyViewed])

  const redo = useCallback((): void => {
    const next = redoStack.current.pop()
    if (next === undefined) return
    undoStack.current = [...undoStack.current, viewedMapRef.current].slice(-HISTORY_LIMIT)
    applyViewed(next)
  }, [applyViewed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) return
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key.toLocaleLowerCase()
      if (key === 'z' && event.shiftKey) { event.preventDefault(); redo() }
      else if (key === 'z') { event.preventDefault(); undo() }
      else if (key === 'y') { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [undo, redo])

  const markViewed = useCallback((paths: readonly string[], value: boolean): void => {
    setViewedMap(current => {
      let changed = false
      const next = { ...current }
      for (const path of paths) {
        if (value) {
          const fingerprint = fpByPath.get(path) ?? ''
          if (current[path] !== fingerprint) { next[path] = fingerprint; changed = true }
        } else if (path in current) {
          delete next[path]
          changed = true
        }
      }
      if (!changed) return current
      undoStack.current = [...undoStack.current, current].slice(-HISTORY_LIMIT)
      redoStack.current = []
      void sendViewed(next)
      return next
    })
  }, [fpByPath, sendViewed])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized === '' ? files : files.filter(file => file.path.toLocaleLowerCase().includes(normalized))
  }, [files, query])

  if (loading && manifest === undefined) {
    return (
      <div style={diffEmptyStyle}>
        <StatusDot tone="accent" pulse />
        <span>正在准备本地克隆并计算 diff…</span>
      </div>
    )
  }
  if (error !== undefined && manifest === undefined) {
    return <div style={diffEmptyStyle}>获取 diff 失败，请点击上方“重试”</div>
  }
  if (manifest !== undefined && files.length === 0) {
    return <div style={diffEmptyStyle}>该 PR 没有可展示的文件改动</div>
  }
  return (
    <>
      <aside style={fileTreeStyle}>
        <div style={fileSearchRowStyle}>
          <input
            data-dshw-kanban="input"
            style={fileSearchStyle}
            value={query}
            placeholder="过滤文件…"
            onChange={event => { setQuery(event.currentTarget.value); setSelectedIndex(filtered[0]?.index) }}
          />
        </div>
        <div style={fileTreeScrollStyle} role="tree" aria-label="变更文件">
          <FileTree files={filtered} selectedIndex={selected?.index} viewed={viewed} onSelect={setSelectedIndex} onViewedMany={markViewed} expandFiltered={query.trim() !== ''} />
        </div>
      </aside>
      <section style={diffPaneStyle}>
        {selected === undefined
          ? <div style={diffEmptyStyle}>没有匹配的文件</div>
          : <FileDiff baseUrl={baseUrl} review={review} manifest={manifest!} file={selected} viewed={viewed} onViewed={markViewed} onPrev={selectedIndex === undefined ? undefined : () => { const i = filtered.findIndex(f => f.index === selectedIndex); setSelectedIndex(filtered[Math.max(0, i - 1)]?.index) }} onNext={selectedIndex === undefined ? undefined : () => { const i = filtered.findIndex(f => f.index === selectedIndex); setSelectedIndex(filtered[Math.min(filtered.length - 1, i + 1)]?.index) }} />}
      </section>
    </>
  )
}

function FileTree({ files, selectedIndex, selectedPath, viewed, onSelect, onViewedMany, expandFiltered }: {
  files: readonly ReviewDiffFile[]
  selectedIndex: number | undefined
  selectedPath?: string
  viewed: ReadonlySet<string>
  onSelect: (index: number) => void
  onViewedMany: (paths: readonly string[], value: boolean) => void
  expandFiltered: boolean
}): ReactNode {
  const tree = useMemo(() => buildFileTree(files), [files])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (selectedPath === undefined) return
    setCollapsed(current => expandAncestors(current, selectedPath))
  }, [selectedPath])
  useEffect(() => {
    if (!expandFiltered) return
    setCollapsed(current => expandAll(current, tree))
  }, [expandFiltered, tree])
  const rows = useMemo(() => flattenTree(tree, collapsed), [collapsed, tree])
  const dirViewed = useMemo(() => countViewedDirs(files, viewed), [files, viewed])
  const toggle = useCallback((path: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  return (
    <div>
      {rows.map(row => {
        const node = row.node
        return node.kind === 'directory'
          ? (
            <div key={node.key} role="treeitem" aria-expanded={!collapsed.has(node.path)} style={treeRowStyle(row.level, true)} data-dshw-kanban="reviewtree" onClick={() => { toggle(node.path) }}>
              {collapsed.has(node.path) ? <GCaretRight size={12} /> : <GCaretDown size={12} />}
              <Checkbox indeterminate={dirViewed.get(node.path)! > 0 && dirViewed.get(node.path)! < node.fileCount} checked={dirViewed.get(node.path) === node.fileCount} label={`标记目录已读（${node.path}）`} onChange={value => { onViewedMany(collectPaths(node), value) }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{node.name}</span>
              <span style={treeCountStyle}>{node.fileCount}</span>
            </div>
          )
          : (
            <div key={node.key} role="treeitem" aria-selected={node.file.index === selectedIndex} data-selected={node.file.index === selectedIndex || undefined} style={treeRowStyle(row.level, false, node.file.index === selectedIndex)} data-dshw-kanban="reviewtree" onClick={(event) => { if (event.target instanceof Element && event.target.closest('[data-dshw-kanban="reviewcheck"]') !== null) return; onSelect(node.file.index) }}>
              <span style={fileStatusStyle(node.file.status)} title={statusLabel(node.file.status)}>{statusLetter(node.file.status)}</span>
              <Checkbox dataAttr="reviewcheck" checked={viewed.has(node.file.path)} label={`标记已读（${node.file.path}）`} onChange={value => { onViewedMany([node.file.path], value) }} />
              <span style={treeFileNameStyle} title={node.file.path}>{node.name}</span>
            </div>
          )
      })}
    </div>
  )
}

function Checkbox({ checked, indeterminate = false, label, onChange, dataAttr }: {
  checked: boolean
  indeterminate?: boolean
  label: string
  onChange: (value: boolean) => void
  dataAttr?: string
}): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current !== null) ref.current.indeterminate = indeterminate }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      data-dshw-kanban={dataAttr ?? 'reviewcheck'}
      checked={checked}
      aria-label={label}
      title={label}
      style={{ flex: 'none', margin: 0, accentColor: C_ACCENT, cursor: 'pointer' }}
      onClick={event => { event.stopPropagation() }}
      onChange={event => { onChange(event.currentTarget.checked) }}
    />
  )
}

function FileDiff({ baseUrl, review, manifest, file, viewed, onViewed, onPrev, onNext }: {
  baseUrl: string
  review: ReviewRequestRecord
  manifest: ReviewDiffManifest
  file: ReviewDiffFile
  viewed: ReadonlySet<string>
  onViewed: (paths: readonly string[], value: boolean) => void
  onPrev: (() => void) | undefined
  onNext: (() => void) | undefined
}): ReactNode {
  const payloadState = useReviewDiffPayload(baseUrl, review, manifest, file.index)
  const payload = payloadState.payload
  return (
    <>
      <div style={diffHeaderStyle}>
        <span style={fileStatusStyle(file.status)} title={statusLabel(file.status)}>{statusLetter(file.status)}</span>
        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontSize: 12, fontWeight: 600, color: C_TEXT }}>{file.path}</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flex: 'none' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: C_SECONDARY, cursor: 'pointer' }}>
            <Checkbox checked={viewed.has(file.path)} label={`标记已读（${file.path}）`} onChange={value => { onViewed([file.path], value) }} />
            <span>已读</span>
          </label>
          <button type="button" data-dshw-kanban="icon" className="dshw-icon" style={diffNavStyle} aria-label="上一个文件" disabled={onPrev === undefined} onClick={onPrev}>‹</button>
          <button type="button" data-dshw-kanban="icon" className="dshw-icon" style={diffNavStyle} aria-label="下一个文件" disabled={onNext === undefined} onClick={onNext}>›</button>
        </div>
      </div>
      {payloadState.loading && <div style={diffEmptyStyle}><StatusDot tone="accent" pulse /><span>正在加载文件 diff…</span></div>}
      {payloadState.error !== undefined && <div style={diffEmptyStyle}>加载失败：{payloadState.error}</div>}
      {payload !== undefined && (payload.kind === 'unavailable'
        ? <div style={diffEmptyStyle}>{payload.reason ?? '该文件没有可展示的文本改动'}</div>
        : <DiffRows payload={payload} />)}
    </>
  )
}

/** Render a single token (words) for intraline seg. */
function DiffRows({ payload }: { payload: Extract<ReviewDiffPayload, { kind: 'text' }> }): ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const [scrolledTo, setScrolledTo] = useState<number | undefined>(undefined)
  const rows = payload.rows
  const intraline = useMemo(() => createIntralineRenderer(rows), [rows])
  const heights = useMemo(() => rows.map(row => row.kind === 'hunk' ? DIFF_HUNK_HEIGHT : DIFF_ROW_HEIGHT), [rows])
  const virtual = useVirtualRange(heights, parentRef)
  const start = Math.max(0, virtual.start - OVERSCAN)
  const end = Math.min(rows.length, virtual.end + OVERSCAN)

  const navigate = useCallback((rowIndex: number) => {
    setScrolledTo(rowIndex)
    const element = parentRef.current
    if (element === null) return
    element.scrollTop = (virtual.offsets[rowIndex] ?? 0) - element.clientHeight / 2
  }, [virtual.offsets])

  const viewport = useMemo(() => ({ startIndex: virtual.start, endIndex: Math.max(virtual.start, virtual.end - 1) }), [virtual.start, virtual.end])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', minWidth: 0 }}>
      <div ref={parentRef} style={diffScrollStyle} role="grid" aria-rowcount={rows.length}>
        <div style={{ position: 'relative', height: virtual.totalHeight, minWidth: '100%' }}>
          {rows.slice(start, end).map((row, offset) => {
            const index = start + offset
            return (
              <div key={index} role="row" aria-rowindex={index + 1} data-active={scrolledTo === index || undefined} style={{ ...diffRowPositionStyle(virtual.offsets[index] ?? 0), ...diffKindRowStyle(row.kind) }} data-dshw-kanban="reviewrow">
                <DiffRowContent row={row} intraline={intraline} index={index} />
              </div>
            )
          })}
        </div>
      </div>
      <DiffMinimap
        rows={rows}
        file={payload.file}
        comments={[]}
        scrollRef={parentRef}
        scrollId={parentRef.current?.id ?? 'review-diff'}
        onNavigate={navigate}
        viewport={viewport}
        label="diff 概览"
        hint="点击或拖动跳转"
        description="diff 概览"
        positionLabel={percent => `已浏览 ${String(percent)}%`}
      />
    </div>
  )
}

function DiffRowContent({ row, intraline, index }: { row: ReviewDiffRow; intraline: ReturnType<typeof createIntralineRenderer>; index: number }): ReactNode {
  if (row.kind === 'hunk') return <span style={hunkTextStyle}>{row.text}</span>
  const segments = intraline.segmentsFor(index)
  const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '
  return (
    <>
      <span style={{ flex: 'none', width: 44, textAlign: 'right', paddingRight: 8, color: C_SECONDARY, userSelect: 'none' }}>{row.oldLine ?? ''}</span>
      <span style={{ flex: 'none', width: 44, textAlign: 'right', paddingRight: 8, color: C_SECONDARY, userSelect: 'none' }}>{row.newLine ?? ''}</span>
      <span style={{ flex: 'none', width: 16, textAlign: 'center', color: row.kind === 'added' ? C_DANGER : row.kind === 'removed' ? C_DANGER : C_SECONDARY, userSelect: 'none' }}>{sign}</span>
      <code style={codeTextStyle}>{segments === undefined || row.kind === 'context' ? (row.text === '' ? ' ' : row.text) : <IntralineText segments={segments} kind={row.kind} />}</code>
    </>
  )
}

function IntralineText({ segments, kind }: { segments: readonly IntralineSegment[]; kind: 'added' | 'removed' }): ReactNode {
  return segments.map((segment, index) => segment.changed
    ? <span key={index} style={inlineChangeStyle(kind)}>{segment.text}</span>
    : segment.text)
}

/* ── tree building + viewed persistence helpers ── */

interface TreeNodeDir {
  kind: 'directory'
  key: string
  name: string
  path: string
  fileCount: number
  children: readonly TreeNode[]
}
interface TreeNodeFile { kind: 'file'; key: string; name: string; file: ReviewDiffFile }
type TreeNode = TreeNodeDir | TreeNodeFile
interface MutableDir { name: string; path: string; directories: Map<string, MutableDir>; files: TreeNodeFile[] }

function buildFileTree(files: readonly ReviewDiffFile[]): readonly TreeNode[] {
  const root: MutableDir = { name: '', path: '', directories: new Map(), files: [] }
  for (const file of files) {
    const segments = file.path.split('/')
    const name = segments.pop() ?? file.path
    let parent = root
    for (const segment of segments) {
      const path = parent.path === '' ? segment : `${parent.path}/${segment}`
      const existing = parent.directories.get(segment)
      if (existing !== undefined) { parent = existing; continue }
      const dir: MutableDir = { name: segment, path, directories: new Map(), files: [] }
      parent.directories.set(segment, dir)
      parent = dir
    }
    parent.files.push({ kind: 'file', key: `file:${String(file.index)}`, name, file })
  }
  return finalize(root).children
}

function finalize(dir: MutableDir): TreeNodeDir {
  const directories = [...dir.directories.values()].map(finalize).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  dir.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const children: TreeNode[] = [...directories, ...dir.files]
  return { kind: 'directory', key: `dir:${dir.path}`, name: dir.name, path: dir.path, fileCount: children.reduce((count, child) => count + (child.kind === 'file' ? 1 : child.fileCount), 0), children }
}

function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>, level = 1, rows: Array<{ node: TreeNode; level: number }> = []): Array<{ node: TreeNode; level: number }> {
  for (const node of nodes) {
    rows.push({ node, level })
    if (node.kind === 'directory' && !collapsed.has(node.path)) flattenTree(node.children, collapsed, level + 1, rows)
  }
  return rows
}

function expandAncestors(collapsed: ReadonlySet<string>, filePath: string): ReadonlySet<string> {
  const next = new Set(collapsed)
  let changed = false
  const segments = filePath.split('/').slice(0, -1)
  for (let i = 0; i < segments.length; i += 1) changed = next.delete(segments.slice(0, i + 1).join('/')) || changed
  return changed ? next : collapsed
}

function expandAll(collapsed: ReadonlySet<string>, nodes: readonly TreeNode[]): ReadonlySet<string> {
  const next = new Set(collapsed)
  let changed = false
  const visit = (children: readonly TreeNode[]): void => {
    for (const child of children) {
      if (child.kind !== 'directory') continue
      changed = next.delete(child.path) || changed
      visit(child.children)
    }
  }
  visit(nodes)
  return changed ? next : collapsed
}

function countViewedDirs(files: readonly ReviewDiffFile[], viewed: ReadonlySet<string>): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const file of files) {
    if (!viewed.has(file.path)) continue
    const segments = file.path.split('/').slice(0, -1)
    for (let i = 0; i < segments.length; i += 1) { const path = segments.slice(0, i + 1).join('/'); counts.set(path, (counts.get(path) ?? 0) + 1) }
  }
  return counts
}

function collectPaths(dir: TreeNodeDir): readonly string[] {
  const paths: string[] = []
  const stack: TreeNode[] = [...dir.children]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    if (node.kind === 'file') paths.push(node.file.path)
    else stack.push(...node.children)
  }
  return paths
}

/* ── inline styles ── */
const detailHeaderStyle: CSSProperties = {
  flex: 'none', display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, padding: '0 12px', boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`, background: C_SURFACE,
}
const backButtonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px', borderRadius: 6, flex: 'none', color: C_TEXT, fontSize: 12.5, fontWeight: 500 }
const chatButtonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, height: 28, padding: '0 10px', borderRadius: 6, flex: 'none', color: C_ACCENT, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }
const chatIdleDotStyle: CSSProperties = { width: 8, height: 8, borderRadius: '50%', background: C_SECONDARY, flex: 'none' }
const chatStatusChipStyle: CSSProperties = { flex: 'none', padding: '0 6px', height: 18, boxSizing: 'border-box', borderRadius: 3, background: C_ACCENT, color: '#ffffff', fontSize: 11, fontWeight: 600, lineHeight: '18px', whiteSpace: 'nowrap' }
const detailTitleStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: C_TEXT, lineHeight: '20px', minWidth: 0 }
const detailNumberStyle: CSSProperties = { flex: 'none', color: C_MUTED, fontWeight: 500, fontSize: 12 }
const detailSubtitleStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C_SECONDARY, minWidth: 0 }
const iconButtonStyle: CSSProperties = { width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: C_SECONDARY, flex: 'none' }
const refreshGlyphStyle: CSSProperties = { fontSize: 16, lineHeight: 1 }
const errorBannerStyle: CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 7, minHeight: 32, padding: '0 12px', borderBottom: `1px solid ${C_BORDER}`, fontSize: 12, color: C_DANGER, background: 'rgba(161, 38, 13, .08)' }
const diffEmptyStyle: CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 0, fontSize: 12.5, color: C_MUTED }
const fileSearchRowStyle: CSSProperties = { flex: 'none', padding: 8, borderBottom: `1px solid ${C_BORDER}` }
const fileSearchStyle: CSSProperties = { width: '100%', height: 28, padding: '0 8px', boxSizing: 'border-box', border: `1px solid ${C_BORDER}`, borderRadius: 4, outline: 'none', background: C_SURFACE, fontFamily: 'inherit', fontSize: 12, color: C_TEXT }
const fileTreeScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0' }
const treeCountStyle: CSSProperties = { flex: 'none', fontSize: 11, color: C_MUTED }
const treeFileNameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1, fontFamily: FONT_MONO, fontSize: 12, color: C_TEXT }
const diffScrollStyle: CSSProperties = { flex: 1, minWidth: 0, overflow: 'auto', position: 'relative', background: C_SURFACE }
const diffHeaderStyle: CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, minHeight: 34, padding: '0 12px', borderBottom: `1px solid ${C_BORDER}`, background: C_HOVER }
const diffNavStyle: CSSProperties = { width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: C_SECONDARY, fontSize: 16, lineHeight: 1 }
const hunkTextStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 12, color: '#0b4a9c', whiteSpace: 'pre' }
const codeTextStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 12, lineHeight: `${DIFF_ROW_HEIGHT}px`, whiteSpace: 'pre', color: C_TEXT, display: 'block' }

function treeRowStyle(level: number, isDirectory: boolean, _selected = false): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6, height: FILE_ROW_HEIGHT, paddingLeft: 8 + (level - 1) * 14, paddingRight: 8,
    boxSizing: 'border-box', cursor: 'pointer', userSelect: 'none', flex: 'none',
    fontWeight: isDirectory ? 600 : 400, color: C_TEXT, fontSize: 12.5,
  }
}

function fileStatusStyle(status: ReviewDiffFile['status']): CSSProperties {
  const color = statusTone(status)
  return { flex: 'none', width: 18, textAlign: 'center', fontWeight: 700, fontSize: 12, color }
}

function diffRowPositionStyle(top: number): CSSProperties {
  return { position: 'absolute', left: 0, top, width: 'max-content' }
}

function diffKindRowStyle(kind: ReviewDiffRow['kind']): CSSProperties {
  const base: CSSProperties = { display: 'flex', alignItems: 'center', boxSizing: 'border-box', padding: '0 8px' }
  if (kind === 'hunk') return { ...base, height: DIFF_HUNK_HEIGHT, background: '#ddf4ff' }
  if (kind === 'added') return { ...base, height: DIFF_ROW_HEIGHT, background: 'rgba(46, 160, 96, .11)' }
  if (kind === 'removed') return { ...base, height: DIFF_ROW_HEIGHT, background: 'rgba(226, 78, 78, .11)' }
  return { ...base, height: DIFF_ROW_HEIGHT, background: C_SURFACE }
}

function inlineChangeStyle(kind: 'added' | 'removed'): CSSProperties {
  return kind === 'added'
    ? { background: 'rgba(46, 160, 96, .28)', color: '#0b5423', borderRadius: 2 }
    : { background: 'rgba(226, 78, 78, .28)', color: '#8b1a1a', borderRadius: 2 }
}
