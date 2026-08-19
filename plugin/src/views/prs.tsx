/** Pull requests view (PullRequestsTable.vue port): table rows, CI / Review /
 *  Merge / Sync cells, hover popovers and the local-git maintenance chip. */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { CloneGitStatus, JobRecord, PrDashboardRecord, PullRequestReview } from '../../../src/types.ts'
import { HoverPopover, RepoGroupRow } from '../components.tsx'
import {
  autoMergeAt, autoMergeMinutes, busyLabel, checkLabel, checkTone, ciLabel, ciTone,
  enabledRepos, findBusyJob, findWorkingAgent, groupByRepo, hasLocalGitStatus,
  lastFailedMerge, mergeAction,
  mergeLabel, mergeTone, rank, reviewLabel, reviewState, reviewStateTone, reviewTone,
  type GitAction, type PrAction,
} from '../data.ts'
import { orderStackedPrs } from '../stack.ts'
import { GAlert, StatusDot, StatusIcon } from '../icons.tsx'
import {
  actionLinkStyle, assignedBadgeStyle, busyRowStyle, cellColumnStyle, cellMainStyle, cellNoteRowStyle,
  cellNoteStyle, cellSubStyle, countStyle, draftBadgeStyle, emptyStateLineStyle,
  emptyStateStyle, emptyStateSubStyle, emptyStateTitleStyle, errorStripStyle,
  errorStripTextStyle, gitChipStyle, loadingStripStyle, mergeableLabelStyle,
  avatarStyle, conflictPathStyle, noteSeparatorStyle, numberStyle, pausedButtonStyle,
  popoverActionStyle, popoverEmptyStyle, popoverPersonRowStyle, popoverRowBadgeStyle,
  popoverRowStyle, popoverRowTextStyle, popoverSectionSpacedStyle, popoverSectionStyle,
  popoverSectionTitleStyle, avatarStackStyle, stackAvatarStyle,
  prLoadingRowStyle, stackMoreStyle, statusGlyphStyle,
  statusTextStyle, subTextStyle, syncCellStyle,
  syncKnobStyle, syncSwitchRowStyle, syncSwitchStyle, tableScrollStyle,
  tableStyle, tdStyle, thStyle, titleLinkStyle, titleStyle, trStyle, draftRowStyle,
} from '../styles.ts'
import { warn, toneColor, C_SECONDARY } from '../theme.ts'
import type { ViewProps } from '../workspace.tsx'

/* ── Pull requests view ── */

export function PrsView({ snapshot, connection, pending, showToast, post, refresh, openWorkerPicker, openJob, openReposSettings }: ViewProps): ReactNode {
  const busyByPr = new Map(snapshot?.prs.map(pr => [pr, findBusyJob(pr, snapshot.jobs)]) ?? [])
  const workingAgentByPr = new Map(snapshot?.prs.map(pr => [pr, findWorkingAgent(pr, snapshot.jobs)]) ?? [])
  const prs = snapshot?.prs ?? []
  const status = snapshot?.prDashboard
  const groups = groupByRepo(prs, enabledRepos(snapshot))
  const prsLoading = status?.state === 'loading' || status?.refreshing === true
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggleRepo = (repoSlug: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(repoSlug)) next.delete(repoSlug)
      else next.add(repoSlug)
      return next
    })
  }

  const runPrAction = (cloneName: string, action: PrAction): void => {
    if (action === 'merge-base-direct') {
      void post('/api/pr-action', { name: cloneName, action }, `merge-base-direct:${cloneName}`)
      return
    }
    const defaultWorker = snapshot?.workers.find(worker => worker.enabled)
    if (defaultWorker === undefined) {
      showToast('请先添加可用的 Worker', true)
      return
    }
    const available = snapshot?.workerTypes.find(status => status.type === defaultWorker.type)?.available === true
    if (available !== true) {
      openWorkerPicker(cloneName, action)
      return
    }
    void post('/api/pr-action', { name: cloneName, action }, `${action}:${cloneName}`)
  }

  return (
    <>
      {status !== undefined && status.state === 'error' && (
        <div style={errorStripStyle}>
          <span style={{ display: 'inline-flex', flex: 'none', color: warn }}><GAlert size={13} /></span>
          <span style={errorStripTextStyle}>PR 状态刷新失败，正在显示上次可用数据</span>
        </div>
      )}
      {status !== undefined && status.state === 'loading' && prs.length > 0 && (
        <div style={loadingStripStyle}>
          <StatusDot tone="accent" pulse />
          <span>正在刷新上次保存的 PR 状态</span>
        </div>
      )}
      <div style={tableScrollStyle}>
        {snapshot === undefined && (
          <div style={emptyStateStyle}>
            <span style={emptyStateLineStyle}>
              <StatusDot tone="accent" pulse />
              <span>{connection === 'reconnecting' ? '正在重新连接 dshw daemon…' : '正在加载追踪中的 PR…'}</span>
            </span>
          </div>
        )}
        {snapshot !== undefined && (snapshot.repos?.length ?? 0) === 0 && (
          <div style={emptyStateStyle}>
            <p style={emptyStateTitleStyle}>还没有选择要监控的仓库</p>
            <p style={emptyStateSubStyle}>勾选仓库后，你创建或 assign 给你的 open PR 会自动显示在这里</p>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={openReposSettings}>去设置 Repos →</button>
          </div>
        )}
        {snapshot !== undefined && enabledRepos(snapshot).length > 0 && (
          <table style={{ ...tableStyle, tableLayout: 'auto' }}>
            <thead>
              <tr>
                <th style={thStyle}>Pull request</th>
                {/* CI / Review / Merge / Sync: content-sized columns (max-content),
                    first column absorbs all remaining width */}
                <th style={{ ...thStyle, width: 'max-content' }}>CI</th>
                <th style={{ ...thStyle, width: 'max-content' }}>Review</th>
                <th style={{ ...thStyle, width: 'max-content' }}>Merge</th>
                <th style={{ ...thStyle, width: 'max-content' }}>Sync</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(group => (
                <RepoGroupRow
                  key={group.repoSlug}
                  repoSlug={group.repoSlug}
                  collapsed={collapsed.has(group.repoSlug)}
                  onToggle={toggleRepo}
                  colSpan={5}
                >
                  {orderStackedPrs(group.records).map(row => {
                    const pr = row.pr
                    const stack = row.depth > 0 || row.hasChild ? { depth: row.depth, hasChild: row.hasChild } : undefined
                    return (
                      <PrRow
                        key={`${pr.repoSlug}-${pr.number}-${pr.cloneName}`}
                        pr={pr}
                        stack={stack}
                        jobs={snapshot.jobs}
                        busy={busyByPr.get(pr)}
                        workingAgent={workingAgentByPr.get(pr)}
                        pending={pending}
                        onAction={runPrAction}
                        onChooseWorker={openWorkerPicker}
                        onToggleSync={(name, enabled) => { void post('/api/sync/toggle', { name, enabled }, `sync-toggle:${name}`) }}
                        onGitAction={(name, action) => { void post('/api/clone/maintenance', { name, action }, `git-maintenance:${name}`) }}
                        onRefresh={refresh}
                        onOpenJob={openJob}
                      />
                    )
                  })}
                  {group.records.length === 0 && prsLoading && (
                    <tr>
                      <td colSpan={5} style={prLoadingRowStyle}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <StatusDot tone="accent" pulse />
                          <span>正在加载 PR…</span>
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

/* ── one PR row ── */

/** stack 中非根部（叠在其他 PR 之上）的 PR 统一缩进量；最接近 master 的根部不缩进。 */
const STACK_CHILD_INDENT = 12

export function PrRow({ pr, stack, jobs, busy, workingAgent, pending, onAction, onChooseWorker, onToggleSync, onGitAction, onRefresh, onOpenJob }: {
  pr: PrDashboardRecord
  /** 所在 stack 的树位置；undefined = 不在 stack 中。 */
  stack?: { depth: number; hasChild: boolean }
  jobs: readonly JobRecord[]
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
  onToggleSync: (cloneName: string, enabled: boolean) => void
  onGitAction: (cloneName: string, action: GitAction) => void
  onRefresh: () => void
  onOpenJob: (job: JobRecord) => void
}): ReactNode {
  // One <tr> per row — no <tbody> wrapper per row: nested tbodys are invalid
  // markup and the engine drops the row from the fixed column model, which
  // drifts the header/body columns apart. Draft dimming rides the row itself.
  return (
    <tr data-dshw-kanban="row" style={pr.isDraft ? draftRowStyle : trStyle}>
      <td style={{
        ...tdStyle,
        ...(stack === undefined ? {} : { paddingLeft: 12 + (stack.depth > 0 ? STACK_CHILD_INDENT : 0) }),
      }}>
        <div style={cellMainStyle}>
          <a style={titleLinkStyle} data-dshw-kanban="titlelink" href={pr.url} title={pr.title} target="_blank" rel="noreferrer">
            <span style={numberStyle}>#{pr.number}</span>
            <span style={{ ...titleStyle, ...(pr.isDraft ? { color: C_SECONDARY } : {}) }}>{pr.title}</span>
          </a>
          {pr.isDraft && <span style={draftBadgeStyle}>草稿</span>}
        </div>
        <div style={cellSubStyle}>
          {hasLocalGitStatus(pr) && pr.localGitStatus !== undefined && (
            <LocalGitChip status={pr.localGitStatus} pending={pending.has(`git-maintenance:${pr.cloneName}`)} onAction={action => onGitAction(pr.cloneName, action)} />
          )}
          {pr.assignedToMe === true && pr.author !== undefined && (
            <span style={assignedBadgeStyle} title={`assign 给你的 PR，作者 @${pr.author}`}>by @{pr.author}</span>
          )}
          <span style={subTextStyle} title={pr.branch}>{pr.branch} → {pr.baseRefName}</span>
        </div>
      </td>

      <td style={tdStyle}>
        <CiCell pr={pr} busy={busy} workingAgent={workingAgent} pending={pending} onAction={onAction} onChooseWorker={onChooseWorker} onOpenJob={onOpenJob} />
      </td>

      <td style={tdStyle}>
        <ReviewCell pr={pr} busy={busy} workingAgent={workingAgent} pending={pending} onAction={onAction} onChooseWorker={onChooseWorker} onOpenJob={onOpenJob} />
      </td>

      <td style={tdStyle}>
        <MergeCell pr={pr} busy={busy} workingAgent={workingAgent} pending={pending} jobs={jobs} onAction={onAction} onChooseWorker={onChooseWorker} onRefresh={onRefresh} onOpenJob={onOpenJob} />
      </td>

      <td style={tdStyle}>
        <div style={syncCellStyle}>
          <span style={syncSwitchRowStyle}>
            <button
              type="button"
              role="switch"
              aria-checked={pr.syncEnabled === true}
              aria-label={`PR #${pr.number} 自动 sync`}
              disabled={pending.has(`sync-toggle:${pr.cloneName}`)}
              onClick={() => { onToggleSync(pr.cloneName, pr.syncEnabled !== true) }}
              style={syncSwitchStyle(pr.syncEnabled === true)}
            >
              <span style={syncKnobStyle(pr.syncEnabled === true)} />
            </button>
          </span>
          {pr.agentPausedReason !== undefined && (
            <button type="button" className="dshw-link" style={pausedButtonStyle} title={pr.agentPausedReason} onClick={onRefresh}>
              自动任务已暂停 · 查看原因
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}


/* ── column cells ── */

export function CiCell({ pr, busy, workingAgent, pending, onAction, onChooseWorker, onOpenJob }: {
  pr: PrDashboardRecord
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
  onOpenJob: (job: JobRecord) => void
}): ReactNode {
  const ordered = [...pr.checks].sort((a, b) => rank(a) - rank(b))
  const passed = pr.checks.filter(check => check.bucket === 'pass').length
  const failed = pr.checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel').length
  const pendingCount = pr.checks.filter(check => check.bucket === 'pending').length
  const note = failed > 0 ? `${failed} 个失败` : pendingCount > 0 ? `${pendingCount} 个运行中` : pr.checks.length > 0 ? '' : '尚无 checks'
  if (busy?.type === 'fix-ci') {
    return (
      <div style={cellColumnStyle}>
        <button type="button" className="dshw-link" style={busyRowStyle} onClick={() => { onOpenJob(busy) }}><StatusDot tone="accent" pulse />修复中 · 查看</button>
      </div>
    )
  }
  return (
    <div style={cellColumnStyle}>
      <HoverPopover label={`PR #${pr.number} CI checks`} width={360} maxHeight={300} render={close => (
        <div>
          {ordered.length === 0 && <div style={popoverEmptyStyle}>尚无 checks</div>}
          {ordered.map(check => (
            <a key={`${check.name}-${check.link}`} style={popoverRowStyle} href={check.link || pr.url} target="_blank" rel="noreferrer" title={check.workflow}>
              <StatusIcon tone={checkTone(check)} size={12} />
              <span style={popoverRowTextStyle}>{check.name}</span>
              <span style={{ ...popoverRowBadgeStyle, color: toneColor(checkTone(check)) }}>{checkLabel(check)}</span>
            </a>
          ))}
        </div>
      )}>
        {(_, setOpen) => (
          <>
            <span style={statusGlyphStyle}><StatusIcon tone={ciTone(pr.ciStatus)} /></span>
            <span style={statusTextStyle}>{ciLabel(pr.ciStatus)}</span>
            {pr.checks.length > 0 && <span style={countStyle}>{passed}/{pr.checks.length}</span>}
          </>
        )}
      </HoverPopover>
      <div style={cellNoteRowStyle}>
        {note !== '' && <span style={cellNoteStyle}>{note}</span>}
        {(pr.ciStatus === 'failed' || pr.checks.some(check => check.bucket === 'fail' || check.bucket === 'cancel')) && (
          <>
            {note !== '' && <span style={noteSeparatorStyle}>·</span>}
            <button
              type="button"
              className="dshw-link" style={actionLinkStyle}
              disabled={workingAgent !== undefined || pending.has(`fix-ci:${pr.cloneName}`)}
              title={workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : '单击使用默认 Worker · 右键选择 Worker'}
              onClick={() => { onAction(pr.cloneName, 'fix-ci') }}
              onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, 'fix-ci') }}
            >修 CI</button>
          </>
        )}
      </div>
    </div>
  )
}

export function ReviewCell({ pr, busy, workingAgent, pending, onAction, onChooseWorker, onOpenJob }: {
  pr: PrDashboardRecord
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
  onOpenJob: (job: JobRecord) => void
}): ReactNode {
  const requested = [...new Set(pr.reviewRequests ?? [])]
  const byLogin = new Map<string, PullRequestReview>()
  for (const review of pr.reviews ?? []) {
    const login = review.author?.login
    if (login !== undefined) byLogin.set(login, review)
  }
  const reviewed = [...byLogin.entries()].map(([login, review]) => ({ login, review }))
  const people = [...new Set([...requested, ...reviewed.map(item => item.login)])]
  const summary = requested.length > 0
    ? `${requested.length} 人等待`
    : reviewed.length > 0
      ? `${reviewed.length} 人已 review`
      : '尚未 request review'
  const avatar = (login: string): string => `https://github.com/${encodeURIComponent(login)}.png?size=64`
  if (busy?.type === 'resolve-comments') {
    return (
      <div style={cellColumnStyle}>
        <button type="button" className="dshw-link" style={busyRowStyle} onClick={() => { onOpenJob(busy) }}><StatusDot tone="accent" pulse />解决评论中 · 查看</button>
      </div>
    )
  }
  return (
    <div style={cellColumnStyle}>
      <HoverPopover label={`PR #${pr.number} reviews`} width={380} maxHeight={340} render={close => (
        <div>
          {requested.length === 0 && reviewed.length === 0 && <div style={popoverEmptyStyle}>尚未 request review</div>}
          {requested.length > 0 && (
            <div style={popoverSectionStyle}>
              <div style={popoverSectionTitleStyle}>等待 Review</div>
              {requested.map(login => (
                <a key={`requested-${login}`} className="dshw-poprow" style={popoverPersonRowStyle} href={`https://github.com/${login}`} target="_blank" rel="noreferrer">
                  <img style={avatarStyle} src={avatar(login)} alt={login} />
                  <span style={popoverRowTextStyle}>@{login}</span>
                  <span style={{ ...popoverRowBadgeStyle, color: warn }}><StatusIcon tone="warn" size={11} />等待 review</span>
                </a>
              ))}
            </div>
          )}
          {reviewed.length > 0 && (
            <div style={{ ...popoverSectionStyle, ...(requested.length > 0 ? popoverSectionSpacedStyle : {}) }}>
              <div style={popoverSectionTitleStyle}>已 Review</div>
              {reviewed.map(item => (
                <a key={`reviewed-${item.login}`} className="dshw-poprow" style={popoverPersonRowStyle} href={`${pr.url}/files`} target="_blank" rel="noreferrer">
                  <img style={avatarStyle} src={avatar(item.login)} alt={item.login} />
                  <span style={popoverRowTextStyle}>@{item.login}</span>
                  <span style={{ ...popoverRowBadgeStyle, color: toneColor(reviewStateTone(item.review, pr)) }}>
                    <StatusIcon tone={reviewStateTone(item.review, pr)} size={11} />
                    {reviewState(item.review, pr)}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}>
        {(_, setOpen) => (
          <>
            <span style={statusGlyphStyle}><StatusIcon tone={reviewTone(pr.reviewDecision)} /></span>
            <span style={statusTextStyle}>{reviewLabel(pr.reviewDecision)}</span>
            {people.length > 0 && (
              <span style={avatarStackStyle} aria-hidden="true">
                {people.slice(0, 3).map(login => <img key={login} style={stackAvatarStyle} src={avatar(login)} alt="" />)}
                {people.length > 3 && <span style={stackMoreStyle}>+{people.length - 3}</span>}
              </span>
            )}
          </>
        )}
      </HoverPopover>
      <div style={cellNoteRowStyle}>
        <span style={cellNoteStyle} title={summary}>{summary}</span>
        {pr.unresolvedComments !== undefined && pr.unresolvedComments > 0 && (
          <>
            <span style={noteSeparatorStyle}>·</span>
            <button
              type="button"
              className="dshw-link" style={actionLinkStyle}
              disabled={workingAgent !== undefined || pending.has(`resolve-comments:${pr.cloneName}`)}
              title={workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : '单击使用默认 Worker · 右键选择 Worker'}
              onClick={() => { onAction(pr.cloneName, 'resolve-comments') }}
              onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, 'resolve-comments') }}
            >解决 {pr.unresolvedComments} 条评论</button>
          </>
        )}
      </div>
    </div>
  )
}

export function MergeCell({ pr, busy, workingAgent, pending, jobs, onAction, onChooseWorker, onRefresh, onOpenJob }: {
  pr: PrDashboardRecord
  busy?: JobRecord
  workingAgent?: JobRecord
  pending: ReadonlySet<string>
  jobs: readonly JobRecord[]
  onAction: (cloneName: string, action: PrAction) => void
  onChooseWorker: (cloneName: string, action: PrAction) => void
  onRefresh: () => void
  onOpenJob: (job: JobRecord) => void
}): ReactNode {
  const action = mergeAction(pr)
  const busyHere = busy !== undefined && busy.type !== 'fix-ci' && busy.type !== 'resolve-comments'
  const autoAt = autoMergeAt(pr)
  const failedMerge = lastFailedMerge(pr, jobs)
  return (
    <div style={cellColumnStyle}>
      {pr.mergeable === 'CONFLICTING'
        ? (
          <HoverPopover label={`PR #${pr.number} 冲突文件`} width={420} maxHeight={280} render={close => (
            <div>
              <div style={popoverSectionTitleStyle}>冲突文件</div>
              {pr.conflictPaths === undefined && <div style={popoverEmptyStyle}>暂时无法读取冲突文件</div>}
              {pr.conflictPaths !== undefined && pr.conflictPaths.length === 0 && <div style={popoverEmptyStyle}>本地未检测到冲突文件</div>}
              {pr.conflictPaths !== undefined && pr.conflictPaths.map(path => (
                <div key={path} style={conflictPathStyle}>{path}</div>
              ))}
            </div>
          )}>
            {(_, setOpen) => (
              <>
                <span style={statusGlyphStyle}><StatusIcon tone="bad" /></span>
                <span style={statusTextStyle}>冲突</span>
                  </>
            )}
          </HoverPopover>
        )
        : (
          <span style={{ ...mergeableLabelStyle, color: toneColor(mergeTone(pr.mergeable)) }}>
            <StatusIcon tone={mergeTone(pr.mergeable)} />
            {mergeLabel(pr.mergeable)}
          </span>
        )}
      {busyHere && (
        <button type="button" className="dshw-link" style={busyRowStyle} onClick={() => { onOpenJob(busy) }}><StatusDot tone="accent" pulse />{busyLabel(busy)} · 查看</button>
      )}
      {!busyHere && autoAt !== undefined && (
        <div style={cellNoteRowStyle}>
          <span style={cellNoteStyle}>约 {autoMergeMinutes(pr)} 分钟</span>
          <span style={noteSeparatorStyle}>·</span>
          <button
            type="button"
            className="dshw-link" style={actionLinkStyle}
            disabled={workingAgent !== undefined || pending.has(`merge-base:${pr.cloneName}`)}
            title={workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : '单击使用默认 Worker · 右键选择 Worker'}
            onClick={() => { onAction(pr.cloneName, 'merge-base') }}
            onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, 'merge-base') }}
          >立即合并</button>
        </div>
      )}
      {!busyHere && autoAt === undefined && action !== undefined && (
        <div style={cellNoteRowStyle}>
          {pr.autoMergeSkippedReason !== undefined && (
            <span style={cellNoteStyle} title={pr.autoMergeSkippedReason}>{pr.autoMergeSkippedReason}</span>
          )}
          {pr.autoMergeSkippedReason === undefined && failedMerge !== undefined && (
            <span style={{ ...cellNoteStyle, color: warn }} title={failedMerge.summary}>上次合并失败</span>
          )}
          {(pr.autoMergeSkippedReason !== undefined || failedMerge !== undefined) && <span style={noteSeparatorStyle}>·</span>}
          <button
            type="button"
            className="dshw-link" style={actionLinkStyle}
            disabled={(action === 'merge-base' && workingAgent !== undefined)
              || pending.has(`merge-base:${pr.cloneName}`)
              || pending.has(`merge-base-direct:${pr.cloneName}`)}
            title={action === 'merge-base' && workingAgent !== undefined ? '该 PR 已有 Agent 正在工作' : undefined}
            onClick={() => { onAction(pr.cloneName, action) }}
            onContextMenu={(e) => { e.preventDefault(); onChooseWorker(pr.cloneName, action) }}
          >合并 {pr.baseRefName}</button>
        </div>
      )}
    </div>
  )
}

/* ── local git status chip + maintenance popover ── */

export function LocalGitChip({ status, pending, onAction }: {
  status: CloneGitStatus
  pending: boolean
  onAction: (action: GitAction) => void
}): ReactNode {
  const dirty = status.unstaged || status.staged || status.merging
  const label = [
    status.unstaged ? '*' : '',
    status.staged ? '+' : '',
    status.merging ? '!' : '',
    status.ahead > 0 ? `↑${status.ahead}` : '',
    status.behind > 0 ? `↓${status.behind}` : '',
  ].join('')
  const run = (action: GitAction): void => {
    const confirmed = action === 'discard-unstaged'
      ? window.confirm('撤销所有未暂存更改？\n\n未暂存和未跟踪的内容都将永久删除，已暂存内容会保留。')
      : action === 'discard-staged'
        ? window.confirm('撤销所有未提交更改？\n\n已暂存的内容将永久删除。')
        : action === 'abort-merge'
          ? window.confirm('终止当前 merge？')
          : action === 'discard-unpushed'
            ? window.confirm(`丢弃 ${status.ahead} 个未推送提交？\n\n本地分支将重置到远端，无法从此菜单撤销。`)
            : true
    if (confirmed) onAction(action)
  }
  return (
    <HoverPopover label="本地 Git 状态与操作" width={240} maxHeight={300} hoverClass="dshw-chip" render={close => (
      <div>
        {status.unstaged && <PopoverAction label="撤销未暂存" badge="*" disabled={pending || status.merging} title={status.merging ? '请先终止 merge' : ''} onClick={() => run('discard-unstaged')} />}
        {status.staged && <PopoverAction label="撤销未提交" badge="+" disabled={pending || status.unstaged || status.merging} title={status.merging ? '请先终止 merge' : status.unstaged ? '请先撤销未暂存' : ''} onClick={() => run('discard-staged')} />}
        {status.merging && <PopoverAction label="终止 merge" badge="!" disabled={pending} onClick={() => run('abort-merge')} />}
        {status.ahead > 0 && !dirty && <PopoverAction label="丢弃未推送提交" badge={`↑${status.ahead}`} disabled={pending} onClick={() => run('discard-unpushed')} />}
        {status.behind > 0 && <PopoverAction label="拉取远端提交" badge={`↓${status.behind}`} disabled={pending || status.ahead > 0} title={status.ahead > 0 ? '请先处理未推送提交' : ''} onClick={() => run('pull')} />}
        {pending && <div style={popoverEmptyStyle}>正在更新…</div>}
      </div>
    )}>
      {(_, setOpen) => (
        <span data-dshw-kanban="gitchip" style={gitChipStyle}>{label}</span>
      )}
    </HoverPopover>
  )
}

export function PopoverAction({ label, badge, disabled, title, onClick }: {
  label: string
  badge: string
  disabled?: boolean
  title?: string
  onClick: () => void
}): ReactNode {
  return (
    <button type="button" style={popoverActionStyle} disabled={disabled} title={title} onClick={onClick}>
      <span>{label}</span>
      <span style={{ marginLeft: 'auto', color: warn, fontSize: 11.5, fontWeight: 600 }}>{badge}</span>
    </button>
  )
}
