/** Reviews view (ReviewRequests.vue port): review-request table. */
import type { ReactNode } from 'react'
import { relativeTimeLabel } from '../data.ts'
import { GAlert, StatusDot } from '../icons.tsx'
import {
  authorStyle, cellMainStyle, cellSubStyle, draftBadgeStyle, emptyStateLineStyle,
  emptyStateStyle, emptyStateSubStyle, emptyStateTitleStyle, errorStripStyle,
  errorStripTextStyle, loadingStripStyle, numberStyle, tableScrollStyle, tableStyle,
  tdStyle, thStyle, timeStyle, titleLinkStyle, titleStyle,
} from '../styles.ts'
import { warn, C_SECONDARY } from '../theme.ts'
import type { ViewProps } from '../workspace.tsx'

/* ── Reviews view (ReviewRequests.vue port) ── */

export function ReviewsView({ snapshot, connection }: ViewProps): ReactNode {
  const requests = [...(snapshot?.reviewRequests ?? [])]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const status = snapshot?.reviewRequestsStatus
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
        {snapshot !== undefined && requests.length === 0 && (
          <div style={emptyStateStyle}>
            <p style={emptyStateTitleStyle}>没有待你 review 的 PR</p>
            <p style={emptyStateSubStyle}>GitHub 上 request 你 review 的 open PR 会显示在这里</p>
          </div>
        )}
        {snapshot !== undefined && requests.length > 0 && (
          <table style={{ ...tableStyle, minWidth: 600 }}>
            <thead>
              <tr>
                <th style={thStyle}>Pull request</th>
                <th style={{ ...thStyle, width: 160 }}>作者</th>
                <th style={{ ...thStyle, width: 110 }}>更新于</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(pr => (
                <tr key={pr.number}>
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
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
