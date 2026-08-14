/** Kanban workspace: owns the data channel, action plumbing, the tab bar and
 *  the shared job dialog; every view is presentational over {@link ViewProps}. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBranchOutline16, IconInspectOutline12, IconListPenOutline16, IconSettingsOutline16,
  IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { JobRecord, WorkerConfig, WorkerTypeAvailability } from '../../src/types.ts'
import { useKanbanData, type KanbanSnapshot, type PrAction } from './data.ts'
import { GGitGraph } from './icons.tsx'
import {
  dialogCancelStyle, dialogCloseRowStyle, dialogInputStyle, dialogListStyle,
  dialogMaskStyle, dialogOverlayStyle, dialogStyle, dialogTitleStyle, dialogWorkerNameStyle,
  dialogWorkerRowStyle, dialogWorkerTypeStyle, popoverEmptyStyle,
  rootStyle, tabCountStyle, tabStyle, tabbarStyle, toastStyle, viewAreaStyle,
} from './styles.ts'
import { PrsView } from './views/prs.tsx'
import { ReviewsView } from './views/reviews.tsx'
import { JobsView } from './views/jobs.tsx'
import { LogsView } from './views/logs.tsx'
import { GitView } from './views/git.tsx'
import { SettingsView } from './views/settings.tsx'
import { JobDialog } from './views/job-dialog.tsx'

/* ── shared view props + the tabbed workspace ── */

/** Props shared by every kanban view (data + verbs owned by the workspace). */
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
  /** Open the job detail dialog (busy PR rows / jobs list). */
  openJob: (job: JobRecord) => void
}

export type ViewId = 'prs' | 'reviews' | 'git' | 'jobs' | 'logs' | 'settings'

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
  const [workerPick, setWorkerPick] = useState<{ cloneName: string; action: PrAction } | null>(null)
  const [view, setView] = useState<ViewId>('prs')
  const [activeJob, setActiveJob] = useState<JobRecord>()
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
    setWorkerPick({ cloneName, action })
  }

  const startWithWorker = (workerConfigId: string, additionalInstruction: string): void => {
    const launch = workerPick
    if (launch === null) return
    setWorkerPick(null)
    void post('/api/pr-action', {
      name: launch.cloneName,
      action: launch.action,
      workerConfigId,
      additionalInstruction: additionalInstruction.trim(),
    }, `${launch.action}:${launch.cloneName}`)
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
    openJob: setActiveJob,
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
              onClick={() => { setView(tab.id) }}
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
        {view === 'prs' && <PrsView {...viewProps} />}
        {view === 'reviews' && <ReviewsView {...viewProps} />}
        {view === 'jobs' && <JobsView {...viewProps} />}
        {view === 'logs' && <LogsView {...viewProps} />}
        {view === 'git' && <GitView baseUrl={baseUrl} refreshKey={refreshKey} />}
        {view === 'settings' && <SettingsView {...viewProps} />}
      </div>
      {workerPick !== null && snapshot !== undefined && (
        <WorkerPicker
          workers={snapshot.workers}
          workerTypes={snapshot.workerTypes}
          onClose={() => { setWorkerPick(null) }}
          onPick={startWithWorker}
        />
      )}
      {activeJob !== undefined && snapshot !== undefined && (
        <JobDialog
          job={activeJob}
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

/* ── worker picker dialog ── */

export function WorkerPicker({ workers, workerTypes, onClose, onPick }: {
  workers: readonly WorkerConfig[]
  workerTypes: readonly WorkerTypeAvailability[]
  onClose: () => void
  onPick: (workerConfigId: string, additionalInstruction: string) => void
}): ReactNode {
  const [instruction, setInstruction] = useState('')
  const usable = workers.filter(worker => worker.enabled
    && workerTypes.find(status => status.type === worker.type)?.available === true)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label="选择 Worker">
        <div style={dialogTitleStyle}>选择 Worker 执行任务</div>
        <div style={dialogListStyle}>
          {usable.map(worker => (
            <button
              key={worker.id}
              type="button"
              style={dialogWorkerRowStyle}
              onClick={() => { onPick(worker.id, instruction) }}
            >
              <span style={dialogWorkerNameStyle}>{worker.name}</span>
              <span style={dialogWorkerTypeStyle}>{worker.type}{worker.model !== undefined ? ` · ${worker.model}` : ''}</span>
            </button>
          ))}
          {usable.length === 0 && <div style={popoverEmptyStyle}>没有可用的 Worker</div>}
        </div>
        <input
          style={dialogInputStyle}
          placeholder="附加指令（可选）"
          value={instruction}
          onChange={event => { setInstruction(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter' && usable.length > 0) onPick(usable[0]!.id, instruction) }}
        />
        <div style={dialogCloseRowStyle}>
          <button type="button" style={dialogCancelStyle} onClick={onClose}>取消</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
