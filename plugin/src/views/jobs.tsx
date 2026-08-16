/** Jobs view (JobsTable.vue port): job list with live merge + pagination. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { JobPage, JobRecord } from '../../../src/types.ts'
import {
  jobExecutor, jobLabel, jobTone, kindLabel, mergeJobs, shortTimeLabel, sortJobs,
} from '../data.ts'
import { StatusDot } from '../icons.tsx'
import { toneColor } from '../theme.ts'
import {
  actionLinkStyle, cellBlockStyle, cellNoteRowStyle, dangerButtonStyle, emptyStateStyle,
  jobsFooterStyle, jobsScrollStyle, jobSummaryStyle, tableStyle, tdCompactStyle, thStyle,
  timeStyle,
} from '../styles.ts'
import type { ViewProps } from '../workspace.tsx'

/* ── Jobs view (JobsTable.vue port) ── */

export function JobsView({ baseUrl, snapshot, pending, post, openJob }: ViewProps): ReactNode {
  const [records, setRecords] = useState<JobRecord[]>(() =>
    sortJobs((snapshot?.jobs ?? []).filter(job => job.type !== 'sync-check')))
  const [cursor, setCursor] = useState<string>()
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  // Live merge: snapshot.jobs is the authoritative running/current set.
  useEffect(() => {
    if (snapshot === undefined) return
    setRecords(previous => mergeJobs(previous, snapshot.jobs.filter(job => job.type !== 'sync-check')))
  }, [snapshot])

  const fetchPage = async (before?: string): Promise<JobPage> => {
    const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
    const response = await fetch(`${baseUrl}/api/jobs${query}`)
    const value = await response.json() as JobPage & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }

  const loadMore = async (): Promise<void> => {
    if (loading || !hasMore) return
    setLoading(true)
    setError('')
    try {
      const page = await fetchPage(cursor)
      setRecords(previous => mergeJobs(previous, page.records))
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
      setRecords(previous => mergeJobs(previous, page.records))
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
          <span>{error ? `任务加载失败：${error}` : '暂无任务'}</span>
          {error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadInitial}>重试</button>}
        </div>
      )}
      {records.length > 0 && (
        <div ref={scroller} style={jobsScrollStyle} onScroll={onScroll}>
          <table style={{ ...tableStyle, minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: 110 }}>状态</th>
                <th style={{ ...thStyle, width: 180 }}>目标</th>
                <th style={{ ...thStyle, width: 120 }}>执行者</th>
                <th style={thStyle}>任务</th>
                <th style={{ ...thStyle, width: 100 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {records.map(job => {
                const sync = job.dshWorker?.sync ?? snapshot?.syncs.find(candidate => candidate.id === job.syncId)
                // 多 repo 混排时目标必须带仓库名；PR 行本身不带 repo 名（与其它列并列）
                const target = sync === undefined ? '全局' : `${sync.repoSlug}#${sync.prNumber}`
                const targetTitle = sync === undefined ? '不针对特定 PR' : `${sync.repoSlug}#${sync.prNumber}\n${sync.branch} → ${sync.baseRefName}`
                return (
                  <tr
                    key={job.id}
                    data-dshw-kanban="row"
                    tabIndex={0}
                    onClick={() => { openJob(job) }}
                    onKeyDown={event => { if (event.key === 'Enter') openJob(job) }}
                  >
                    <td style={tdCompactStyle}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap', color: toneColor(jobTone(job.status)) }}>
                        <StatusDot tone={jobTone(job.status)} pulse={job.status === 'running'} />
                        {jobLabel(job.status)}
                      </span>
                    </td>
                    <td style={tdCompactStyle}>
                      <span style={cellBlockStyle} title={targetTitle}>{target}</span>
                    </td>
                    <td style={tdCompactStyle}>
                      <span style={cellBlockStyle} title={jobExecutor(job)}>{jobExecutor(job)}</span>
                    </td>
                    <td style={tdCompactStyle}>
                      <div style={cellNoteRowStyle}>
                        <span style={jobSummaryStyle} title={job.summary}>{kindLabel(job.type)}</span>
                        {job.status === 'running' && (
                          <button
                            type="button"
                            style={dangerButtonStyle}
                            disabled={job.cancelRequestedAt !== undefined || pending.has(`cancel:${job.id}`)}
                            onClick={(event) => { event.stopPropagation(); void post('/api/jobs/cancel', { jobId: job.id }, `cancel:${job.id}`) }}
                          >{job.cancelRequestedAt !== undefined ? '终止中' : '终止'}</button>
                        )}
                      </div>
                    </td>
                    <td style={tdCompactStyle}>
                      <time style={timeStyle}>{shortTimeLabel(job.finishedAt ?? job.startedAt ?? job.createdAt)}</time>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={jobsFooterStyle}>
            {loading && <span>正在加载更多任务…</span>}
            {!loading && error !== '' && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载失败，重试</button>}
            {!loading && error === '' && !hasMore && <span>已显示全部任务</span>}
            {!loading && error === '' && hasMore && <button type="button" className="dshw-link" style={actionLinkStyle} onClick={loadMore}>加载更多任务</button>}
          </div>
        </div>
      )}
    </>
  )
}

/** Simplified job detail: status, summary, output tail, cancel/pause/steer. */