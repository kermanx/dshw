/** Review detail workspace (angry-turtle-review port, dshw styled).
 *  Rendered inside the kanban view area; a back button returns to the list.
 *
 *  “隐藏已读”开关（默认开，本地记忆）：标记为已读的文件 / 区块会立即从左侧
 *  列表与右侧 diff 里消失；单文件与连续模式由本文件过滤文件列表，分页模式在
 *  PagedPane 内过滤区块。已读标记支持 撤销/重做（⌘/Ctrl+Z、⇧⌘/Ctrl+Z、⌘Y
 *  + 左侧工具栏按钮）。分页布局下左侧栏按“区块”镜像内容区。 */
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
import { changedRangesOf, useSyntaxTokens } from '../review/syntax-highlight.ts'
import type { SyntaxToken } from '../review/syntax-highlight.ts'
import { CodeSpans } from '../review/highlight-line.tsx'
import type { ReviewPage } from '../review/page-pack.ts'
import {
  CATEGORY_META, CATEGORY_ORDER, categoryOfPath, orderFilesByCategory,
  type ReviewCategoryId,
} from '../review/categories.ts'
import { ContinuousPane } from './review-continuous.tsx'
import type { ContinuousFocus } from './review-continuous.tsx'
import { PagedPane } from './review-paged.tsx'
import type { PagedStateInfo } from './review-paged.tsx'
import { GArrowLeft, GCaretRight, GCaretDown, GAlert, GComment, GExternalLink, GFileSingle, GPages, GRows, GSync, GUndo, GRedo, GEye, GEyeOff, StatusDot } from '../icons.tsx'
import { C_ACCENT, C_ACCENT_SOFT, C_BORDER, C_DANGER, C_HOVER, C_LINK, C_MUTED, C_SECONDARY, C_SUCCESS, C_SURFACE, C_TEXT, C_WARNING, FONT_MONO } from '../theme.ts'

/** Read-status state: file marks + paged-mode page marks. */
type ViewedMap = Record<string, string>
interface ReadState {
  viewed: ViewedMap
  paged: Record<string, boolean>
}

const MODE_ICON: Record<BrowseMode, ReactNode> = {
  single: <GFileSingle size={14} />,
  continuous: <GRows size={14} />,
  paged: <GPages size={14} />,
}

function readStateOf(manifest: ReviewDiffManifest | undefined): ReadState {
  return { viewed: manifest?.viewed ?? {}, paged: manifest?.paged ?? {} }
}

/** 浏览模式：单文件（每页一个）／连续浏览／分页（区块=一屏打包内容）。 */
const BROWSE_MODES = [
  { id: 'single', label: '单文件', hint: '一次看一个文件（默认）' },
  { id: 'continuous', label: '连续浏览', hint: '所有文件按顺序连在一起，可一起滚动' },
  { id: 'paged', label: '分页', hint: '一屏一个区块（自动打包能放下的变更块），可标记已读/跳过' },
] as const
type BrowseMode = typeof BROWSE_MODES[number]['id']

const HISTORY_LIMIT = 100
const FILE_ROW_HEIGHT = 30
const DIFF_ROW_HEIGHT = 23
const DIFF_HUNK_HEIGHT = 26
const OVERSCAN = 12

const HIDE_READ_KEY = 'dshw.review.hide-read'
const BROWSE_MODE_KEY = 'dshw.review.browse-mode'

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

/* ── 小工具 ── */

function loadStoredValue(key: string): string | undefined {
  try { return window.localStorage.getItem(key) ?? undefined } catch { return undefined }
}

function storeValue(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* 隐私模式等场景忽略 */ }
}

function initialBrowseMode(): BrowseMode {
  const saved = loadStoredValue(BROWSE_MODE_KEY)
  return BROWSE_MODES.some(mode => mode.id === saved) ? (saved as BrowseMode) : 'single'
}

/** “隐藏已读”默认开启；显式存过 '0' 才关闭。 */
function initialHideRead(): boolean {
  return loadStoredValue(HIDE_READ_KEY) !== '0'
}

/** 撤销/重做快捷键不能吞掉文本编辑：仅当焦点在文本框/富文本时才交给浏览器。 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('textarea, [contenteditable="true"]') !== null) return true
  const input = target.closest('input')
  if (input === null) return false
  const type = (input as HTMLInputElement).type
  switch (type) {
    case 'checkbox': case 'radio': case 'button': case 'submit': case 'reset':
    case 'range': case 'color': case 'file': case 'image': case 'hidden':
      return false
    default:
      return true // text/search/number/… 都有原生撤销
  }
}

export function ReviewDetailView({ baseUrl, review, snapshot, showToast, onBack, openReviewWorkerPicker, openJob }: ReviewDetailProps): ReactNode {
  const detail = useReviewDiff(baseUrl, review)
  const working = snapshot === undefined ? undefined : findWorkingReview(review, snapshot.jobs)
  const [browseMode, setBrowseMode] = useState<BrowseMode>(initialBrowseMode)
  const [continuousFocus, setContinuousFocus] = useState<ContinuousFocus>()
  const changeBrowseMode = useCallback((id: BrowseMode) => {
    setBrowseMode(id)
    storeValue(BROWSE_MODE_KEY, id)
  }, [])
  const requestFileFocus = useCallback((path: string, pageKey?: string) => {
    setContinuousFocus({ path, pageKey, nonce: Date.now() })
  }, [])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: C_SURFACE }} data-dshw-kanban="root">
      <header style={detailHeaderStyle}>
        <button type="button" data-dshw-kanban="icon" className="dshw-icon" aria-label="返回 Reviews" title="返回 Reviews" style={iconButtonStyle} onClick={onBack}>
          <GArrowLeft size={16} />
        </button>
        <div style={detailTitleStyle}>
          <span style={detailNumberStyle}>#{review.number}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={review.title}>{review.title}</span>
        </div>
        <div style={headerActionsStyle}>
          <div style={modeSwitchStyle} role="group" aria-label="浏览模式">
            {BROWSE_MODES.map(mode => (
              <button
                key={mode.id}
                type="button"
                data-dshw-kanban="modebtn"
                data-selected={mode.id === browseMode || undefined}
                aria-label={mode.label}
                title={mode.hint}
                style={modeIconButtonStyle(mode.id === browseMode)}
                onClick={() => { changeBrowseMode(mode.id) }}
              >
                {MODE_ICON[mode.id]}
              </button>
            ))}
          </div>
          <a
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label="在 GitHub 打开 PR"
            title="在 GitHub 打开 PR"
            style={iconButtonStyle}
            href={review.url}
            target="_blank"
            rel="noreferrer"
          >
            <GExternalLink size={14} />
          </a>
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label="刷新 diff"
            title="刷新 diff（重新同步到 GitHub 最新版本并重算）"
            style={iconButtonStyle}
            onClick={detail.refresh}
          >
            <GSync size={15} />
          </button>
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label={working !== undefined ? '打开 AI 对话' : '发起 AI 对话'}
            title={working !== undefined ? '打开 AI 对话' : '发起 AI 对话'}
            style={{ ...iconButtonStyle, ...(working !== undefined ? { color: C_ACCENT } : {}) }}
            onClick={() => { if (working !== undefined) openJob(working); else openReviewWorkerPicker(review.repoSlug, review.number) }}
          >
            {working !== undefined && <span style={chatDotStyle} data-dshw-kanban="pulse" />}
            <GComment size={16} />
          </button>
        </div>
      </header>
      {detail.error !== undefined && (
        <div style={errorBannerStyle}>
          <span style={{ display: 'inline-flex', flex: 'none', color: C_DANGER }}><GAlert size={13} /></span>
          <span style={{ minWidth: 0 }}>{detail.error}</span>
          <button type="button" className="dshw-link" style={{ flex: 'none', color: C_LINK }} onClick={detail.refresh}>重试</button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <DiffBrowser
          baseUrl={baseUrl}
          review={review}
          manifest={detail.manifest}
          loading={detail.loading}
          error={detail.error}
          showToast={showToast}
          browseMode={browseMode}
          continuousFocus={continuousFocus}
          onRequestFileFocus={requestFileFocus}
        />
      </div>
    </div>
  )
}

function DiffBrowser({ baseUrl, review, manifest, loading, error, showToast, browseMode, continuousFocus, onRequestFileFocus }: {
  baseUrl: string
  review: ReviewRequestRecord
  manifest?: ReviewDiffManifest
  loading: boolean
  error?: string
  showToast: (message: string, bad?: boolean) => void
  browseMode: BrowseMode
  continuousFocus?: ContinuousFocus
  onRequestFileFocus: (path: string, pageKey?: string) => void
}): ReactNode {
  // 类别为大的顺序层次：先按类别（源码→测试→文档→配置→其它），类别内按文件树顺序。
  const files = useMemo(() => orderFilesByCategory(manifest?.files ?? []), [manifest])
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(files[0]?.index)
  // Read-status lives in the daemon data directory; the manifest carries the
  // server-reconciled map (files whose diff changed since they were read were
  // already unviewed, and paged-mode page marks). Toggles are PUT there;
  // undo/redo replay whole snapshots (file marks + page marks).
  const [readState, setReadState] = useState<ReadState>(() => readStateOf(manifest))
  const readStateRef = useRef(readState)
  readStateRef.current = readState
  const viewed = useMemo(() => new Set(Object.keys(readState.viewed)), [readState.viewed])
  const fpByPath = useMemo(() => new Map(files.map(file => [file.path, file.fingerprint])), [files])
  const undoStack = useRef<ReadState[]>([])
  const redoStack = useRef<ReadState[]>([])
  /** 栈内容变化时自增，驱动撤销/重做按钮的可用态刷新。 */
  const [, setHistoryTick] = useState(0)

  // —— “隐藏已读”开关（默认开启，本地记忆）——
  const [hideRead, setHideRead] = useState<boolean>(initialHideRead)
  useEffect(() => {
    storeValue(HIDE_READ_KEY, hideRead ? '1' : '0')
  }, [hideRead])

  // —— 分页模式页面列表快照（PagedPane 上报，左侧栏按区块镜像）——
  const [pagedState, setPagedState] = useState<PagedStateInfo>()
  const receivePagedState = useCallback((next: PagedStateInfo) => {
    setPagedState(current => (current !== undefined && current.pages === next.pages && current.current === next.current ? current : next))
  }, [])
  // 离开分页模式时丢弃其区块快照：下次进入时左侧栏先显示“准备中”，
  // 不会闪过上一次的旧页面（进入时不清，避免冲掉 PagedPane 的首帧上报）。
  useEffect(() => {
    if (browseMode !== 'paged') setPagedState(undefined)
  }, [browseMode])

  const selectFile = useCallback((index: number) => {
    setSelectedIndex(index)
    if (browseMode === 'continuous') {
      const file = files.find(candidate => candidate.index === index)
      if (file !== undefined) onRequestFileFocus(file.path)
    }
  }, [browseMode, files, onRequestFileFocus])

  // A new manifest (fresh head / re-open) replaces the maps and resets history.
  useEffect(() => {
    setReadState(readStateOf(manifest))
    undoStack.current = []
    redoStack.current = []
    setHistoryTick(value => value + 1)
  }, [manifest])

  const sendState = useCallback((next: ReadState): void => {
    void fetch(`${baseUrl}/api/reviews/${review.repoSlug}/${String(review.number)}/viewed`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ total: files.length, viewed: next.viewed, paged: next.paged }),
    }).then(async response => {
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(value.error ?? `HTTP ${response.status}`)
      }
    }).catch((error: unknown) => {
      showToast(`保存已读状态失败：${error instanceof Error ? error.message : String(error)}`, true)
    })
  }, [baseUrl, files.length, review.repoSlug, review.number, showToast])

  const applyState = useCallback((next: ReadState): void => {
    setReadState(next)
    sendState(next)
  }, [sendState])

  const recordHistory = useCallback((previous: ReadState): void => {
    undoStack.current = [...undoStack.current, previous].slice(-HISTORY_LIMIT)
    redoStack.current = []
    setHistoryTick(value => value + 1)
  }, [])

  const undo = useCallback((): void => {
    const previous = undoStack.current.pop()
    if (previous === undefined) return
    redoStack.current = [...redoStack.current, readStateRef.current].slice(-HISTORY_LIMIT)
    setHistoryTick(value => value + 1)
    applyState(previous)
  }, [applyState])

  const redo = useCallback((): void => {
    const next = redoStack.current.pop()
    if (next === undefined) return
    undoStack.current = [...undoStack.current, readStateRef.current].slice(-HISTORY_LIMIT)
    setHistoryTick(value => value + 1)
    applyState(next)
  }, [applyState])

  // 撤销/重做快捷键。capture 阶段监听：宿主页面即使 stopPropagation 也拦不到；
  // 焦点在文本类输入框时不拦截（保留浏览器原生撤销）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTextEntryTarget(event.target)) return
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key.toLocaleLowerCase()
      if (key === 'z' && event.shiftKey) { event.preventDefault(); redo() }
      else if (key === 'z') { event.preventDefault(); undo() }
      else if (key === 'y') { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => { window.removeEventListener('keydown', onKeyDown, true) }
  }, [undo, redo])

  const markViewed = useCallback((paths: readonly string[], value: boolean): void => {
    setReadState(current => {
      let changed = false
      const viewed = { ...current.viewed }
      for (const path of paths) {
        if (value) {
          const fingerprint = fpByPath.get(path) ?? ''
          if (current.viewed[path] !== fingerprint) { viewed[path] = fingerprint; changed = true }
        } else if (path in viewed) {
          delete viewed[path]
          changed = true
        }
      }
      if (!changed) return current
      const next: ReadState = { viewed, paged: current.paged }
      recordHistory(current)
      void sendState(next)
      return next
    })
  }, [fpByPath, recordHistory, sendState])

  const markPage = useCallback((key: string, value: boolean): void => {
    setReadState(current => {
      if (current.paged[key] === value) return current
      const paged = { ...current.paged }
      if (value) paged[key] = true
      else delete paged[key]
      const next: ReadState = { viewed: current.viewed, paged }
      recordHistory(current)
      void sendState(next)
      return next
    })
  }, [recordHistory, sendState])

  // 浏览列表 = “搜索过滤后的全部文件”∩（开启隐藏时去掉已读文件）。
  const queryFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized === '' ? files : files.filter(file => file.path.toLocaleLowerCase().includes(normalized))
  }, [files, query])
  const candidates = useMemo(() => {
    return hideRead ? queryFiles.filter(file => !viewed.has(file.path)) : queryFiles
  }, [queryFiles, hideRead, viewed])

  // 选中文件跟随列表：被隐藏（标记已读）或过滤掉时，落到“补进它位置”的文件；
  // 搜索词变化 / 尚无选中时跳到首个匹配项，保持“边输边看”的旧行为。
  const prevCandidatesRef = useRef<readonly ReviewDiffFile[]>([])
  const prevQueryRef = useRef('')
  useEffect(() => {
    const previous = prevCandidatesRef.current
    prevCandidatesRef.current = candidates
    const queryChanged = prevQueryRef.current !== query
    prevQueryRef.current = query
    if (candidates.length === 0) return
    if (selectedIndex !== undefined && candidates.some(file => file.index === selectedIndex)) return
    if (selectedIndex === undefined || queryChanged || previous.length === 0) {
      setSelectedIndex(candidates[0]?.index)
      return
    }
    const oldPos = previous.findIndex(file => file.index === selectedIndex)
    if (oldPos >= 0) setSelectedIndex(candidates[Math.min(oldPos, candidates.length - 1)]?.index)
    else setSelectedIndex(candidates[0]?.index)
  }, [candidates, query, selectedIndex])

  const selected = useMemo(() => {
    if (selectedIndex === undefined) return undefined
    return candidates.find(file => file.index === selectedIndex) ?? candidates[0]
  }, [candidates, selectedIndex])

  const allFilesRead = useMemo(() => files.length > 0 && files.every(file => viewed.has(file.path)), [files, viewed])
  const hiddenCount = useMemo(() => files.reduce((count, file) => count + (viewed.has(file.path) ? 1 : 0), 0), [files, viewed])

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

  const canUndo = undoStack.current.length > 0
  const canRedo = redoStack.current.length > 0

  // 单文件/连续模式全部读完时的完成态。
  const doneOverlay = hideRead && allFilesRead
    ? <AllReadOverlay
        hiddenCount={hiddenCount}
        canUndo={canUndo}
        onUndo={undo}
        onShowRead={() => { setHideRead(false) }}
      />
    : undefined

  return (
    <>
      <aside style={fileTreeStyle}>
        <div style={fileSearchRowStyle}>
          <input
            data-dshw-kanban="input"
            style={fileSearchStyle}
            value={query}
            placeholder="过滤文件…"
            aria-label="过滤文件"
            onChange={event => { setQuery(event.currentTarget.value) }}
          />
        </div>
        <div style={treeToolsRowStyle}>
          <button
            type="button"
            data-dshw-kanban="tool"
            aria-pressed={hideRead}
            aria-label={hideRead ? '隐藏已读：已读文件/区块不出现在列表和 diff（点击关闭）' : '显示已读：全部文件/区块都出现在列表和 diff（点击开启）'}
            title={hideRead ? '已读的文件/区块不会出现在列表与 diff 中（标记已读即隐藏，默认开启）——点击关闭' : '显示全部文件/区块，包括已读的——点击开启隐藏'}
            style={hideRead ? hidePillStyle(true) : hidePillStyle(false)}
            onClick={() => { setHideRead(value => !value) }}
          >
            {hideRead ? <GEye size={12} /> : <GEyeOff size={12} />}
            <span>隐藏已读</span>
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label="撤销（⌘Z / Ctrl+Z）"
            title="撤销上一步已读标记（⌘Z / Ctrl+Z）"
            style={treeToolButtonStyle(canUndo)}
            disabled={!canUndo}
            onClick={undo}
          >
            <GUndo size={13} />
          </button>
          <button
            type="button"
            data-dshw-kanban="icon"
            className="dshw-icon"
            aria-label="重做（⇧⌘Z / ⌘Y）"
            title="重做（⇧⌘Z / ⌘Y）"
            style={treeToolButtonStyle(canRedo)}
            disabled={!canRedo}
            onClick={redo}
          >
            <GRedo size={13} />
          </button>
        </div>
        <div style={fileTreeScrollStyle} role="tree" aria-label="变更文件" data-dshw-kanban="tree-scroll">
          {browseMode === 'paged' ? (
            pagedState === undefined
              ? <div style={treeHintStyle}><StatusDot tone="accent" pulse /><span>正在准备区块…</span></div>
              : pagedState.pages.length === 0
                ? <div style={treeHintStyle}>（无未读区块）</div>
                : <PagedSidebar
                    state={pagedState}
                    paged={readState.paged}
                    viewedFiles={viewed}
                    hideRead={hideRead}
                    onTogglePage={markPage}
                    onMarkFile={markViewed}
                    onJump={pageKey => {
                      const page = pagedState.pages.find(candidate => candidate.key === pageKey)
                      if (page !== undefined) onRequestFileFocus(page.file.path, page.key)
                    }}
                  />
          ) : (
            <FileTree files={candidates} selectedIndex={selected?.index} viewed={viewed} onSelect={selectFile} onViewedMany={markViewed} expandFiltered={query.trim() !== ''} />
          )}
        </div>
      </aside>
      <section style={diffPaneStyle}>
        {browseMode === 'single' && (doneOverlay ?? (selected === undefined
          ? <div style={diffEmptyStyle}>没有匹配的文件</div>
          : <FileDiff key={selected.index} baseUrl={baseUrl} review={review} manifest={manifest!} file={selected} viewed={viewed} onViewed={markViewed} onPrev={selectedIndex === undefined ? undefined : () => { const i = candidates.findIndex(f => f.index === selectedIndex); setSelectedIndex(candidates[Math.max(0, i - 1)]?.index) }} onNext={selectedIndex === undefined ? undefined : () => { const i = candidates.findIndex(f => f.index === selectedIndex); setSelectedIndex(candidates[Math.min(candidates.length - 1, i + 1)]?.index) }} />))}
        {browseMode === 'continuous' && (doneOverlay ?? (
          <ContinuousPane
            baseUrl={baseUrl}
            review={review}
            manifest={manifest!}
            files={candidates}
            viewed={viewed}
            onViewedMany={markViewed}
            focus={continuousFocus}
            hideRead={hideRead}
          />
        ))}
        {browseMode === 'paged' && manifest !== undefined && (
          <PagedPane
            baseUrl={baseUrl}
            review={review}
            manifest={manifest}
            files={queryFiles}
            paged={readState.paged}
            viewedFiles={viewed}
            hideRead={hideRead}
            onTogglePage={markPage}
            focus={continuousFocus}
            onPagesState={receivePagedState}
            onUndo={undo}
            canUndo={canUndo}
            onShowRead={() => { setHideRead(false) }}
          />
        )}
      </section>
    </>
  )
}

/** 全部读完（且开启隐藏）时的完成态提示。 */
function AllReadOverlay({ hiddenCount, canUndo, onUndo, onShowRead }: {
  hiddenCount: number
  canUndo: boolean
  onUndo: () => void
  onShowRead: () => void
}): ReactNode {
  return (
    <div style={allReadOverlayStyle}>
      <span>所有文件都已标记为已读（{hiddenCount} 个文件）</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" style={overlayButtonStyle} disabled={!canUndo} onClick={onUndo} title="撤销上一步（⌘Z / Ctrl+Z）">撤销</button>
        <button type="button" style={{ ...overlayButtonStyle, color: C_ACCENT }} onClick={onShowRead} title="关闭“隐藏已读”，重新显示所有文件">显示已读文件</button>
      </div>
    </div>
  )
}

/** 分页模式的左侧栏：按“区块”拆开，文件作为分组头，区块作为行。 */
function PagedSidebar({ state, paged, viewedFiles, hideRead, onTogglePage, onMarkFile, onJump }: {
  state: PagedStateInfo
  paged: Readonly<Record<string, boolean>>
  viewedFiles: ReadonlySet<string>
  hideRead: boolean
  onTogglePage: (key: string, value: boolean) => void
  onMarkFile: (paths: readonly string[], value: boolean) => void
  onJump: (pageKey: string) => void
}): ReactNode {
  const segments = useMemo(() => {
    const out: Array<{ file: ReviewDiffFile; pages: ReviewPage[] }> = []
    for (const page of state.pages) {
      const last = out.length > 0 ? out[out.length - 1] : undefined
      if (last !== undefined && last.file.path === page.file.path) last.pages.push(page)
      else out.push({ file: page.file, pages: [page] })
    }
    return out
  }, [state])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const currentPage = state.pages[state.current]

  // 当前区块变化：展开所属文件并把行滚动到树的可视区内。
  useEffect(() => {
    if (currentPage === undefined) return
    const path = currentPage.file.path
    setCollapsed(current => {
      if (!current.has(path)) return current
      const next = new Set(current)
      next.delete(path)
      return next
    })
    const container = document.querySelector('[data-dshw-kanban="tree-scroll"]')
    const row = container?.querySelector(`[data-page-key="${currentPage.key}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [currentPage?.key, currentPage?.file.path])

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
      {segments.map(segment => {
        const file = segment.file
        const closed = collapsed.has(file.path)
        const fileRead = viewedFiles.has(file.path)
        const first = segment.pages[0]
        return (
          <div key={file.path}>
            <div
              role="treeitem"
              aria-expanded={!closed}
              style={treeRowStyle(1, true, false, true)}
              data-dshw-kanban="reviewtree"
              title={closed ? `展开 ${file.path} 的区块` : `收起 ${file.path} 的区块`}
              onClick={() => {
                if (closed) { setCollapsed(current => { const next = new Set(current); next.delete(file.path); return next }) }
                else if (first !== undefined) onJump(first.key)
              }}
            >
              <button
                type="button"
                data-dshw-kanban="treecaret"
                aria-label={closed ? `展开 ${file.path}` : `收起 ${file.path}`}
                style={treeCaretButtonStyle}
                onClick={(event) => { event.stopPropagation(); toggle(file.path) }}
              >
                {closed ? <GCaretRight size={12} /> : <GCaretDown size={12} />}
              </button>
              <Checkbox
                checked={fileRead}
                label={`标记已读（${file.path}）`}
                onChange={value => { onMarkFile([file.path], value) }}
              />
              <span style={{ ...treeFileNameStyle, color: statusNameColor(file.status) }} title={`${file.path}（${statusLabel(file.status)}）`}>{file.path}</span>
              <span style={{ ...treeCountStyle, marginLeft: 'auto' }} title={fileRead ? '整文件已标记已读' : `还有 ${segment.pages.length} 个区块`}>
                {fileRead ? '已读' : `${segment.pages.length} 区块`}
              </span>
            </div>
            {!closed && segment.pages.map(page => {
              const isCurrent = page.key === currentPage?.key
              const pageRead = paged[page.key] === true
              return (
                <div
                  key={page.key}
                  role="treeitem"
                  aria-selected={isCurrent}
                  data-selected={isCurrent || undefined}
                  data-page-key={page.key}
                  data-dshw-kanban="reviewtree"
                  style={treeRowStyle(2, false, isCurrent)}
                  title={`${file.path} 区块 ${String(page.ordinal)}/${String(page.filePageTotal)}`}
                  onClick={(event) => { if (event.target instanceof Element && event.target.closest('[data-dshw-kanban="reviewcheck"]') !== null) return; if (!isCurrent) onJump(page.key) }}
                >
                  <span style={treeFileLeadingStyle} aria-hidden />
                  <Checkbox checked={pageRead} label={`标记区块已读（${file.path} 区块 ${String(page.ordinal)}）`} onChange={value => { onTogglePage(page.key, value) }} />
                  <span style={isCurrent ? { ...treeFileNameStyle, color: C_ACCENT, fontWeight: 600 } : { ...treeFileNameStyle, color: C_TEXT, opacity: 0.82 }}>
                    区块 {page.ordinal}/{page.filePageTotal}
                  </span>
                  {pageRead && !hideRead && <span style={treeReadChipStyle}>已读</span>}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function FileTree({ files, selectedIndex, viewed, onSelect, onViewedMany, expandFiltered }: {
  files: readonly ReviewDiffFile[]
  selectedIndex: number | undefined
  viewed: ReadonlySet<string>
  onSelect: (index: number) => void
  onViewedMany: (paths: readonly string[], value: boolean) => void
  expandFiltered: boolean
}): ReactNode {
  // 顶层 = 类别（源码→测试→文档→配置→其它），类别内再按文件树（目录/文件）展开。
  const groups = useMemo(() => {
    const byCategory = new Map<ReviewCategoryId, ReviewDiffFile[]>()
    for (const file of files) {
      const category = categoryOfPath(file.path)
      const bucket = byCategory.get(category)
      if (bucket === undefined) byCategory.set(category, [file])
      else bucket.push(file)
    }
    return CATEGORY_ORDER.filter(category => byCategory.has(category)).map(category => ({
      category,
      files: byCategory.get(category) ?? [],
    }))
  }, [files])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [collapsedCats, setCollapsedCats] = useState<ReadonlySet<ReviewCategoryId>>(new Set())
  // 跟随当前选中（含分页模式下每页自动选中）：展开所属类别与目录祖先。
  useEffect(() => {
    if (selectedIndex === undefined) return
    const file = files.find(candidate => candidate.index === selectedIndex)
    if (file === undefined) return
    setCollapsedCats(current => {
      if (!current.has(categoryOfPath(file.path))) return current
      const next = new Set(current)
      next.delete(categoryOfPath(file.path))
      return next
    })
    setCollapsed(current => expandAncestors(current, file.path))
  }, [selectedIndex, files])
  useEffect(() => {
    if (!expandFiltered) return
    setCollapsedCats(new Set())
  }, [expandFiltered])
  // 选中变化后把对应行滚动到树的可视区内（分页自动选中时也能看到高亮）。
  useEffect(() => {
    if (selectedIndex === undefined) return
    const container = document.querySelector('[data-dshw-kanban="tree-scroll"]')
    const row = container?.querySelector(`[data-file-index="${String(selectedIndex)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, collapsed, collapsedCats])
  const toggleCategory = useCallback((category: ReviewCategoryId) => {
    setCollapsedCats(current => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }, [])
  const toggle = useCallback((path: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const dirViewed = useMemo(() => countViewedDirs(files, viewed), [files, viewed])

  const categoryOpen = (category: ReviewCategoryId): boolean => !collapsedCats.has(category)
  const viewedCountOf = (bucket: readonly ReviewDiffFile[]): number => bucket.reduce((count, file) => count + (viewed.has(file.path) ? 1 : 0), 0)

  return (
    <div>
      {groups.map(group => {
        const count = group.files.length
        const viewedCount = viewedCountOf(group.files)
        return (
          <div key={group.category}>
            <div
              role="treeitem"
              aria-expanded={categoryOpen(group.category)}
              style={treeRowStyle(1, true, false, true)}
              data-dshw-kanban="reviewtree"
              onClick={() => { toggleCategory(group.category) }}
            >
              {categoryOpen(group.category) ? <GCaretDown size={12} /> : <GCaretRight size={12} />}
              <Checkbox
                indeterminate={viewedCount > 0 && viewedCount < count}
                checked={viewedCount === count && count > 0}
                label={`标记类别已读（${CATEGORY_META[group.category].label}）`}
                onChange={value => { onViewedMany(group.files.map(file => file.path), value) }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1, fontWeight: 600, color: C_TEXT }}>{CATEGORY_META[group.category].label}</span>
              <span style={treeCountStyle}>{count}</span>
            </div>
            {categoryOpen(group.category) && (() => {
              const rows = flattenTree(compactTreeNodes(buildFileTree(group.files)), collapsed, 2)
              return rows.map(row => {
                const node = row.node
                return node.kind === 'directory'
                  ? (
                    <div key={node.key} role="treeitem" aria-expanded={!collapsed.has(node.path)} style={treeRowStyle(row.level, true)} data-dshw-kanban="reviewtree" onClick={() => { toggle(node.path) }}>
                      {collapsed.has(node.path) ? <GCaretRight size={12} /> : <GCaretDown size={12} />}
                      <Checkbox indeterminate={dirViewed.get(node.path)! > 0 && dirViewed.get(node.path)! < node.fileCount} checked={dirViewed.get(node.path) === node.fileCount} label={`标记目录已读（${node.path}）`} onChange={value => { onViewedMany(collectPaths(node), value) }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{node.name}</span>
                    </div>
                  )
                  : (
                    <div key={node.key} role="treeitem" aria-selected={node.file.index === selectedIndex} data-selected={node.file.index === selectedIndex || undefined} data-file-index={node.file.index} style={treeRowStyle(row.level, false, node.file.index === selectedIndex)} data-dshw-kanban="reviewtree" onClick={(event) => { if (event.target instanceof Element && event.target.closest('[data-dshw-kanban="reviewcheck"]') !== null) return; onSelect(node.file.index) }}>
                      <span style={treeFileLeadingStyle} aria-hidden />
                      <Checkbox dataAttr="reviewcheck" checked={viewed.has(node.file.path)} label={`标记已读（${node.file.path}）`} onChange={value => { onViewedMany([node.file.path], value) }} />
                      <span style={{ ...treeFileNameStyle, color: statusNameColor(node.file.status) }} title={`${node.file.path}（${statusLabel(node.file.status)}）`}>{node.name}</span>
                    </div>
                  )
              })
            })()}
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
        : <DiffRows payload={payload} baseUrl={baseUrl} />)}
    </>
  )
}

/** Render a single token (words) for intraline seg. */
function DiffRows({ payload, baseUrl }: { payload: Extract<ReviewDiffPayload, { kind: 'text' }>; baseUrl: string }): ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const [scrolledTo, setScrolledTo] = useState<number | undefined>(undefined)
  const rows = payload.rows
  const intraline = useMemo(() => createIntralineRenderer(rows), [rows])
  const heights = useMemo(() => rows.map(row => row.kind === 'hunk' ? DIFF_HUNK_HEIGHT : DIFF_ROW_HEIGHT), [rows])
  const virtual = useVirtualRange(heights, parentRef)
  const start = Math.max(0, virtual.start - OVERSCAN)
  const end = Math.min(rows.length, virtual.end + OVERSCAN)
  const texts = useMemo(() => rows.map(row => row.text), [rows])
  const tokens = useSyntaxTokens(baseUrl, payload.file.path, texts)

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
                <DiffRowContent row={row} intraline={intraline} index={index} tokensOf={tokens.get} />
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

function DiffRowContent({ row, intraline, index, tokensOf }: {
  row: ReviewDiffRow
  intraline: ReturnType<typeof createIntralineRenderer>
  index: number
  tokensOf: (text: string) => SyntaxToken[] | undefined
}): ReactNode {
  if (row.kind === 'hunk') return <span style={hunkTextStyle}>{row.text}</span>
  const segments = intraline.segmentsFor(index)
  const tokens = tokensOf(row.text)
  const ranges = segments === undefined || row.kind === 'context' ? [] : changedRangesOf(segments)
  return (
    <>
      <span style={{ flex: 'none', width: 44, textAlign: 'right', paddingRight: 8, color: C_SECONDARY, userSelect: 'none' }}>{row.oldLine ?? ''}</span>
      <span style={{ flex: 'none', width: 44, textAlign: 'right', paddingRight: 8, color: C_SECONDARY, userSelect: 'none' }}>{row.newLine ?? ''}</span>
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

/** 折叠“单子目录链”：某目录只有一个可见子目录（且该子目录非空）时，把路径
 *  合并成一行（如 `src/components`），减少无意义的逐层缩进。 */
function compactTreeNodes(nodes: readonly TreeNode[]): TreeNode[] {
  const compact = (node: TreeNode): TreeNode => {
    if (node.kind !== 'directory') return node
    let current = node
    let children = current.children.map(compact)
    while (children.length === 1) {
      const only = children[0]
      if (only === undefined || only.kind !== 'directory' || only.children.length === 0) break
      current = {
        kind: 'directory',
        key: `dir:${only.path}`,
        name: `${current.name}/${only.name}`,
        path: only.path,
        fileCount: only.fileCount,
        children: only.children,
      }
      children = [...only.children]
    }
    return { ...current, children }
  }
  return nodes.map(compact)
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
  flex: 'none', display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 10px', boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`, background: C_SURFACE,
}
const detailTitleStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: C_TEXT, lineHeight: '20px',
  minWidth: 0, flex: 1,
}
const detailNumberStyle: CSSProperties = { flex: 'none', color: C_MUTED, fontWeight: 500, fontSize: 12 }
const headerActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }
const iconButtonStyle: CSSProperties = { position: 'relative', width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: C_SECONDARY, flex: 'none' }
/** Small accent dot on the chat icon while an AI conversation is running. */
const chatDotStyle: CSSProperties = { position: 'absolute', top: 5, right: 5, width: 7, height: 7, borderRadius: '50%', background: C_ACCENT, pointerEvents: 'none' }
const errorBannerStyle: CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 7, minHeight: 32, padding: '0 12px', borderBottom: `1px solid ${C_BORDER}`, fontSize: 12, color: C_DANGER, background: 'rgba(161, 38, 13, .08)' }
const diffEmptyStyle: CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 0, fontSize: 12.5, color: C_MUTED }
const fileSearchRowStyle: CSSProperties = { flex: 'none', padding: 8, paddingBottom: 4, borderBottom: `1px solid ${C_BORDER}` }
const fileSearchStyle: CSSProperties = { width: '100%', height: 28, padding: '0 8px', boxSizing: 'border-box', border: `1px solid ${C_BORDER}`, borderRadius: 4, outline: 'none', background: C_SURFACE, fontFamily: 'inherit', fontSize: 12, color: C_TEXT }
const fileTreeScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 0' }
const treeCountStyle: CSSProperties = { flex: 'none', fontSize: 11, color: C_MUTED }
const treeFileNameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1, fontFamily: FONT_MONO, fontSize: 12, color: C_TEXT }
const diffScrollStyle: CSSProperties = { flex: 1, minWidth: 0, overflow: 'auto', position: 'relative', background: C_SURFACE }
const diffHeaderStyle: CSSProperties = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, minHeight: 34, padding: '0 12px', borderBottom: `1px solid ${C_BORDER}`, background: C_HOVER }
const diffNavStyle: CSSProperties = { width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: C_SECONDARY, fontSize: 16, lineHeight: 1 }
const hunkTextStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 12, color: '#0b4a9c', whiteSpace: 'pre' }
const codeTextStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 12, lineHeight: `${DIFF_ROW_HEIGHT}px`, whiteSpace: 'pre', color: C_TEXT, display: 'block' }

/** 左栏工具行（隐藏已读开关 + 撤销/重做）。 */
const treeToolsRowStyle: CSSProperties = {
  flex: 'none', display: 'flex', alignItems: 'center', gap: 2, minHeight: 30, padding: '3px 6px',
  borderBottom: `1px solid ${C_BORDER}`, boxSizing: 'border-box',
}

function hidePillStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', borderRadius: 4,
    border: `1px solid ${active ? C_ACCENT : C_BORDER}`, fontSize: 11.5, whiteSpace: 'nowrap', cursor: 'pointer',
    color: active ? '#ffffff' : C_SECONDARY, background: active ? C_ACCENT : 'transparent', flex: 'none',
  }
}

function treeToolButtonStyle(enabled: boolean): CSSProperties {
  return {
    width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 4, color: C_SECONDARY, flex: 'none',
    ...(enabled ? {} : { opacity: 0.35, cursor: 'default' }),
  }
}

const treeHintStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', fontSize: 12, color: C_MUTED }
const treeReadChipStyle: CSSProperties = { flex: 'none', fontSize: 11, color: '#388a34', fontWeight: 600 }
const allReadOverlayStyle: CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 12, fontSize: 12.5, color: C_MUTED, background: C_SURFACE,
}
const overlayButtonStyle: CSSProperties = {
  height: 28, padding: '0 14px', borderRadius: 6, fontSize: 12.5, color: C_TEXT,
  background: C_HOVER, border: `1px solid ${C_BORDER}`, cursor: 'pointer',
}

/** 区块行收起按钮（与文件行左侧箭头同尺寸）。 */
const treeCaretButtonStyle: CSSProperties = {
  flex: 'none', width: 12, height: 20, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', color: C_SECONDARY, cursor: 'pointer',
}

/* ── browse-mode switch (sits in the detail header) ── */

const modeSwitchStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  overflow: 'hidden',
  marginRight: 4,
}

function modeIconButtonStyle(active: boolean): CSSProperties {
  return {
    width: 30,
    height: 26,
    padding: 0,
    border: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: active ? '#ffffff' : C_SECONDARY,
    background: active ? C_ACCENT : 'transparent',
  }
}

function treeRowStyle(level: number, isDirectory: boolean, selected = false, category = false): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6, height: FILE_ROW_HEIGHT, paddingLeft: 8 + (level - 1) * 10, paddingRight: 8,
    boxSizing: 'border-box', cursor: 'pointer', userSelect: 'none', flex: 'none',
    fontWeight: category || isDirectory ? 600 : 400, color: C_TEXT, fontSize: 12.5,
    ...(category ? { background: C_HOVER } : {}),
    ...(selected ? { background: C_ACCENT_SOFT } : {}),
  }
}

/** 文件行的前置占位宽度 = 目录行的箭头宽(12)。行内 flex gap(6) 会补上
 *  箭头到复选框的间距，因此复选框/名称与同层目录完全对齐
 *  （目录：箭头 12 + gap 6 + 复选框；文件：占位 12 + gap 6 + 复选框）。 */
const treeFileLeadingStyle: CSSProperties = { flex: 'none', width: 12 }

function fileStatusStyle(status: ReviewDiffFile['status']): CSSProperties {
  const color = statusTone(status)
  return { flex: 'none', width: 18, textAlign: 'center', fontWeight: 700, fontSize: 12, color }
}

/** 文件树里只靠文件名颜色区分变更类型（不再显示 A/M/D 字符）。 */
function statusNameColor(status: ReviewDiffFile['status']): string {
  return status === 'added' ? C_SUCCESS
    : status === 'deleted' ? C_DANGER
      : status === 'renamed' || status === 'copied' ? C_WARNING
        : C_TEXT
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
