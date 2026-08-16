/** Reviews view (ReviewRequests.vue port): review-request table. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { enabledRepos, groupByRepo, relativeTimeLabel } from '../data.ts'
import { GAlert, StatusDot } from '../icons.tsx'
import { RepoGroupRow } from '../components.tsx'
import {
  actionLinkStyle, authorStyle, cellMainStyle, cellSubStyle, draftBadgeStyle, emptyStateLineStyle,
  emptyStateStyle, emptyStateSubStyle, emptyStateTitleStyle, errorStripStyle,
  errorStripTextStyle, loadingStripStyle, numberStyle, prLoadingRowStyle,
  tableScrollStyle, tableStyle,
  tdStyle, thStyle, timeStyle, titleLinkStyle, titleStyle,
} from '../styles.ts'
import { warn, C_SECONDARY } from '../theme.ts'
import type { ViewProps } from '../workspace.tsx'

/* ── Reviews view (ReviewRequests.vue port) ── */

export function ReviewsView({ snapshot, connection, openReposSettings }: ViewProps): ReactNode {
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
          <table style={{ ...tableStyle, minWidth: 600 }}>
            <thead>
              <tr>
                <th style={thStyle}>Pull request</th>
                <th style={{ ...thStyle, width: 160 }}>作者</th>
                <th style={{ ...thStyle, width: 110 }}>更新于</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(group => (
                <RepoGroupRow
                  key={group.repoSlug}
                  repoSlug={group.repoSlug}
                  collapsed={collapsed.has(group.repoSlug)}
                  onToggle={toggleRepo}
                  colSpan={3}
                >
                  {group.records.map(pr => (
                    <tr key={`${pr.repoSlug}-${pr.number}`}>
                      <td style={tdStyle}>
                        <div style={cellMainStyle}>
                          <a style={titleLinkStyle} data-dshw-kanban="titlelink" href={pr.url} title={pr.title} target="_blank" rel="noreferrer">
                            <span style={numberStyle}>#{pr.number}</span>
                            <span style={{ ...titleStyle, ...(pr.isDraft ? { color: C_SECONDARY } : {}) }}>{pr.title}</span>
                          </a>
                          {pr.isDraft && <span style={draftBadgeStyle}>草稿</span>}
                        </div>
                        <div style={cellSubStyle} title={pr.headRefName}>{pr.headRefName} → {pr.baseRefName}</div>
                      </td>
                      <td style={tdStyle}><span style={authorStyle}>@{pr.author}</span></td>
                      <td style={tdStyle}><span style={timeStyle}>{relativeTimeLabel(pr.updatedAt)}</span></td>
                    </tr>
                  ))}
                  {group.records.length === 0 && requestsLoading && (
                    <tr>
                      <td colSpan={3} style={prLoadingRowStyle}>
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
