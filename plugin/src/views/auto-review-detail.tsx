/**
 * Auto review detail: findings on the left, the change since the reviewed head
 * (and the fix session) on the right.
 *
 * The panel owns a single review record. Findings come from
 * `/api/auto-review/record`, the diff from `/api/auto-review/diff`, and the fix
 * conversation reuses the ordinary job endpoints (`steer`, `pause`, `finish`,
 * `output`) so a session started here behaves exactly like one started from a
 * PR row.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  AutoReviewComment, AutoReviewRecord, JobRecord, ReviewDiffFile,
  ReviewDiffManifest, ReviewDiffPayload, ReviewDiffRow,
} from '../../../src/types.ts'
import type { KanbanSnapshot } from '../data.ts'
import { autoReviewCountdown, autoReviewFixJob, autoReviewLabel, autoReviewTone, relativeTimeLabel, severityLabel, severityTone, shortTimeLabel } from '../data.ts'
import { GAlert, GArrowLeft, GBot, GClose, GComment, GFileSingle, GSparkles, StatusDot } from '../icons.tsx'
import { emptyStateStyle, emptyStateSubStyle, emptyStateTitleStyle, primaryButtonStyle, titleStyle } from '../styles.ts'
import {
  C_ACCENT, C_ACCENT_SOFT, C_BORDER, C_DANGER, C_FAINT, C_MUTED, C_SECONDARY, C_SUCCESS,
  C_SURFACE, C_TEXT, C_WARNING, C_WIDGET, FONT_MONO, toneColor,
} from '../theme.ts'

/** Manifest plus the token the daemon uses to find the captured diff again. */
type DiffManifest = ReviewDiffManifest & { fromOid: string, toOid: string, additions: number, deletions: number }

export function AutoReviewDetailView({ baseUrl, reviewId, snapshot, pending, post, showToast, onBack, openJob }: {
  baseUrl: string
  reviewId: string
  snapshot?: KanbanSnapshot
  pending: ReadonlySet<string>
  post: (path: string, body: object, key: string) => Promise<void>
  showToast: (message: string, bad?: boolean) => void
  onBack: () => void
  openJob: (job: JobRecord) => void
}): ReactNode {
  const summary = snapshot?.autoReview.records.find(record => record.id === reviewId)
  const [record, setRecord] = useState<AutoReviewRecord>()
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'diff' | 'fix'>('diff')
  const [manifest, setManifest] = useState<DiffManifest>()
  const [diffError, setDiffError] = useState('')
  const [fileIndex, setFileIndex] = useState<number>()
  const [payload, setPayload] = useState<ReviewDiffPayload>()
  const [payloadLoading, setPayloadLoading] = useState(false)
  const [output, setOutput] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // Record detail: refreshed whenever the live summary changes (SSE snapshot).
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`${baseUrl}/api/auto-review/record?id=${encodeURIComponent(reviewId)}`)
        const value = await response.json() as { record?: AutoReviewRecord, error?: string }
        if (!response.ok || value.record === undefined) throw new Error(value.error ?? `HTTP ${response.status}`)
        if (!cancelled) {
          setRecord(value.record)
          setError('')
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [baseUrl, reviewId, summary?.updatedAt])

  // Diff capture follows the reviewed head and the current head of the PR.
  const diffKey = `${summary?.reviewedHeadOid ?? ''}:${summary?.observedHeadOid ?? ''}`
  useEffect(() => {
    let cancelled = false
    setDiffError('')
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`${baseUrl}/api/auto-review/diff?id=${encodeURIComponent(reviewId)}`)
        const value = await response.json() as DiffManifest & { error?: string }
        if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
        if (cancelled) return
        setManifest(value)
        if (value.error !== undefined) setDiffError(value.error)
        setFileIndex(previous => value.files.some(file => file.index === previous) ? previous : value.files[0]?.index)
      } catch (cause) {
        if (!cancelled) setDiffError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [baseUrl, reviewId, diffKey])

  // One file of the captured diff.
  useEffect(() => {
    if (manifest === undefined || fileIndex === undefined || manifest.token === '') {
      setPayload(undefined)
      return
    }
    let cancelled = false
    setPayloadLoading(true)
    const load = async (): Promise<void> => {
      try {
        const query = `id=${encodeURIComponent(reviewId)}&token=${encodeURIComponent(manifest.token)}&file=${String(fileIndex)}`
        const response = await fetch(`${baseUrl}/api/auto-review/diff?${query}`)
        const value = await response.json() as ReviewDiffPayload & { error?: string }
        if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
        if (!cancelled) setPayload(value)
      } catch (cause) {
        if (!cancelled) showToast(cause instanceof Error ? cause.message : String(cause), true)
      } finally {
        if (!cancelled) setPayloadLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [baseUrl, reviewId, manifest?.token, fileIndex])

  const fixJob = snapshot === undefined || summary === undefined ? undefined : autoReviewFixJob(snapshot, summary)
  const fixRunning = fixJob?.status === 'running'
  const progress = fixJob?.dshWorker === undefined ? undefined : snapshot?.jobProgress[fixJob.dshWorker.handle.runId]

  // Conversation transcript of the fix session.
  useEffect(() => {
    if (fixJob?.id === undefined) {
      setOutput('')
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(`${baseUrl}/api/jobs/output?jobId=${encodeURIComponent(fixJob.id)}`)
        const value = await response.json() as { output?: string }
        if (!cancelled && typeof value.output === 'string') setOutput(value.output)
      } catch { /* the job dialog still shows the full transcript */ }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [baseUrl, fixJob?.id, fixRunning])

  const openFile = (index: number): void => {
    setTab('diff')
    setFileIndex(index)
  }

  const jumpToComment = (comment: AutoReviewComment): void => {
    if (manifest === undefined) return
    const file = manifest.files.find(candidate => candidate.path === comment.file || candidate.oldPath === comment.file)
    if (file !== undefined) openFile(file.index)
    const key = commentAnchor(comment)
    requestAnimationFrame(() => {
      const element = rowRefs.current.get(key)
      element?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }

  const runNow = (): void => {
    void post('/api/auto-review/run', { id: reviewId }, `auto-review-run:${reviewId}`)
  }
  const startFix = (instruction?: string): void => {
    void post('/api/auto-review/fix', { id: reviewId, ...(instruction === undefined ? {} : { instruction }) }, `auto-review-fix:${reviewId}`)
  }
  const steer = async (): Promise<void> => {
    if (fixJob === undefined || draft.trim() === '' || sending) return
    setSending(true)
    try {
      const response = await fetch(`${baseUrl}/api/jobs/steer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: fixJob.id, prompt: draft.trim() }),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? '发送失败')
      setDraft('')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause), true)
    } finally {
      setSending(false)
    }
  }

  // The full record until it loads, then the live summary for status fields.
  const live = record ?? summary
  const tone = live === undefined ? 'neutral' : autoReviewTone(live)
  const countdown = live === undefined ? undefined : autoReviewCountdown(live)

  return (
    <div className="dshw-ar-detail" style={detailStyle}>
      <header style={headerStyle}>
        <button type="button" className="dshw-icon" style={backStyle} onClick={onBack} title="返回列表" aria-label="返回列表">
          <GArrowLeft size={15} />
        </button>
        <div style={headerIdentityStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <a href={live?.url ?? '#'} target="_blank" rel="noreferrer" style={{ ...titleStyle, color: C_TEXT, display: 'inline-flex', alignItems: 'center', gap: 6 }} data-dshw-kanban="titlelink">
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: C_MUTED }}>#{live?.number ?? '?'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{live?.title ?? reviewId}</span>
            </a>
          </div>
          <div style={headerSubStyle}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: toneColor(tone) }}>
              <StatusDot tone={tone} pulse={live?.status === 'running' || live?.status === 'pending'} />
              {live === undefined ? '加载中…' : autoReviewLabel(live)}
            </span>
            {countdown !== undefined && <span style={{ color: C_WARNING }}>· {Math.floor(countdown / 60) > 0 ? `${Math.floor(countdown / 60)} 分后开始` : `${countdown} 秒后开始`}</span>}
            {live?.model !== undefined && <span>· {live.model}</span>}
            {live?.reviewedHeadOid !== undefined && <span style={{ fontFamily: FONT_MONO }}>· 评审 {live.reviewedHeadOid.slice(0, 7)}</span>}
            {live?.observedHeadOid !== undefined && live.observedHeadOid !== live.reviewedHeadOid && (
              <span style={{ fontFamily: FONT_MONO }}>· 现在 {live.observedHeadOid.slice(0, 7)}</span>
            )}
            <span>· {relativeTimeLabel(live?.updatedAt)}</span>
          </div>
        </div>
        <div style={headerActionsStyle}>
          <button
            type="button"
            style={buttonStyle}
            disabled={live?.status === 'running' || live?.status === 'pending' || pending.has(`auto-review-run:${reviewId}`)}
            onClick={runNow}
            title="立即重新评审当前 head"
          >
            <GSparkles size={12} />立即评审
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={fixRunning || live?.status !== 'reviewed' || pending.has(`auto-review-fix:${reviewId}`)}
            onClick={() => { startFix() }}
            title={live?.status === 'reviewed' ? '用 dsh 会话处理这些评审意见' : '评审完成后才能启动修复会话'}
          >
            <GBot size={12} />{live?.fix === undefined ? '启动修复' : '再次修复'}
          </button>
        </div>
      </header>

      {error !== '' && (
        <div style={{ ...stripStyle, color: toneColor('bad') }}>
          <GAlert size={13} /><span>{error}</span>
        </div>
      )}

      <div className="dshw-ar-detail-body" style={bodyStyle}>
        <aside className="dshw-ar-comments" style={commentsPaneStyle}>
          <div style={paneHeaderStyle}>
            <span>评审意见</span>
            {live !== undefined && live.status === 'reviewed' && (
              <span style={{ color: C_MUTED, fontWeight: 400 }}>
                {live.counts.critical + live.counts.warning + live.counts.suggestion} 条
              </span>
            )}
          </div>
          <div style={commentsScrollStyle}>
            {live?.summary !== undefined && live.summary !== '' && (
              <div style={summaryCardStyle}>
                <div style={summaryTitleStyle}>概述</div>
                <div style={summaryTextStyle}>{live.summary}</div>
              </div>
            )}
            {live?.error !== undefined && (
              <div style={{ ...summaryCardStyle, borderColor: 'rgba(161, 38, 13, .35)', background: 'rgba(161, 38, 13, .06)' }}>
                <div style={{ ...summaryTitleStyle, color: C_DANGER }}>评审失败</div>
                <div style={summaryTextStyle}>{live.error}</div>
              </div>
            )}
            {(record?.comments ?? []).length === 0 && (
              <div style={commentsEmptyStyle}>
                {live?.status === 'reviewed' ? '这次评审没有发现问题。' : live?.status === 'running' ? '正在评审…' : '还没有评审结果。'}
              </div>
            )}
            {groupComments(record?.comments ?? []).map(group => (
              <section key={group.file} style={commentGroupStyle}>
                <button type="button" className="dshw-link" style={commentFileStyle} onClick={() => { jumpToComment(group.comments[0]!) }} title={group.file}>
                  <GFileSingle size={12} /><span style={commentFileTextStyle}>{group.file}</span>
                </button>
                {group.comments.map(comment => (
                  <button
                    key={`${comment.file}:${comment.line ?? comment.lineStart}:${comment.message.slice(0, 24)}`}
                    type="button"
                    style={commentCardStyle}
                    onClick={() => { jumpToComment(comment) }}
                    title="在右侧 diff 中定位"
                  >
                    <span style={{ ...severityChipStyle, color: toneColor(severityTone(comment.severity)), borderColor: toneColor(severityTone(comment.severity)) }}>
                      {severityLabel(comment.severity)}
                    </span>
                    <span style={commentLocationStyle}>
                      {comment.line !== undefined ? `L${comment.line}` : `L${comment.lineStart ?? '?'}-${comment.lineEnd ?? '?'}`}
                      {comment.lineType === 'old' ? '（删除行）' : ''}
                      {comment.locationValid ? '' : ' · 未定位'}
                    </span>
                    <span style={commentMessageStyle}>{comment.message}</span>
                  </button>
                ))}
              </section>
            ))}
          </div>
        </aside>

        <section style={workPaneStyle}>
          <div style={workTabsStyle} role="tablist" aria-label="评审工作区">
            <button type="button" role="tab" aria-selected={tab === 'diff'} data-selected={tab === 'diff' || undefined} style={workTabStyle(tab === 'diff')} onClick={() => { setTab('diff') }}>
              <GFileSingle size={12} />改动
              {manifest !== undefined && manifest.files.length > 0 && <span style={tabCountStyle}>{manifest.files.length}</span>}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'fix'} data-selected={tab === 'fix' || undefined} style={workTabStyle(tab === 'fix')} onClick={() => { setTab('fix') }}>
              <GComment size={12} />修复会话
              {fixRunning && <StatusDot tone="accent" pulse />}
            </button>
            <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, paddingRight: 8 }}>
              {manifest !== undefined && (
                <span style={{ fontSize: 11, color: C_FAINT, fontFamily: FONT_MONO }}>
                  {manifest.fromOid.slice(0, 7)}..{manifest.toOid.slice(0, 7)}
                  <span style={{ color: C_SUCCESS, marginLeft: 6 }}>+{manifest.additions}</span>
                  <span style={{ color: C_DANGER, marginLeft: 3 }}>-{manifest.deletions}</span>
                </span>
              )}
            </div>
          </div>

          {tab === 'diff' && (
            <div className="dshw-ar-diff" style={diffLayoutStyle}>
              {diffError !== '' && (
                <div style={{ ...stripStyle, color: toneColor('warn') }}>
                  <GAlert size={13} /><span>{diffError}</span>
                </div>
              )}
              {manifest !== undefined && manifest.files.length === 0 && diffError === '' && (
                <div style={emptyStateStyle}>
                  <p style={emptyStateTitleStyle}>没有新的改动</p>
                  <p style={emptyStateSubStyle}>
                    {manifest.fromOid === manifest.toOid
                      ? '评审后还没有新提交。修复会话 push 之后，这里会显示它改了什么。'
                      : '评审后的提交没有修改文件内容。'}
                  </p>
                </div>
              )}
              {manifest !== undefined && manifest.files.length > 0 && (
                <>
                  <div className="dshw-ar-files" style={fileListStyle}>
                    {manifest.files.map(file => (
                      <button
                        key={`${file.index}:${file.path}`}
                        type="button"
                        data-dshw-kanban="reviewtree"
                        data-selected={file.index === fileIndex || undefined}
                        style={fileRowStyle}
                        title={file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
                        onClick={() => { setFileIndex(file.index) }}
                      >
                        <span style={{ ...fileStatusStyle, color: fileStatusColor(file.status) }}>{fileStatusLetter(file.status)}</span>
                        <span style={filePathStyle}>{file.path}</span>
                      </button>
                    ))}
                  </div>
                  <div style={diffScrollStyle}>
                    {payloadLoading && payload === undefined && <div style={commentsEmptyStyle}>正在读取 diff…</div>}
                    {payload !== undefined && payload.kind === 'unavailable' && (
                      <div style={commentsEmptyStyle}>{payload.reason}</div>
                    )}
                    {payload !== undefined && payload.kind === 'text' && payload.rows.map((row, index) => (
                      <div
                        key={`${index}:${row.text.slice(0, 12)}`}
                        ref={element => {
                          if (element === null || row.kind === 'hunk') return
                          const lineNumber = row.newLine ?? row.oldLine
                          if (lineNumber !== undefined) rowRefs.current.set(`${payload.file.path}:${String(lineNumber)}`, element)
                        }}
                        style={{ ...diffRowStyle, ...diffRowTone(row) }}
                      >
                        <span style={diffLineStyle}>{row.oldLine ?? ''}</span>
                        <span style={diffLineStyle}>{row.newLine ?? ''}</span>
                        <span style={diffTextStyle}>{row.kind === 'hunk' ? row.text : row.text === '' ? ' ' : row.text}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'fix' && (
            <div style={fixPaneStyle}>
              {live?.fix === undefined || fixJob === undefined ? (
                <div style={emptyStateStyle}>
                  <span style={{ display: 'inline-flex', flex: 'none', color: C_ACCENT }}><GBot size={22} /></span>
                  <p style={emptyStateTitleStyle}>还没有修复会话</p>
                  <p style={emptyStateSubStyle}>
                    {live?.status === 'reviewed'
                      ? '启动一个 dsh 会话，把评审意见交给它处理；会话结束后可以在「改动」里查看结果。'
                      : '评审完成后可以启动 dsh 会话处理这些意见。'}
                  </p>
                  <button
                    type="button"
                    style={primaryButtonStyle}
                    disabled={live?.status !== 'reviewed' || pending.has(`auto-review-fix:${reviewId}`)}
                    onClick={() => { startFix() }}
                  >
                    <GBot size={12} />启动修复会话
                  </button>
                  {snapshot?.autoReview.config.autoFix === true && live?.status === 'reviewed' && (
                    <p style={{ ...emptyStateSubStyle, marginTop: 4 }}>已开启「评审后自动修复」，有必须修复/建议修复的问题时会自动开始。</p>
                  )}
                </div>
              ) : (
                <>
                  <div style={fixHeaderStyle}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: toneColor(fixJob.status === 'succeeded' ? 'ok' : fixJob.status === 'running' ? 'accent' : fixJob.status === 'failed' || fixJob.status === 'blocked' ? 'bad' : 'neutral') }}>
                      <StatusDot tone={fixJob.status === 'succeeded' ? 'ok' : fixJob.status === 'running' ? 'accent' : fixJob.status === 'failed' || fixJob.status === 'blocked' ? 'bad' : 'neutral'} pulse={fixJob.status === 'running'} />
                      {fixJob.status === 'running' ? '修复会话进行中' : fixJob.status === 'succeeded' ? '修复会话已完成' : fixJob.status === 'blocked' ? '修复会话无法完成' : fixJob.status === 'cancelled' ? '修复会话已终止' : '修复会话失败'}
                    </span>
                    <span style={{ color: C_FAINT, fontFamily: FONT_MONO, fontSize: 11 }}>{fixJob.dshWorker?.handle.workerType ?? 'dsh'} · {fixJob.executor ?? '默认执行器'}</span>
                    <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                      <button type="button" style={buttonStyle} onClick={() => { openJob(fixJob) }}>打开任务详情</button>
                      {fixRunning && (
                        <button
                          type="button"
                          style={buttonStyle}
                          onClick={() => { void post('/api/jobs/pause', { jobId: fixJob.id }, `pause:${fixJob.id}`) }}
                          title="暂停当前 turn（暂停后可继续输入）"
                        >
                          <GClose size={11} />暂停
                        </button>
                      )}
                    </div>
                  </div>
                  {progress?.message !== undefined && progress.message !== '' && (
                    <div style={progressStyle}>
                      <StatusDot tone="accent" pulse />
                      <span>{progress.message}</span>
                      <span style={{ marginLeft: 'auto', color: C_FAINT }}>{shortTimeLabel(progress.updatedAt)}</span>
                    </div>
                  )}
                  <div style={transcriptStyle}>
                    {output.trim() === '' ? <div style={commentsEmptyStyle}>还没有输出。</div> : <pre style={transcriptTextStyle}>{output}</pre>}
                  </div>
                  <div style={composerStyle}>
                    <textarea
                      className="dshw-wpta"
                      style={composerInputStyle}
                      rows={3}
                      placeholder={fixRunning ? '给修复会话发指令（例如：只处理 critical，其他先别改）' : '会话已结束；再次修复会启动新的会话'}
                      value={draft}
                      disabled={!fixRunning}
                      onChange={event => { setDraft(event.target.value) }}
                      onKeyDown={event => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault()
                          void steer()
                        }
                      }}
                    />
                    <div style={composerActionsStyle}>
                      <span style={{ fontSize: 11, color: C_FAINT }}>⌘/Ctrl + Enter 发送</span>
                      <button type="button" className="dshw-send" style={composerSendStyle} disabled={!fixRunning || draft.trim() === '' || sending} onClick={() => { void steer() }}>
                        <GComment size={12} />{sending ? '发送中' : '发送'}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** Stable anchor key for a comment row inside the rendered diff. */
function commentAnchor(comment: AutoReviewComment): string {
  return `${comment.file}:${String(comment.line ?? comment.fallbackLine ?? comment.lineStart ?? '')}`
}

function groupComments(comments: readonly AutoReviewComment[]): Array<{ file: string, comments: AutoReviewComment[] }> {
  const groups = new Map<string, AutoReviewComment[]>()
  for (const comment of comments) groups.set(comment.file, [...(groups.get(comment.file) ?? []), comment])
  return [...groups.entries()].map(([file, list]) => ({ file, comments: list }))
}

function fileStatusLetter(status: ReviewDiffFile['status']): string {
  return status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : status === 'copied' ? 'C' : 'M'
}

function fileStatusColor(status: ReviewDiffFile['status']): string {
  return status === 'added' ? C_SUCCESS : status === 'deleted' ? C_DANGER : status === 'renamed' || status === 'copied' ? C_ACCENT : C_WARNING
}

/** Row tint for one diff line, matching the review workspace palette. */
function diffRowTone(row: ReviewDiffRow): CSSProperties {
  if (row.kind === 'added') return { background: 'rgba(56, 138, 52, .10)' }
  if (row.kind === 'removed') return { background: 'rgba(161, 38, 13, .09)' }
  if (row.kind === 'hunk') return { background: C_WIDGET, color: C_MUTED }
  return {}
}

/* ── styles ──────────────────────────────────────────────────────────────── */

const detailStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: C_SURFACE }

const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 52,
  padding: '6px 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  background: C_WIDGET,
}

const backStyle: CSSProperties = { flex: 'none', width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: C_SECONDARY }

const headerIdentityStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }

const headerSubStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: C_MUTED, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }

const headerActionsStyle: CSSProperties = { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 26,
  padding: '0 10px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  background: C_SURFACE,
  color: C_TEXT,
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

const stripStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 30,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  background: C_SURFACE,
}

const bodyStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' }

const commentsPaneStyle: CSSProperties = {
  flex: 'none',
  width: 380,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  borderRight: `1px solid ${C_BORDER}`,
  background: C_SURFACE,
}

const paneHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  height: 32,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  fontWeight: 600,
  color: C_SECONDARY,
  background: C_WIDGET,
}

const commentsScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }

const summaryCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '9px 10px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  background: '#fafafa',
}

const summaryTitleStyle: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.03em', color: C_MUTED, textTransform: 'uppercase' }

const summaryTextStyle: CSSProperties = { fontSize: 12.5, lineHeight: 1.55, color: C_TEXT, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

const commentsEmptyStyle: CSSProperties = { padding: '18px 8px', fontSize: 12.5, color: C_MUTED, textAlign: 'center' }

const commentGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }

const commentFileStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: C_SECONDARY,
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  textAlign: 'left',
  cursor: 'pointer',
}

const commentFileTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const commentCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 3,
  width: '100%',
  padding: '7px 8px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  background: C_SURFACE,
  textAlign: 'left',
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const severityChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 5px',
  border: '1px solid',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
}

const commentLocationStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 11, color: C_FAINT }

const commentMessageStyle: CSSProperties = { fontSize: 12.5, lineHeight: 1.5, color: C_TEXT, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

const workPaneStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }

const workTabsStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'stretch',
  height: 32,
  borderBottom: `1px solid ${C_BORDER}`,
  background: C_WIDGET,
}

const workTabStyle = (active: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '0 12px',
  border: 'none',
  borderBottom: `2px solid ${active ? C_ACCENT : 'transparent'}`,
  background: active ? C_SURFACE : 'transparent',
  color: active ? C_TEXT : C_MUTED,
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
})

const tabCountStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: '#c4c4c4',
  color: C_TEXT,
}

const diffLayoutStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', alignItems: 'stretch' }

const fileListStyle: CSSProperties = {
  flex: 'none',
  width: 240,
  minWidth: 0,
  overflow: 'auto',
  borderRight: `1px solid ${C_BORDER}`,
  padding: '4px 0',
}

const fileRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  minHeight: 26,
  padding: '0 10px',
  border: 'none',
  background: 'transparent',
  color: C_TEXT,
  fontFamily: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  cursor: 'pointer',
}

const fileStatusStyle: CSSProperties = { flex: 'none', fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600, width: 10 }

const filePathStyle: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const diffScrollStyle: CSSProperties = { flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', background: C_SURFACE, paddingBottom: 12 }

const diffRowStyle: CSSProperties = { display: 'flex', alignItems: 'stretch', minHeight: 19, fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: '19px' }

const diffLineStyle: CSSProperties = {
  flex: 'none',
  width: 44,
  paddingRight: 8,
  boxSizing: 'border-box',
  textAlign: 'right',
  color: C_FAINT,
  userSelect: 'none',
  background: 'rgba(0, 0, 0, .02)',
}

const diffTextStyle: CSSProperties = { flex: 1, minWidth: 0, padding: '0 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: C_TEXT }

const fixPaneStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }

const fixHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 34,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  background: C_SURFACE,
}

const progressStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 30,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 12,
  color: C_SECONDARY,
  background: C_ACCENT_SOFT,
}

const transcriptStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', background: C_SURFACE }

const transcriptTextStyle: CSSProperties = {
  margin: 0,
  padding: 12,
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  lineHeight: 1.6,
  color: C_TEXT,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

const composerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 10,
  borderTop: `1px solid ${C_BORDER}`,
  background: C_WIDGET,
}

const composerInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  padding: '7px 9px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  outline: 'none',
  background: C_SURFACE,
  color: C_TEXT,
  fontFamily: 'inherit',
  fontSize: 12.5,
  lineHeight: '18px',
}

const composerActionsStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

const composerSendStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 26,
  padding: '0 12px',
  border: '1px solid transparent',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}
