/**
 * Auto review view: one row per pull request the reviewer has seen.
 *
 * The list mirrors the Reviews table (repo groups, fixed-width state columns,
 * the Pull request column absorbing the remaining width) and stays readable in
 * a narrow sidebar through the shared `[data-dshw-table]` rules. Every row
 * opens the review detail; the compact badge exported below is the same entry
 * point from a PR row.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AutoReviewSummary } from '../../../src/types.ts'
import { autoReviewCountdown, autoReviewLabel, autoReviewTone, enabledRepos, groupByRepo, relativeTimeLabel, severitySummary } from '../data.ts'
import { GBot, GExternalLink, GReview, GSparkles, StatusDot } from '../icons.tsx'
import { RepoGroupRow } from '../components.tsx'
import {
  actionLinkStyle, cellSubStyle, emptyStateLineStyle, emptyStateStyle, emptyStateSubStyle,
  emptyStateTitleStyle, errorStripStyle, loadingStripStyle, numberStyle, subTextStyle, tableScrollStyle,
  tableStyle, tdStyle, thStyle, timeStyle, titleLinkStyle, titleStyle,
} from '../styles.ts'
import { C_ACCENT, C_FAINT, C_MUTED, C_SECONDARY, C_SUCCESS, C_WARNING, toneColor } from '../theme.ts'
import type { ViewProps } from '../workspace.tsx'

/* ── Auto review view ── */

export function AutoReviewView({ snapshot, connection, pending, post, openAutoReview, openAutoReviewSettings }: ViewProps): ReactNode {
  const records = snapshot?.autoReview.records ?? []
  const config = snapshot?.autoReview.config
  const repos = enabledRepos(snapshot)
  const groups = groupByRepo(records, repos)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggleRepo = (repoSlug: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(repoSlug)) next.delete(repoSlug)
      else next.add(repoSlug)
      return next
    })
  }
  const offline = connection === 'reconnecting'

  return (
    <>
      {config !== undefined && !config.enabled && (
        <div style={errorStripStyle}>
          <span style={{ display: 'inline-flex', flex: 'none', color: C_ACCENT }}><GBot size={13} /></span>
          <span style={{ color: C_SECONDARY }}>自动评审已关闭；开启后，PR 有新提交时会自动评审。</span>
          <button type="button" className="dshw-link" style={{ ...actionLinkStyle, marginLeft: 'auto' }} onClick={openAutoReviewSettings}>去开启 →</button>
        </div>
      )}
      {config !== undefined && config.enabled && snapshot !== undefined && snapshot.autoReview.running.length > 0 && (
        <div style={loadingStripStyle}>
          <StatusDot tone="accent" pulse />
          <span>正在评审 {snapshot.autoReview.running.length} 个 PR</span>
        </div>
      )}
      <div style={tableScrollStyle}>
        {snapshot === undefined && (
          <div style={emptyStateStyle}>
            <span style={emptyStateLineStyle}>
              <StatusDot tone="accent" pulse />
              <span>{offline ? '正在重新连接 dshw daemon…' : '正在加载自动评审记录…'}</span>
            </span>
          </div>
        )}
        {snapshot !== undefined && repos.length === 0 && (
          <div style={emptyStateStyle}>
            <p style={emptyStateTitleStyle}>还没有选择要监控的仓库</p>
            <p style={emptyStateSubStyle}>勾选仓库后，它的 PR 提交会被自动评审</p>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={openAutoReviewSettings}>去设置 →</button>
          </div>
        )}
        {snapshot !== undefined && repos.length > 0 && records.length === 0 && (
          <div style={emptyStateStyle}>
            <span style={{ display: 'inline-flex', flex: 'none', color: C_ACCENT }}><GBot size={22} /></span>
            <p style={emptyStateTitleStyle}>{config?.enabled === true ? '还没有需要评审的提交' : '自动评审还没有开启'}</p>
            <p style={emptyStateSubStyle}>
              {config?.enabled === true
                ? 'PR 出现新提交时，会先等待一小段时间再开始评审，避免每个中间提交都跑一遍'
                : '开启后，每当你的 PR 有新提交，评审 Agent 会先等待一小段时间再开始评审'}
            </p>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={openAutoReviewSettings}>
              {config?.enabled === true ? '查看自动评审设置 →' : '去开启 →'}
            </button>
          </div>
        )}
        {snapshot !== undefined && records.length > 0 && (
          <table data-dshw-table="auto-review" style={{ ...tableStyle, minWidth: 0 }}>
            <thead>
              <tr>
                <th style={thStyle}>Pull request</th>
                <th style={{ ...thStyle, width: 116 }}>评审</th>
                <th style={{ ...thStyle, width: 190 }}>意见</th>
                <th style={{ ...thStyle, width: 108 }}>修复</th>
                <th style={{ ...thStyle, width: 96 }}>更新于</th>
                <th style={{ ...thStyle, width: 64, textAlign: 'center' }}>面板</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(group => (
                <RepoGroupRow
                  key={group.repoSlug}
                  repoSlug={group.repoSlug}
                  collapsed={collapsed.has(group.repoSlug)}
                  onToggle={toggleRepo}
                  colSpan={6}
                >
                  {group.records.map(record => (
                    <AutoReviewRow
                      key={record.id}
                      record={record}
                      pending={pending}
                      onOpen={() => { openAutoReview(record.id) }}
                      onRun={() => { void post('/api/auto-review/run', { id: record.id }, `auto-review-run:${record.id}`) }}
                    />
                  ))}
                </RepoGroupRow>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function AutoReviewRow({ record, pending, onOpen, onRun }: {
  record: AutoReviewSummary
  pending: ReadonlySet<string>
  onOpen: () => void
  onRun: () => void
}): ReactNode {
  const tone = autoReviewTone(record)
  const countdown = autoReviewCountdown(record)
  const running = record.status === 'running'
  const fix = record.fix
  return (
    <tr data-dshw-kanban="row" tabIndex={0} onClick={onOpen} onKeyDown={event => { if (event.key === 'Enter') onOpen() }}>
      <td style={tdStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <a
            href={record.url}
            style={{ ...titleLinkStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            data-dshw-kanban="titlelink"
            title={`${record.title} · 打开自动评审面板`}
            target="_blank"
            rel="noreferrer"
            onClick={event => { event.stopPropagation() }}
          >
            <span style={numberStyle}>#{record.number}</span>
            <span style={titleStyle}>{record.title}</span>
          </a>
        </div>
        <div style={cellSubStyle}>
          <span style={subTextStyle} title={record.branch}>{record.baseRefName} ← {record.branch}</span>
          <span style={{ ...subTextStyle, flex: 'none', fontFamily: 'monospace', fontSize: 11, color: C_FAINT }}>{record.reviewedHeadOid?.slice(0, 7) ?? record.headOid.slice(0, 7)}</span>
          {countdown !== undefined && (
            <span style={{ ...subTextStyle, flex: 'none', color: C_WARNING }}>
              {Math.floor(countdown / 60) > 0 ? `${Math.floor(countdown / 60)} 分后评审` : `${countdown} 秒后评审`}
            </span>
          )}
          {record.skippedReason !== undefined && <span style={{ ...subTextStyle, flex: 'none', color: C_MUTED }}>{record.skippedReason}</span>}
        </div>
      </td>
      <td style={tdStyle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap', color: toneColor(tone) }}>
          <StatusDot tone={tone} pulse={running || record.status === 'pending'} />
          {autoReviewLabel(record)}
        </span>
      </td>
      <td style={tdStyle}>
        <span style={{ fontSize: 11.5, color: record.counts.critical > 0 ? toneColor('bad') : record.counts.warning > 0 ? toneColor('warn') : C_MUTED, whiteSpace: 'nowrap' }}>
          {record.status === 'reviewed' ? severitySummary(record.counts) : record.status === 'failed' ? (record.error ?? '评审失败') : '—'}
        </span>
      </td>
      <td style={tdStyle}>
        {fix === undefined ? (
          <span style={{ fontSize: 11.5, color: C_FAINT }}>—</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, whiteSpace: 'nowrap', color: C_SECONDARY }}>
            <StatusDot tone={fix.status === 'succeeded' ? 'ok' : fix.status === 'running' ? 'accent' : fix.status === 'failed' ? 'bad' : 'neutral'} pulse={fix.status === 'running'} />
            {fix.status === 'running' ? '修复中' : fix.status === 'succeeded' ? '已修复' : fix.status === 'failed' ? '修复失败' : fix.status === 'cancelled' ? '已终止' : fix.status === 'blocked' ? '无法修复' : '等待中'}
          </span>
        )}
      </td>
      <td style={tdStyle}><time style={timeStyle}>{relativeTimeLabel(record.updatedAt)}</time></td>
      <td style={{ ...tdStyle, textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <button
            type="button"
            className="dshw-icon"
            style={rowIconStyle}
            title={running ? '评审进行中' : '立即评审'}
            aria-label={`立即评审 #${record.number}`}
            disabled={running || record.status === 'pending' || pending.has(`auto-review-run:${record.id}`)}
            onClick={event => { event.stopPropagation(); onRun() }}
          >
            <GSparkles size={14} />
          </button>
          <button
            type="button"
            className="dshw-icon"
            style={rowIconStyle}
            title="打开评审面板"
            aria-label={`打开 #${record.number} 的自动评审面板`}
            onClick={event => { event.stopPropagation(); onOpen() }}
          >
            <GReview size={14} />
          </button>
        </div>
      </td>
    </tr>
  )
}

/** Compact state chip shown on a Pull requests row (empty when never reviewed). */
export function AutoReviewBadge({ record, onOpen }: { record: AutoReviewSummary, onOpen: () => void }): ReactNode {
  const tone = autoReviewTone(record)
  const label = record.status === 'reviewed' && record.counts.critical + record.counts.warning + record.counts.suggestion === 0
    ? '评审通过'
    : autoReviewLabel(record)
  return (
    <button
      type="button"
      className="dshw-trigger"
      style={{ ...badgeStyle, color: tone === 'ok' ? C_SUCCESS : toneColor(tone) }}
      title={`自动评审：${label}`}
      onClick={event => { event.stopPropagation(); onOpen() }}
    >
      <StatusDot tone={tone} pulse={record.status === 'running' || record.status === 'pending'} />
      <span>{label}</span>
      {record.status === 'reviewed' && record.commentCount > 0 && <span style={{ color: C_FAINT }}>· {record.commentCount}</span>}
    </button>
  )
}

/** Tiny external-link button used by the detail header. */
export function OpenOnGithub({ url, label }: { url: string, label: string }): ReactNode {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="dshw-icon"
      style={{ ...rowIconStyle, color: C_SECONDARY }}
      title={label}
      aria-label={label}
    >
      <GExternalLink size={14} />
    </a>
  )
}

const rowIconStyle = {
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  color: C_SECONDARY,
} as const

const badgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  flex: 'none',
  padding: 0,
  border: 'none',
  background: 'transparent',
  fontFamily: 'var(--dsw-font-family)',
  fontSize: 11.5,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
} as const
