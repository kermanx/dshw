/** Kanban workspace: owns the data channel, action plumbing, the tab bar and
 *  the shared job dialog; every view is presentational over {@link ViewProps}. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBranchOutline16, IconInspectOutline12, IconListPenOutline16, IconSettingsOutline16,
  IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { JobRecord, ReviewRequestRecord, WorkerConfig, WorkerTypeAvailability } from '../../src/types.ts'
import { useKanbanData, enabledRepos, type KanbanSnapshot, type PrAction } from './data.ts'
import { GClose, GGitGraph } from './icons.tsx'
import {
  draftBadgeStyle, primaryButtonStyle,
  rootStyle, tabCountStyle, tabStyle, tabbarStyle, toastStyle, viewAreaStyle,
  workerPickerBodyStyle, workerPickerEmptyStyle, workerPickerFieldLabelStyle,
  workerPickerFooterStyle, workerPickerGhostStyle, workerPickerHeaderStyle,
  workerPickerLegendStyle, workerPickerNameRowStyle, workerPickerNameStyle,
  workerPickerOverlayStyle, workerPickerRowStyle, workerPickerRowTextStyle,
  workerPickerStyle, workerPickerSublineStyle, workerPickerSubtitleStyle,
  workerPickerTextareaStyle, workerPickerTitleStyle, workerPickerCloseStyle,
} from './styles.ts'
import { C_ACCENT, C_HOVER, C_MUTED } from './theme.ts'
import { PrsView } from './views/prs.tsx'
import { ReviewsView } from './views/reviews.tsx'
import { JobsView } from './views/jobs.tsx'
import { LogsView } from './views/logs.tsx'
import { GitView } from './views/git.tsx'
import { SettingsView } from './views/settings.tsx'
import { JobDialog } from './views/job-dialog.tsx'
import { ReviewDetailView } from './views/review-detail.tsx'

/* ── shared view props + the tabbed workspace ── */

/** Props shared by every kanban view (data + verbs owned by the workspace). */
export interface ViewProps {
  baseUrl: string
  snapshot?: KanbanSnapshot
  connection: 'connecting' | 'live' | 'reconnecting'
  pending: ReadonlySet<string>
  showToast: (message: string, bad?: boolean) => void
  post: (path: string, body: object, key: string) => Promise<void>
  refresh: () => void
  /** Open the worker picker for a PR action (right-click / unavailable default). */
  openWorkerPicker: (cloneName: string, action: PrAction) => void
  /** Open the worker picker for a requested Review PR. */
  openReviewWorkerPicker: (repoSlug: string, prNumber: number) => void
  /** Open the review-detail workspace for a Review PR (whole view area). */
  openReviewDetail: (review: ReviewRequestRecord) => void
  /** Open the job detail dialog (busy PR rows / jobs list). */
  openJob: (job: JobRecord) => void
  /** Jump to Settings → Repos (empty-state hint when no repo is monitored). */
  openReposSettings: () => void
}

export type ViewId = 'prs' | 'reviews' | 'git' | 'jobs' | 'logs' | 'settings'
export type SettingsSection = 'repository' | 'workers' | 'repos'

export const VIEW_TABS: ReadonlyArray<{ id: ViewId; icon: (p: { size?: number }) => ReactNode; label: string; count: (s: KanbanSnapshot) => number }> = [
  { id: 'prs', icon: IconBranchOutline16, label: 'Pull requests', count: s => s.prs.length },
  { id: 'reviews', icon: IconUserOutline16, label: 'Reviews', count: s => s.reviewRequests.length },
  { id: 'git', icon: GGitGraph, label: 'Git', count: () => 0 },
  { id: 'jobs', icon: IconListPenOutline16, label: 'Jobs', count: s => s.service.activeJobs },
  { id: 'logs', icon: IconInspectOutline12, label: 'Logs', count: () => 0 },
  { id: 'settings', icon: IconSettingsOutline16, label: 'Settings', count: () => 0 },
]

/** Tabbed workspace: owns the data channel, action plumbing and the tab bar;
 *  every view is presentational over {@link ViewProps}. */
export function KanbanWorkspace({ baseUrl, refreshKey, t, onRefresh }: {
  baseUrl: string
  refreshKey: number
  t: (key: string, params?: Record<string, string | number>) => string
  onRefresh?: () => void
}): ReactNode {
  const { snapshot, connection } = useKanbanData(baseUrl, refreshKey)
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<{ message: string; bad: boolean } | null>(null)
  const [workerPick, setWorkerPick] = useState<
    | { target: 'pr'; cloneName: string; action: PrAction }
    | { target: 'review'; repoSlug: string; prNumber: number }
    | null
  >(null)
  const [view, setView] = useState<ViewId>('prs')
  const [activeJob, setActiveJob] = useState<JobRecord>()
  const [activeReview, setActiveReview] = useState<ReviewRequestRecord>()
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('repos')
  const toastTimer = useRef<number | undefined>(undefined)

  const showToast = (message: string, bad = false): void => {
    setToast({ message, bad })
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => { setToast(null) }, 2_600)
  }
  useEffect(() => () => { if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current) }, [])

  const post = async (path: string, body: object, key: string): Promise<void> => {
    if (pending.has(key)) return
    setPending(previous => new Set(previous).add(key))
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? '请求失败')
      showToast('操作已提交')
    } catch (error) {
      showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setPending(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  const refresh = (): void => {
    onRefresh?.()
    void post('/api/prs/refresh', {}, 'prs-refresh')
  }

  const openWorkerPicker = (cloneName: string, action: PrAction): void => {
    const usable = snapshot?.workers.some(worker => worker.enabled
      && snapshot.workerTypes.find(status => status.type === worker.type)?.available === true) === true
    if (!usable) {
      showToast('请先添加可用的 Worker', true)
      return
    }
    setWorkerPick({ target: 'pr', cloneName, action })
  }

  const openReviewWorkerPicker = (repoSlug: string, prNumber: number): void => {
    const usable = snapshot?.workers.some(worker => worker.enabled
      && snapshot.workerTypes.find(status => status.type === worker.type)?.available === true) === true
    if (!usable) {
      showToast('请先添加可用的 Worker', true)
      return
    }
    setWorkerPick({ target: 'review', repoSlug, prNumber })
  }

  const startWithWorker = (workerConfigId: string, additionalInstruction: string): void => {
    const launch = workerPick
    if (launch === null) return
    setWorkerPick(null)
    if (launch.target === 'pr') {
      void post('/api/pr-action', {
        name: launch.cloneName,
        action: launch.action,
        workerConfigId,
        additionalInstruction: additionalInstruction.trim(),
      }, `${launch.action}:${launch.cloneName}`)
      return
    }
    void startReviewWithWorker(launch.repoSlug, launch.prNumber, workerConfigId, additionalInstruction.trim())
  }

  const startReviewWithWorker = async (repoSlug: string, prNumber: number, workerConfigId: string, additionalInstruction: string): Promise<void> => {
    const key = `review:${repoSlug}#${prNumber}`
    if (pending.has(key)) return
    setPending(previous => new Set(previous).add(key))
    try {
      let stashDirty = false
      for (;;) {
        const response = await fetch(`${baseUrl}/api/review-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoSlug, number: prNumber, workerConfigId, additionalInstruction, stashDirty }),
        })
        const value = await response.json() as { error?: string; needsStash?: boolean; clonePath?: string; dirtySummary?: string; stashed?: boolean }
        if (response.status === 409 && value.needsStash === true && !stashDirty) {
          const detail = value.dirtySummary?.trim()
          const confirmed = window.confirm([
            `Review 本地分支存在未提交改动：${value.clonePath ?? ''}`,
            detail === undefined || detail === '' ? '' : `\n${detail}`,
            '\n启动对话前会把这些改动（含未跟踪文件）stash，然后同步到远端最新版本。继续？',
          ].join('\n'))
          if (!confirmed) {
            showToast('已取消启动 Review 对话')
            return
          }
          stashDirty = true
          continue
        }
        if (!response.ok) throw new Error(value.error ?? '请求失败')
        showToast(value.stashed === true ? '本地改动已 stash，Review 对话已启动' : 'Review 对话已启动')
        return
      }
    } catch (error) {
      showToast(`启动失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setPending(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }

  const viewProps: ViewProps = {
    baseUrl,
    snapshot,
    connection,
    pending,
    showToast,
    post,
    refresh,
    openWorkerPicker,
    openReviewWorkerPicker,
    openReviewDetail: setActiveReview,
    openJob: setActiveJob,
    openReposSettings: () => { setSettingsSection('repos'); setView('settings') },
  }

  return (
    <div style={rootStyle} data-dshw-kanban="root">
      <div style={tabbarStyle} role="tablist" aria-label="dshw views">
        {VIEW_TABS.map(tab => {
          const active = view === tab.id
          const count = snapshot === undefined ? 0 : tab.count(snapshot)
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-selected={active || undefined}
              onClick={() => {
                setActiveReview(undefined)
                // Opening Settings from the tab bar always lands on its first page (Repos);
                // only the "去设置 Repos" empty-state link jumps to a specific section.
                if (tab.id === 'settings') setSettingsSection('repos')
                setView(tab.id)
              }}
              style={tabStyle(active)}
            >
              <Icon size={14} />
              <span>{tab.label}</span>
              {count > 0 && <span style={tabCountStyle}>{count}</span>}
            </button>
          )
        })}
      </div>
      <div style={viewAreaStyle}>
        {activeReview !== undefined ? (
          <ReviewDetailView
            baseUrl={baseUrl}
            review={activeReview}
            snapshot={snapshot}
            pending={pending}
            showToast={showToast}
            post={post}
            onBack={() => { setActiveReview(undefined) }}
            openReviewWorkerPicker={openReviewWorkerPicker}
            openJob={setActiveJob}
          />
        ) : (
          <>
            {view === 'prs' && <PrsView {...viewProps} />}
            {view === 'reviews' && <ReviewsView {...viewProps} />}
            {view === 'jobs' && <JobsView {...viewProps} />}
            {view === 'logs' && <LogsView {...viewProps} />}
            {view === 'git' && <GitView baseUrl={baseUrl} refreshKey={refreshKey} repos={enabledRepos(snapshot)} openReposSettings={viewProps.openReposSettings} />}
            {view === 'settings' && <SettingsView {...viewProps} initialSection={settingsSection} />}
          </>
        )}
      </div>
      {workerPick !== null && snapshot !== undefined && (
        <WorkerPicker
          action={workerPick.target === 'pr' ? workerPick.action : 'review'}
          workers={snapshot.workers}
          workerTypes={snapshot.workerTypes}
          onClose={() => { setWorkerPick(null) }}
          onPick={startWithWorker}
        />
      )}
      {activeJob !== undefined && snapshot !== undefined && (
        <JobDialog
          job={snapshot.jobs.find(job => job.id === activeJob.id) ?? activeJob}
          baseUrl={baseUrl}
          snapshot={snapshot}
          pending={pending}
          post={post}
          onClose={() => { setActiveJob(undefined) }}
        />
      )}
      {toast !== null && <div style={toastStyle} role="status">{toast.message}</div>}
    </div>
  )
}

/* ── worker picker dialog（WorkerLaunchDialog.vue 移植：radio 单选 + 附加指令 + 启动任务） ── */

export function WorkerPicker({ action, workers, workerTypes, onClose, onPick }: {
  action: PrAction | 'review'
  workers: readonly WorkerConfig[]
  workerTypes: readonly WorkerTypeAvailability[]
  onClose: () => void
  onPick: (workerConfigId: string, additionalInstruction: string) => void
}): ReactNode {
  const usable = workers.filter(worker => worker.enabled
    && workerTypes.find(status => status.type === worker.type)?.available === true)
  const [selectedId, setSelectedId] = useState(usable[0]?.id ?? '')
  const [instruction, setInstruction] = useState('')

  // 默认选中第一个可用 worker；列表变化时保持选中有效
  useEffect(() => {
    if (!usable.some(worker => worker.id === selectedId)) setSelectedId(usable[0]?.id ?? '')
  }, [usable, selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  const custom = action === 'custom' || action === 'review'
  const title = action === 'merge-base' ? '合并 base' : action === 'fix-ci' ? '修复 CI' : action === 'resolve-comments' ? '解决评论' : action === 'review' ? 'Review 对话' : '自定义任务'
  const subtitle = (worker: WorkerConfig): string => {
    const type = worker.type === 'dsh' ? 'dsh' : worker.type === 'codex' ? 'Codex' : 'Claude Code'
    return `${type} · ${worker.model || '默认模型'} · ${worker.reasoningEffort || '默认推理'}`
  }

  return createPortal(
    <div style={workerPickerOverlayStyle} role="presentation" data-dshw-kanban="root"
      onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <section style={workerPickerStyle} role="dialog" aria-modal="true" aria-label="启动任务">
        <header style={workerPickerHeaderStyle}>
          <div style={{ minWidth: 0 }}>
            <h2 style={workerPickerTitleStyle}>启动任务</h2>
            <div style={workerPickerSubtitleStyle}>{title}</div>
          </div>
          <button
            type="button"
            className="dshw-icon"
            style={workerPickerCloseStyle}
            aria-label="关闭"
            onClick={onClose}
          ><GClose size={15} /></button>
        </header>
        <div style={workerPickerBodyStyle}>
          <fieldset style={{ margin: 0, padding: 0, border: 'none' }}>
            <legend style={workerPickerLegendStyle}>Worker</legend>
            {usable.map(worker => (
              <label
                key={worker.id}
                className="dshw-wprow"
                style={{ ...workerPickerRowStyle, ...(selectedId === worker.id ? { background: C_HOVER } : {}) }}
              >
                <input
                  type="radio"
                  name="worker"
                  checked={selectedId === worker.id}
                  onChange={() => { setSelectedId(worker.id) }}
                  style={{ flex: 'none', margin: 0, accentColor: C_ACCENT, cursor: 'pointer' }}
                />
                <span style={workerPickerRowTextStyle}>
                  <span style={workerPickerNameRowStyle}>
                    <span style={workerPickerNameStyle}>{worker.name}</span>
                    {worker.isDefault && <span style={draftBadgeStyle}>默认</span>}
                  </span>
                  <span style={workerPickerSublineStyle}>{subtitle(worker)}</span>
                </span>
              </label>
            ))}
            {usable.length === 0 && <div style={workerPickerEmptyStyle}>没有可用的 Worker</div>}
          </fieldset>
          <label style={workerPickerFieldLabelStyle}>
            <span>{custom ? '任务指令' : '额外指令'} {!custom && <span style={{ fontWeight: 400, color: C_MUTED }}>（可选）</span>}</span>
            <textarea
              className="dshw-wpta"
              style={workerPickerTextareaStyle}
              maxLength={4000}
              autoFocus={custom}
              placeholder={action === 'review' ? '输入想让 Worker 检查、解释或分析的内容' : custom ? '描述希望 Worker 在这个 PR 分支上完成的工作' : '例如：只修改相关文件，不要调整现有 API'}
              value={instruction}
              onChange={event => { setInstruction(event.target.value) }}
            />
          </label>
        </div>
        <footer style={workerPickerFooterStyle}>
          <button type="button" className="dshw-btn-ghost" style={workerPickerGhostStyle} onClick={onClose}>取消</button>
          <button type="button" style={primaryButtonStyle} disabled={selectedId === '' || (custom && instruction.trim() === '')} onClick={() => { onPick(selectedId, instruction) }}>启动任务</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
