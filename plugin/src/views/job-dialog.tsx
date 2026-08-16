/**
 * Job detail dialog (TaskDialog.vue port): live streaming output (durable log
 * page merged with the SSE progress tail) with the session-event timeline,
 * plus pause / steer when the worker's control protocol supports it.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { DshWorkerProgress, JobRecord } from '../../../src/types.ts'
import {
  elapsedLabel, jobLabel, kindLabel, mergeProgressOutput, parseProgressOutput,
  phaseLabel, shortTimeLabel, stripAnsi,
  type KanbanSnapshot, type ProgressOutputBlock,
} from '../data.ts'
import { StatusDot } from '../icons.tsx'
import {
  dialogActionButtonStyle, dialogCloseButtonStyle, dialogFooterStyle,
  dialogMaskStyle, dialogOverlayStyle, dialogStyle,
} from '../styles.ts'
import {
  C_ACCENT, C_ACCENT_SOFT, C_BORDER, C_DANGER, C_FAINT, C_MUTED,
  C_SECONDARY, C_SUCCESS, C_SURFACE, C_TEXT, C_WARNING, FONT_MONO, toneColor, type Tone,
} from '../theme.ts'

type OutputItem =
  | { kind: 'tool'; call?: ProgressOutputBlock; result?: ProgressOutputBlock }
  | { kind: 'block'; block: ProgressOutputBlock }

/** Job detail dialog rendered by the workspace (shared by busy rows + jobs list). */
export function JobDialog({ job, baseUrl, snapshot, pending, post, onClose }: {
  job: JobRecord
  baseUrl: string
  snapshot: KanbanSnapshot
  pending: ReadonlySet<string>
  post: (path: string, body: object, key: string) => Promise<void>
  onClose: () => void
}): ReactNode {
  const progress: DshWorkerProgress | undefined = snapshot.jobProgress[job.id]
  const run = snapshot.dshRuns.find(candidate => candidate.id === job.dshWorker?.handle.runId)
  const [persistedOutput, setPersistedOutput] = useState('')
  const [outputLoading, setOutputLoading] = useState(false)
  const [outputBefore, setOutputBefore] = useState<number>()
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [steering, setSteering] = useState(false)
  const [now, setNow] = useState(Date.now())
  const outputElement = useRef<HTMLDivElement>(null)
  const timelineElement = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const running = job.status === 'running'
  const tone: Tone = jobToneOf(job.status)
  const phase = running
    ? progress !== undefined ? phaseLabel(progress.phase) : job.dshWorker !== undefined ? 'Agent 运行中' : '后台检查中'
    : jobLabel(job.status)
  const controllable = running && job.dshWorker?.handle.progressProtocol === 'session-control-v1'
  const paused = progress?.phase === 'paused'
  const workerLabel = job.dshWorker === undefined
    ? undefined
    : job.dshWorker.handle.workerType === 'codex'
      ? 'Codex worker'
      : job.dshWorker.handle.workerType === 'claude-code' ? 'Claude Code worker' : 'dsh worker'
  const output = stripAnsi(mergeProgressOutput(
    persistedOutput !== '' ? persistedOutput : (job.output ?? run?.finalOutput ?? ''),
    progress?.outputTail ?? '',
  ))
  const outputItems = buildOutputItems(parseProgressOutput(output).filter(block => block.kind !== 'step'))
  const placeholder = !running
    ? '这个任务没有文本输出。'
    : job.dshWorker === undefined
      ? '等待后台任务产生输出…'
      : job.dshWorker.handle.progressProtocol === undefined
        ? '这个任务由升级前的 worker 启动，实时输出不可用；状态和事件仍会自动更新。'
        : progress?.message ?? '等待任务产生输出…'
  const sync = job.dshWorker?.sync
  const dialogTitle = compactPrLabel(job.summary, sync, true)
  const timeline = snapshot.events
    .filter((event) => {
      const start = Date.parse(job.startedAt ?? job.createdAt) - 1_000
      return Date.parse(event.time) >= start && (
        sync === undefined
        || event.message.includes(`PR #${sync.prNumber}`)
        || event.message.includes(sync.cloneName)
        || event.kind === 'service'
      )
    })
    .slice(-18)

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // Durable page: fetch the persisted output for dsh-backed jobs.
  useEffect(() => {
    let cancelled = false
    if (job.dshWorker === undefined) return
    setOutputLoading(true)
    fetch(`${baseUrl}/api/jobs/output?jobId=${encodeURIComponent(job.id)}`)
      .then(response => response.json() as Promise<{ output?: string; nextBefore?: number; hasMore?: boolean }>)
      .then((value) => {
        if (cancelled) return
        setPersistedOutput(value.output ?? '')
        setOutputBefore(value.nextBefore)
        setHasOlder(value.hasMore === true)
      })
      .catch(() => { /* live tail remains the fallback */ })
      .finally(() => { if (!cancelled) setOutputLoading(false) })
    return () => { cancelled = true }
  }, [baseUrl, job.id])

  // Auto-scroll while the reader is near the bottom (both panes).
  useEffect(() => {
    const element = outputElement.current
    if (element !== null && stickToBottom.current) element.scrollTop = element.scrollHeight
    const rail = timelineElement.current
    if (rail !== null) rail.scrollTop = rail.scrollHeight
  }, [output, outputLoading, timeline])

  const onOutputScroll = (): void => {
    const element = outputElement.current
    if (element === null) return
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
    if (!stickToBottom.current && hasOlder && !loadingOlder && outputBefore !== undefined) void loadOlder()
  }

  const loadOlder = async (): Promise<void> => {
    const element = outputElement.current
    if (!hasOlder || loadingOlder || outputBefore === undefined || element === null) return
    setLoadingOlder(true)
    const previousHeight = element.scrollHeight
    const previousTop = element.scrollTop
    try {
      const response = await fetch(`${baseUrl}/api/jobs/output?jobId=${encodeURIComponent(job.id)}&before=${outputBefore}`)
      const value = await response.json() as { output?: string; nextBefore?: number; hasMore?: boolean }
      const older = value.output ?? ''
      setPersistedOutput(previous => older === '' ? previous : `${older}${older.endsWith('\n') ? '' : '\n'}${previous}`)
      setOutputBefore(value.nextBefore)
      setHasOlder(value.hasMore === true)
      requestAnimationFrame(() => {
        element.scrollTop = previousTop + element.scrollHeight - previousHeight
      })
    } catch {
      // A later scroll can retry.
    } finally {
      setLoadingOlder(false)
    }
  }

  const copyOutput = (): void => {
    void navigator.clipboard.writeText(output)
  }

  const sendSteer = (): void => {
    if (prompt.trim() === '' || steering) return
    setSteering(true)
    void post('/api/jobs/steer', { jobId: job.id, prompt: prompt.trim() }, `steer:${job.id}`)
      .finally(() => { setSteering(false); setPrompt('') })
  }

  return createPortal(
    <div style={overlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" />
      <section style={taskDialogStyle} role="dialog" aria-modal="true" aria-label={kindLabel(job.type)}>
        <header style={taskHeaderStyle}>
          <div style={taskHeaderTextStyle}>
            <h2 style={taskTitleStyle}>{dialogTitle}</h2>
            <div style={taskMetaStyle}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', color: toneColor(tone) }}>
                <StatusDot tone={tone} pulse={running} />
                {phase}
              </span>
              <span style={taskMetaSepStyle}>·</span>
              <span>{kindLabel(job.type)}</span>
              {workerLabel !== undefined && (<>
                <span style={taskMetaSepStyle}>·</span>
                <span style={{ fontFamily: FONT_MONO, color: C_SECONDARY }}>{workerLabel}</span>
              </>)}
              <span style={taskMetaSepStyle}>·</span>
              <span style={{ fontFamily: FONT_MONO }}>{elapsedLabel(job.startedAt ?? job.createdAt, job.finishedAt, now)}</span>
            </div>
          </div>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}>
            <span aria-hidden="true" style={{ display: 'inline-flex', color: C_SECONDARY }}><XIcon size={16} /></span>
          </button>
        </header>

        <div style={taskBodyStyle}>
          <section style={taskOutputSectionStyle}>
            {output === '' && !outputLoading ? (
              <div style={outputScrollStyle}><span style={placeholderStyle}>{placeholder}</span></div>
            ) : (
              <div ref={outputElement} style={outputScrollStyle} onScroll={onOutputScroll}>
                {output !== '' && (
                  <div style={feedStyle}>
                    {outputItems.map((item, index) => <OutputItemView key={index} item={item} />)}
                  </div>
                )}
                {outputLoading && <div style={placeholderStyle}>正在读取完整输出…</div>}
              </div>
            )}
          </section>
          <aside style={timelineAsideStyle}>
            <div ref={timelineElement} style={timelineScrollStyle}>
              {timeline.map(event => (
                <TimelineItem key={event.id} message={compactPrLabel(event.message, sync)} time={event.time} />
              ))}
              <TimelineItem
                message={phase}
                time={progress?.updatedAt ?? job.finishedAt ?? job.startedAt}
                active
              />
            </div>
          </aside>
        </div>

        <footer style={taskFooterStyle}>
          {controllable ? (
            <div style={composerStyle}>
              <textarea
                style={controlInputStyle}
                rows={2}
                placeholder={paused ? '输入指令并继续任务…' : '在下一个 step 前插入指令…'}
                disabled={steering || job.cancelRequestedAt !== undefined}
                value={prompt}
                onChange={event => { setPrompt(event.target.value) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendSteer() }
                }}
              />
              <div style={composerActionsStyle}>
                {!paused ? (
                  <button
                    type="button"
                    className="dshw-icon"
                    style={pauseButtonStyle}
                    disabled={pending.has(`pause:${job.id}`) || progress?.phase === 'cancelling' || job.cancelRequestedAt !== undefined}
                    title={pending.has(`pause:${job.id}`) || progress?.phase === 'cancelling' ? '暂停中' : '暂停任务'}
                    aria-label="暂停任务"
                    onClick={() => { void post('/api/jobs/pause', { jobId: job.id }, `pause:${job.id}`) }}
                  ><PauseIcon size={13} /></button>
                ) : (
                  <button
                    type="button"
                    className="dshw-icon"
                    style={stopButtonStyle}
                    disabled={job.cancelRequestedAt !== undefined}
                    title={job.cancelRequestedAt !== undefined ? '终止中' : '终止任务'}
                    aria-label="终止任务"
                    onClick={() => { void post('/api/jobs/cancel', { jobId: job.id }, `cancel:${job.id}`) }}
                  ><StopIcon size={12} /></button>
                )}
                <button
                  type="button"
                  style={sendButtonStyle}
                  disabled={prompt.trim() === '' || steering}
                  aria-label={steering ? '发送中' : paused ? '继续任务' : '发送'}
                  onClick={sendSteer}
                ><SendIcon size={13} /></button>
              </div>
            </div>
          ) : (
            <div style={idleFooterStyle}>
              {!running && <span>{job.dshWorker === undefined ? '任务已结束' : outputLoading ? '正在读取完整输出…' : '任务已结束 · 显示完整输出'}</span>}
              {running && <span>这个任务由旧版 worker 启动，不支持 steer 和暂停。</span>}
              {output !== '' && (
                <button type="button" className="dshw-btn-ghost" style={dialogActionButtonStyle} onClick={copyOutput}>复制输出</button>
              )}
              {running && (
                <button
                  type="button"
                  className="dshw-danger"
                  style={terminateButtonStyle}
                  disabled={job.cancelRequestedAt !== undefined || pending.has(`cancel:${job.id}`)}
                  onClick={() => { void post('/api/jobs/cancel', { jobId: job.id }, `cancel:${job.id}`) }}
                >{job.cancelRequestedAt !== undefined ? '终止中' : '终止任务'}</button>
              )}
            </div>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  )
}

/* ── feed rendering (TaskDialog.vue output feed port) ── */

function buildOutputItems(blocks: ProgressOutputBlock[]): OutputItem[] {
  const items: OutputItem[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    if (block.kind === 'tool-call') {
      const next = blocks[index + 1]
      const result = next?.kind === 'tool-result' ? next : undefined
      items.push({ kind: 'tool', call: block, ...(result === undefined ? {} : { result }) })
      if (result !== undefined) index += 1
    } else if (block.kind === 'tool-result') {
      items.push({ kind: 'tool', result: block })
    } else {
      items.push({ kind: 'block', block })
    }
  }
  return items
}

function OutputItemView({ item }: { item: OutputItem }): ReactNode {
  if (item.kind === 'tool') {
    const { call, result } = item
    const status = result === undefined ? 'running' : result.failed === true ? 'failed' : 'complete'
    return (
      <details style={streamRowStyle}>
        <summary style={streamSummaryStyle}>
          <span style={{ ...toolDotStyle, ...toolDotState[status] }} title={result === undefined ? '运行中' : result.failed === true ? '失败' : '完成'} />
          <strong style={toolTitleStyle}>{call?.title ?? '未知'}</strong>
          {call?.preview !== undefined && <span style={streamPreviewStyle}>{call.preview}</span>}
        </summary>
        {(call?.body !== undefined || result?.body !== undefined) && (
          <div style={toolDetailsStyle}>
            {call?.body !== undefined && (
              <div style={toolDetailRowStyle}>
                <span style={toolDetailLabelStyle}>参数</span>
                <pre style={toolDetailPreStyle}>{call.body}</pre>
              </div>
            )}
            {result?.body !== undefined && (
              <div style={toolDetailRowStyle}>
                <span style={toolDetailLabelStyle}>结果</span>
                <pre style={toolDetailPreStyle}>{result.body}</pre>
              </div>
            )}
          </div>
        )}
      </details>
    )
  }
  const block = item.block
  const label = outputLabel(block)
  const primary = block.kind === 'agent' || block.kind === 'user' || block.kind === 'stderr' || block.kind === 'plain'
  if (primary) {
    return (
      <article style={{ ...primaryStyle, ...primaryVariant[block.kind] }}>
        <div style={primaryLabelStyle(block.kind)}>{label}</div>
        <pre style={primaryBodyStyle(block.kind)}>{block.body}</pre>
      </article>
    )
  }
  if (block.kind === 'thinking') {
    return (
      <details style={streamRowStyle}>
        <summary style={streamSummaryStyle}>
          <span style={thinkingDotStyle} title="思考" />
          <span style={{ ...streamPreviewStyle, color: C_MUTED, fontStyle: 'italic' }}>{block.preview ?? block.body}</span>
        </summary>
        <pre style={thinkingBodyStyle}>{block.body}</pre>
      </details>
    )
  }
  return (
    <details style={streamRowStyle}>
      <summary style={streamSummaryStyle}>
        <span style={streamKindStyle}>{label}</span>
        <span style={streamPreviewStyle}>{block.preview ?? block.body}</span>
      </summary>
      {block.body !== '' && <pre style={streamBodyStyle}>{block.body}</pre>}
    </details>
  )
}

function TimelineItem({ message, time, active = false }: { message: string; time?: string; active?: boolean }): ReactNode {
  return (
    <div style={active ? tlItemActiveStyle : tlItemStyle}>
      <span style={active ? tlDotActiveStyle : tlDotStyle} />
      <span style={tlLineStyle} />
      <div style={tlItemTextStyle}>
        <div style={{ overflowWrap: 'anywhere' }}>{message}</div>
        <time style={tlTimeStyle}>{time === undefined ? '' : shortTimeLabel(time)}</time>
      </div>
    </div>
  )
}

/* ── helpers ── */

/** 把 `${cloneName} / PR #n` 前缀精简为 PR 标识；withRepo 时带上仓库名
 *  （对话框标题与 workerLabel 并列、无其它 repo 上下文，因此需要 repo 名）。 */
function compactPrLabel(value: string, sync: JobRecord['dshWorker'] extends infer W ? W extends { sync?: infer S } ? S | undefined : never : never, withRepo = false): string {
  if (sync === undefined || sync.cloneName.toLowerCase() !== `pr-${sync.prNumber}`) return value
  const replacement = withRepo ? `${sync.repoSlug} PR #${sync.prNumber}` : `PR #${sync.prNumber}`
  return value.replaceAll(`${sync.cloneName} / PR #${sync.prNumber}`, replacement)
}

function outputLabel(block: ProgressOutputBlock): string {
  if (block.title !== undefined) return block.title
  if (block.kind === 'agent') return 'Agent'
  if (block.kind === 'user') return '你'
  if (block.kind === 'system') return '系统'
  if (block.kind === 'stderr') return '[stderr]'
  if (block.kind === 'plain') return '输出'
  return block.failed === true ? '失败' : '完成'
}

function jobToneOf(status: JobRecord['status']): Tone {
  return status === 'succeeded' ? 'ok' : status === 'failed' || status === 'blocked' ? 'bad' : status === 'running' ? 'warn' : 'neutral'
}

/* ── small lucide glyphs used by the composer / close ── */

function StrokeIcon({ size = 15, children }: { size?: number; children: ReactNode }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
const XIcon = ({ size = 15 }: { size?: number }): ReactNode => (
  <StrokeIcon size={size}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></StrokeIcon>
)
const PauseIcon = ({ size = 13 }: { size?: number }): ReactNode => (
  <StrokeIcon size={size}><path d="M5 4h4v16H5z" /><path d="M15 4h4v16h-4z" /></StrokeIcon>
)
const StopIcon = ({ size = 12 }: { size?: number }): ReactNode => (
  <StrokeIcon size={size}><rect width="18" height="18" x="3" y="3" rx="1" /></StrokeIcon>
)
const SendIcon = ({ size = 13 }: { size?: number }): ReactNode => (
  <StrokeIcon size={size}><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></StrokeIcon>
)

/* ── styles (TaskDialog.vue port) ── */

const toolDotState: Record<'running' | 'failed' | 'complete', CSSProperties> = {
  running: { background: C_ACCENT },
  failed: { background: C_DANGER },
  complete: { background: C_SUCCESS },
}

const overlayStyle: CSSProperties = { ...dialogOverlayStyle, padding: 24, boxSizing: 'border-box' }

const taskDialogStyle: CSSProperties = {
  ...dialogStyle,
  /* dialogStyle's padding belongs to the small picker dialog; the streaming
     task dialog fills edge to edge (header / output+timeline / footer). */
  padding: 0,
  width: 'min(1080px, 100%)',
  height: 'min(760px, 100%)',
  display: 'grid',
  gridTemplateRows: 'auto minmax(0, 1fr) auto',
}

const taskHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  minHeight: 56,
  padding: '8px 12px 8px 16px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

const taskHeaderTextStyle: CSSProperties = { minWidth: 0 }

const taskTitleStyle: CSSProperties = { margin: 0, fontSize: 13.5, fontWeight: 600, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C_TEXT }

const taskMetaStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 11.5, color: C_MUTED }

const taskMetaSepStyle: CSSProperties = { color: C_FAINT }

const taskBodyStyle: CSSProperties = { minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px' }

const taskOutputSectionStyle: CSSProperties = { minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }

const outputScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px', boxSizing: 'border-box', fontSize: 12, lineHeight: 1.6, background: C_SURFACE }

const feedStyle: CSSProperties = { display: 'flex', flexDirection: 'column' }

const placeholderStyle: CSSProperties = { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: C_MUTED, fontSize: 12 }

const streamRowStyle: CSSProperties = { color: C_MUTED, paddingLeft: 3 }

const streamSummaryStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 24,
  padding: '1px 4px',
  borderRadius: 3,
  cursor: 'pointer',
  userSelect: 'none',
}

const streamPreviewStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  color: C_SECONDARY,
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  lineHeight: 1.5,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const streamKindStyle: CSSProperties = { width: 31, flex: 'none', color: C_FAINT, fontSize: 10.5 }

const toolDotStyle: CSSProperties = { flex: 'none', width: 5, height: 5, borderRadius: '50%' }

const thinkingDotStyle: CSSProperties = { flex: 'none', width: 5, height: 5, borderRadius: '50%', background: C_FAINT }

const toolTitleStyle: CSSProperties = { flex: 'none', color: C_SECONDARY, font: `500 11px/1.5 ${FONT_MONO}` }

const toolDetailsStyle: CSSProperties = { margin: '1px 5px 5px 15px', padding: '4px 0 4px 10px', borderLeft: `1px solid ${C_BORDER}` }

const toolDetailRowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '27px minmax(0, 1fr)', gap: 8, padding: '3px 0' }

const toolDetailLabelStyle: CSSProperties = { color: C_FAINT, fontSize: 10, lineHeight: 1.7 }

const toolDetailPreStyle: CSSProperties = { margin: 0, color: C_TEXT, fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

const streamBodyStyle: CSSProperties = {
  margin: '1px 5px 5px 52px',
  padding: '3px 0 4px 9px',
  borderLeft: `1px solid ${C_BORDER}`,
  color: C_TEXT,
  fontFamily: FONT_MONO,
  fontSize: 11.5,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

const thinkingBodyStyle: CSSProperties = {
  margin: '1px 5px 5px 12px',
  padding: '3px 0 4px 9px',
  borderLeft: `1px solid ${C_BORDER}`,
  color: C_MUTED,
  fontSize: 11.5,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

const primaryStyle: CSSProperties = { margin: '9px 4px 10px 0', paddingLeft: 10, borderLeft: `2px solid ${C_ACCENT}` }

const primaryVariant: Record<string, CSSProperties> = {
  user: { marginLeft: 0, borderLeftColor: `color-mix(in srgb, ${C_ACCENT} 60%, rgba(128, 128, 128, .35))` },
  stderr: { borderLeftColor: C_WARNING },
  plain: { borderLeftColor: C_SUCCESS },
}

const primaryLabelStyle = (kind: ProgressOutputBlock['kind']): CSSProperties => ({
  marginBottom: 3,
  color: kind === 'user' ? C_SECONDARY : kind === 'stderr' ? C_WARNING : kind === 'plain' ? C_SUCCESS : C_ACCENT,
  fontSize: 11,
  fontWeight: 600,
})

const primaryBodyStyle = (kind: ProgressOutputBlock['kind']): CSSProperties => ({
  color: C_TEXT,
  fontFamily: kind === 'agent' || kind === 'user' || kind === 'system' ? undefined : FONT_MONO,
  fontSize: kind === 'agent' || kind === 'user' || kind === 'system' ? 13 : 11.5,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})

/* timeline aside */

const timelineAsideStyle: CSSProperties = {
  minHeight: 0,
  overflow: 'hidden',
  borderLeft: `1px solid ${C_BORDER}`,
  background: C_SURFACE,
}

const timelineScrollStyle: CSSProperties = { height: '100%', overflow: 'auto', padding: '10px 14px', boxSizing: 'border-box' }

const tlItemStyle: CSSProperties = { position: 'relative', paddingBottom: 14, paddingLeft: 16 }

const tlItemActiveStyle: CSSProperties = { ...tlItemStyle, paddingBottom: 0 }

const tlDotStyle: CSSProperties = { position: 'absolute', left: 1, top: 5, width: 7, height: 7, borderRadius: '50%', background: C_FAINT }

const tlDotActiveStyle: CSSProperties = {
  ...tlDotStyle,
  background: C_ACCENT,
  boxShadow: `0 0 0 3px ${C_ACCENT_SOFT}`,
}

const tlLineStyle: CSSProperties = {
  position: 'absolute',
  left: 4,
  top: 16,
  bottom: 1,
  width: 1,
  background: C_BORDER,
}

const tlItemTextStyle: CSSProperties = { color: C_SECONDARY, fontSize: 12, lineHeight: 1.45 }

const tlTimeStyle: CSSProperties = { display: 'block', marginTop: 3, fontFamily: FONT_MONO, fontSize: 11, color: C_FAINT }

/* footer */

const taskFooterStyle: CSSProperties = {
  ...dialogFooterStyle,
  minHeight: 0,
  padding: 10,
  fontSize: 12,
  color: C_MUTED,
}

const composerStyle: CSSProperties = { display: 'flex', alignItems: 'stretch', gap: 5, height: 48 }

const controlInputStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  resize: 'none',
  border: '1px solid rgba(128, 128, 128, .35)',
  borderRadius: 6,
  background: C_SURFACE,
  padding: '7px 9px',
  boxSizing: 'border-box',
  color: C_TEXT,
  fontSize: 12.5,
  lineHeight: 1.45,
  outline: 'none',
  fontFamily: 'inherit',
}

const composerActionsStyle: CSSProperties = { width: 30, flex: 'none', display: 'grid', gridTemplateRows: 'repeat(2, minmax(0, 1fr))', gap: 2 }

const pauseButtonStyle: CSSProperties = {
  minHeight: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 3,
  border: 'none',
  background: 'transparent',
  color: C_MUTED,
  cursor: 'pointer',
}

const stopButtonStyle: CSSProperties = { ...pauseButtonStyle, color: C_DANGER }

const sendButtonStyle: CSSProperties = {
  minHeight: 0,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 3,
  border: 'none',
  background: C_ACCENT,
  color: '#fff',
  cursor: 'pointer',
}

const idleFooterStyle: CSSProperties = { height: 28, display: 'flex', alignItems: 'center', gap: 8 }

const terminateButtonStyle: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: C_DANGER,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
}
