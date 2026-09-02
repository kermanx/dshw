/** Reviews view (ReviewRequests.vue port): review-request table. */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { enabledRepos, findWorkingReview, groupByRepo, relativeTimeLabel } from '../data.ts'
import { GAlert, GReview, StatusDot } from '../icons.tsx'
import { RepoGroupRow } from '../components.tsx'
import {
  actionLinkStyle, authorStyle, busyRowStyle, cellMainStyle, cellSubStyle, draftBadgeStyle, emptyStateLineStyle,
  emptyStateStyle, emptyStateSubStyle, emptyStateTitleStyle, errorStripStyle,
  errorStripTextStyle, loadingStripStyle, numberStyle, prLoadingRowStyle,
  tableScrollStyle, tableStyle,
  subTextStyle, tdStyle, thStyle, timeStyle, titleLinkStyle, titleStyle,
} from '../styles.ts'
import { warn, C_SECONDARY } from '../theme.ts'
import type { ViewProps } from '../workspace.tsx'

/* ── Reviews view (ReviewRequests.vue port) ── */

export function ReviewsView({ snapshot, connection, pending, openReviewWorkerPicker, openJob, openReposSettings, openReviewDetail }: ViewProps): ReactNode {
  const requests = [...(snapshot?.reviewRequests ?? [])]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const status = snapshot?.reviewRequestsStatus
  const groups = groupByRepo(requests, enabledRepos(snapshot))
  const requestsLoading = status?.state === 'loading' || status?.refreshing === true
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggleRepo = (repoSlug: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(repoSlug)) next.delete(repoSlug)
      else next.add(repoSlug)
      return next
    })
  }
  return (
    <>
      {status !== undefined && status.state === 'error' && (
        <div style={errorStripStyle}>
          <span style={{ display: 'inline-flex', flex: 'none', color: warn }}><GAlert size={13} /></span>
          <span style={errorStripTextStyle}>Reviews 刷新失败，正在显示上次可用数据</span>
        </div>
      )}
      {status !== undefined && status.state === 'loading' && requests.length > 0 && (
        <div style={loadingStripStyle}>
          <StatusDot tone="accent" pulse />
          <span>正在刷新上次保存的 Reviews</span>
        </div>
      )}
      <div style={tableScrollStyle}>
        {snapshot === undefined && (
          <div style={emptyStateStyle}>
            <span style={emptyStateLineStyle}>
              <StatusDot tone="accent" pulse />
              <span>{connection === 'reconnecting' ? '正在重新连接 dshw daemon…' : '正在加载待 review 的 PR…'}</span>
            </span>
          </div>
        )}
        {snapshot !== undefined && (snapshot.repos?.length ?? 0) === 0 && (
          <div style={emptyStateStyle}>
            <p style={emptyStateTitleStyle}>还没有选择要监控的仓库</p>
            <p style={emptyStateSubStyle}>勾选仓库后，待你 review 的 PR 会显示在这里</p>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={openReposSettings}>去设置 Repos →</button>
          </div>
        )}
        {snapshot !== undefined && enabledRepos(snapshot).length > 0 && (
          /* Fixed column model; the Pull request column absorbs the rest, so
             the table fits any panel width and the rightmost Review entry
             column is never pushed out of view. */
          <table style={{ ...tableStyle, minWidth: 0 }}>
            <thead>
              <tr>
                <th style={thStyle}>Pull request</th>
                <th style={{ ...thStyle, width: 160 }}>作者</th>
                <th style={{ ...thStyle, width: 110 }}>更新于</th>
                <th style={{ ...thStyle, width: 76, textAlign: 'center' }}>Review</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(group => (
                <RepoGroupRow
                  key={group.repoSlug}
                  repoSlug={group.repoSlug}
                  collapsed={collapsed.has(group.repoSlug)}
                  onToggle={toggleRepo}
                  colSpan={4}
                >
                  {group.records.map(pr => {
                    const working = snapshot === undefined ? undefined : findWorkingReview(pr, snapshot.jobs)
                    const preparing = pending.has(`review:${pr.repoSlug}#${pr.number}`)
                    return (
                      <tr key={`${pr.repoSlug}-${pr.number}`}>
                        <td style={tdStyle}>
                          <div style={cellMainStyle}>
                            <a
                              style={{ ...titleLinkStyle, ...{ display: 'inline-flex', alignItems: 'center', gap: 6 } }}
                              data-dshw-kanban="titlelink"
                              href={pr.url}
                              title={working !== undefined
                                ? `${pr.title} · 右键继续 Review 对话`
                                : preparing ? '该 Review 正在准备中' : `${pr.title} · 右键发起 Review 对话`}
                              target="_blank"
                              rel="noreferrer"
                              onContextMenu={(event) => {
                                event.preventDefault()
                                if (working !== undefined) openJob(working)
                                else if (!preparing) openReviewWorkerPicker(pr.repoSlug, pr.number)
                              }}
                            >
                              <span style={numberStyle}>#{pr.number}</span>
                              <span style={{ ...titleStyle, ...(pr.isDraft ? { color: C_SECONDARY } : {}) }}>{pr.title}</span>
                            </a>
                            {pr.isDraft && <span style={draftBadgeStyle}>草稿</span>}
                          </div>
                          <div style={cellSubStyle}>
                            <span style={subTextStyle} title={pr.headRefName}>{pr.headRefName} → {pr.baseRefName}</span>
                            {pr.viewed !== undefined && pr.viewed.count > 0 && (
                              <span style={viewedBadgeStyle}>已读 {Math.min(pr.viewed.count, pr.viewed.total)}/{pr.viewed.total}</span>
                            )}
                            {preparing && (
                              <span style={{ ...busyRowStyle, flex: 'none', marginLeft: 6, fontFamily: 'var(--dsw-font-family)' }}>
                                <StatusDot tone="accent" pulse />准备中
                              </span>
                            )}
                            {!preparing && working !== undefined && (
                              <button
                                type="button"
                                className="dshw-link"
                                style={{ ...busyRowStyle, flex: 'none', marginLeft: 6, fontFamily: 'var(--dsw-font-family)' }}
                                onClick={() => { openJob(working) }}
                              >
                                <StatusDot tone="accent" pulse />对话中 · 查看
                              </button>
                            )}
                          </div>
                        </td>
                        <td style={tdStyle}><span style={authorStyle}>@{pr.author}</span></td>
                        <td style={tdStyle}><span style={timeStyle}>{relativeTimeLabel(pr.updatedAt)}</span></td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          <button
                            type="button"
                            data-dshw-kanban="reviewentry"
                            className="dshw-icon"
                            style={reviewEntryButtonStyle}
                            aria-label={working !== undefined ? `打开 ${pr.title} 的 Review` : `打开 ${pr.title} 的 Review`}
                            title={working !== undefined ? `${pr.title} · 打开 Review（AI 对话进行中）` : `${pr.title} · 打开 Review`}
                            onClick={() => { openReviewDetail(pr) }}
                          >
                            <GReview size={15} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  {group.records.length === 0 && requestsLoading && (
                    <tr>
                      <td colSpan={4} style={prLoadingRowStyle}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <StatusDot tone="accent" pulse />
                          <span>正在加载 Reviews…</span>
                        </span>
                      </td>
                    </tr>
                  )}
                </RepoGroupRow>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/** Read-progress badge on a Reviews row ("已读 x/y"). */
const viewedBadgeStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  marginLeft: 6,
  padding: '0 6px',
  height: 18,
  boxSizing: 'border-box',
  borderRadius: 3,
  border: '1px solid rgba(0, 122, 204, .35)',
  color: '#006ab1',
  fontSize: 11,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}

/** Right-side "open Review" icon button on a Reviews row. */
const reviewEntryButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  color: C_SECONDARY,
}
