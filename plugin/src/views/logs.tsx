/** Logs view (LogPanel.vue port): event log with pagination + detail dialog. */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { EventRecord, LogPage } from '../../../src/types.ts'
import {
  levelLabel, levelTone, mergeRecords, shortTimeLabel, sortRecords,
} from '../data.ts'
import { GClose, StatusDot } from '../icons.tsx'
import {
  actionLinkStyle, cellBlockStyle, dialogActionButtonStyle, dialogCloseButtonStyle,
  dialogFooterStyle, dialogHeaderStyle, dialogMaskStyle, dialogOverlayStyle,
  emptyStateStyle, jobDialogTitleStyle, jobsFooterStyle, jobsScrollStyle,
  logMessageStyle, tableStyle, tdCompactStyle, thStyle, timeStyle,
} from '../styles.ts'
import { toneColor, C_BORDER, C_MUTED, C_SECONDARY, C_SHADOW_POP, C_SURFACE, C_TEXT, FONT_MONO } from '../theme.ts'
import type { ViewProps } from '../workspace.tsx'

/* ── Logs view (LogPanel.vue port) ── */

export function LogsView({ baseUrl, snapshot, connection }: ViewProps): ReactNode {
  const [records, setRecords] = useState<EventRecord[]>([])
  const [cursor, setCursor] = useState<string>()
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<EventRecord>()
  const scroller = useRef<HTMLDivElement>(null)

  // Merge only records newer than the newest known (LogPanel.vue mergeLive).
  useEffect(() => {
    if (snapshot === undefined) return
    setRecords(previous => {
      const newest = previous[0]
      if (newest === undefined) return previous
      const incoming = snapshot.events
      const newestIndex = incoming.findIndex(record => record.id === newest.id)
      const fresh = newestIndex >= 0
        ? incoming.slice(newestIndex + 1)
        : incoming.filter(record => Date.parse(record.time) > Date.parse(newest.time))
      return fresh.length > 0 ? mergeRecords(previous, fresh) : previous
    })
  }, [snapshot])

  const fetchPage = async (before?: string): Promise<LogPage> => {
    const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
    const response = await fetch(`${baseUrl}/api/logs${query}`)
    const value = await response.json() as LogPage & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }

  const loadMore = async (): Promise<void> => {
    if (loading || !hasMore) return
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(cursor)
      setRecords(previous => mergeRecords(previous, page.records))
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const loadInitial = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage()
      setRecords(sortRecords(page.records))
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadInitial() }, [baseUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = (): void => {
    const element = scroller.current
    if (element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 48) void loadMore()
  }

  return (
    <>
      {records.length === 0 && !loading && (
        <div style={emptyStateStyle}>
          <span>{error ? `日志加载失败：${error}` : '暂无日志'}</span>
          {error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadInitial}>重试</button>}
        </div>
      )}
      {records.length > 0 && (
        <div ref={scroller} style={jobsScrollStyle} onScroll={onScroll}>
          <table style={{ ...tableStyle, minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 110 }}>级别</th>
                <th style={{ ...thStyle, width: 130 }}>来源</th>
                <th style={thStyle}>日志</th>
                <th style={{ ...thStyle, width: 100 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {records.map(record => (
                <tr
                  key={record.id}
                  data-dshw-kanban="row"
                  tabIndex={0}
                  role="button"
                  aria-label={`查看日志详情：${record.message}`}
                  onClick={() => { setSelected(record) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(record) }
                  }}
                >
                  <td style={tdCompactStyle}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap', color: toneColor(levelTone(record.level)) }}>
                      <StatusDot tone={levelTone(record.level)} />
                      {levelLabel(record.level)}
                    </span>
                  </td>
                  <td style={tdCompactStyle}>
                    <span style={cellBlockStyle} title={record.kind}>{record.kind}</span>
                  </td>
                  <td style={tdCompactStyle}>
                    <span style={logMessageStyle} title={record.message}>{record.message}</span>
                  </td>
                  <td style={tdCompactStyle}>
                    <time style={timeStyle}>{shortTimeLabel(record.time)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={jobsFooterStyle}>
            {loading && <span>正在加载更多日志…</span>}
            {!loading && error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载失败，重试</button>}
            {!loading && error === '' && !hasMore && <span>已显示全部日志</span>}
            {!loading && error === '' && hasMore && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载更多日志</button>}
          </div>
        </div>
      )}
      {selected !== undefined && <LogDialog record={selected} onClose={() => { setSelected(undefined) }} />}
    </>
  )
}

/** Log detail dialog (LogDetailsDialog.vue port). */
export function LogDialog({ record, onClose }: { record: EventRecord; onClose: () => void }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    }
  }, [onClose])
  const copy = (): void => {
    void navigator.clipboard.writeText(record.message)
    setCopied(true)
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => { setCopied(false) }, 1_500)
  }
  const fullTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(record.time))
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <section style={logDialogStyle} role="dialog" aria-modal="true" aria-label="日志详情">
        <header style={dialogHeaderStyle}>
          <span style={jobDialogTitleStyle}>日志详情</span>
          <span style={logIdStyle} title={record.id}>{record.id}</span>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}><GClose size={15} /></button>
        </header>
        <div style={logMetaStyle}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: toneColor(levelTone(record.level)) }}>
            <StatusDot tone={levelTone(record.level)} />{levelLabel(record.level)}
          </span>
          <span style={logMetaItemStyle}><span style={logMetaKeyStyle}>来源</span><code>{record.kind}</code></span>
          <span style={logMetaItemStyle}><span style={logMetaKeyStyle}>时间</span><time>{fullTime}</time></span>
        </div>
        <div style={logBodyStyle}>
          <pre style={logBodyPreStyle}>{record.message}</pre>
        </div>
        <footer style={dialogFooterStyle}>
          <button type="button" style={dialogActionButtonStyle} onClick={copy}>{copied ? '已复制' : '复制完整日志'}</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}


/* ── log dialog styles ── */

export const logDialogStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: 'min(760px, calc(100vw - 48px))',
  height: 'min(620px, calc(100vh - 48px))',
  overflow: 'hidden',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 12,
  background: C_SURFACE,
  boxShadow: C_SHADOW_POP,
}

export const logIdStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_MUTED,
}

export const logMetaStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '5px 18px',
  minHeight: 42,
  padding: '8px 14px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 11.5,
  color: C_SECONDARY,
}

export const logMetaItemStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }

export const logMetaKeyStyle: CSSProperties = { color: C_MUTED }

export const logBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  background: C_SURFACE,
}

export const logBodyPreStyle: CSSProperties = {
  minHeight: '100%',
  margin: 0,
  padding: 16,
  boxSizing: 'border-box',
  fontFamily: FONT_MONO,
  fontSize: 12.5,
  lineHeight: 1.65,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: C_TEXT,
}
