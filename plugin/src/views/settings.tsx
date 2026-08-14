/** Settings view (WorkerSettings.vue port): repository management + workers
 *  table with drag reorder; the add/edit and cleanup dialogs live in
 *  worker-form-dialog.tsx / worktree-cleanup-dialog.tsx. */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { WorkerConfig, WorkerModelCatalog, WorktreeCleanupPreview } from '../../../src/types.ts'
import {
  GDownload, GGrip, GKey, GPencil, GPlus, GRepository, GReset, GSettings, GSync, GTrash,
  GWorktree, StatusDot,
} from '../icons.tsx'
import {
  actionLinkStyle, cellBlockStyle, emptyStateStyle, jobsScrollStyle, tableStyle,
  tdCompactStyle, thStyle,
} from '../styles.ts'
import { ok, warn, C_ACCENT, C_BADGE, C_BADGE_FG, C_BORDER, C_DANGER, C_FAINT, C_HOVER, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, C_WARNING, FONT_MONO } from '../theme.ts'
import type { ViewProps } from '../workspace.tsx'
import { WorkerFormDialog, type WorkerForm } from './worker-form-dialog.tsx'
import { WorktreeCleanupDialog } from './worktree-cleanup-dialog.tsx'

/* ── Settings view (WorkerSettings.vue port) ── */

export function emptyWorkerForm(): WorkerForm {
  return {
    name: '', type: 'dsh', enabled: true,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: '',
    baseUrl: '', searchBaseUrl: '', apiKeyMode: 'value', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '',
  }
}

export function SettingsView(props: ViewProps): ReactNode {
  const { baseUrl, snapshot, showToast, post } = props
  const [section, setSection] = useState<'repository' | 'workers'>('repository')
  const [editing, setEditing] = useState<WorkerConfig>()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<WorkerForm>(emptyWorkerForm)
  const [modelCatalog, setModelCatalog] = useState<WorkerModelCatalog>()
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState('')
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<string>()
  const [reordering, setReordering] = useState(false)
  const [draggedId, setDraggedId] = useState<string>()
  const [dragOverId, setDragOverId] = useState<string>()
  const [displayedWorkers, setDisplayedWorkers] = useState<WorkerConfig[]>(snapshot?.workers ?? [])
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [cleanupPreview, setCleanupPreview] = useState<WorktreeCleanupPreview>()
  const [cleanupDecisions, setCleanupDecisions] = useState<Record<string, 'keep' | 'delete'>>({})
  const [repositoryRefreshing, setRepositoryRefreshing] = useState(false)

  const workers = snapshot?.workers ?? []
  const workerTypes = snapshot?.workerTypes ?? []
  const repository = snapshot?.harnessRepository
  const dshwRepository = snapshot?.dshwRepository
  const devMode = snapshot?.service.devMode === true
  const worktreeCount = snapshot?.clones.length ?? 0
  const worktreeCleanupCount = snapshot?.worktreeCleanupCount

  useEffect(() => {
    if (snapshot === undefined) return
    if (draggedId === undefined) setDisplayedWorkers(snapshot.workers)
  }, [snapshot, draggedId])

  const typeLabel = (type: WorkerConfig['type']): string =>
    type === 'dsh' ? 'dsh' : type === 'codex' ? 'Codex' : 'Claude Code'
  const credentialLabel = (worker: WorkerConfig): string =>
    worker.type === 'codex' ? '本机配置'
      : worker.credentialSource === 'saved' ? '已保存'
        : worker.credentialSource === 'environment' ? '环境变量' : '未配置'
  const workerAvailable = (worker: WorkerConfig): boolean =>
    worker.enabled && workerTypes.find(status => status.type === worker.type)?.available === true
  const workerStatus = (worker: WorkerConfig): string =>
    !worker.enabled ? '未启用' : workerAvailable(worker) ? '可用' : '不可用'

  const repositoryLag = (): string => {
    if (repository?.state === 'error') return '暂时无法确认与上游的差异'
    const behind = repository?.behind ?? 0
    const lag = behind === 0 ? '当前已与上游一致' : `当前落后上游 ${behind} 个提交`
    return repository?.dirty === true ? `${lag} · 有本地内容待收起` : lag
  }
  const dshwRepositoryLag = (): string => {
    if (dshwRepository?.state === 'error') return '暂时无法确认与上游的差异'
    const behind = dshwRepository?.behind ?? 0
    const lag = behind === 0 ? '当前已与上游一致' : `当前落后上游 ${behind} 个提交`
    return dshwRepository?.dirty === true ? `${lag} · 有本地修改` : lag
  }
  const worktreeSummary = (): string => worktreeCleanupCount === undefined
    ? `当前 ${worktreeCount} 个，可清理数量待确认`
    : `当前 ${worktreeCount} 个，其中 ${worktreeCleanupCount} 个可清理`
  const dshwUpdateNoop = dshwRepository?.state === 'ready' && (dshwRepository.behind ?? 0) === 0
  const harnessSyncNoop = repository?.state === 'ready' && (repository.behind ?? 0) === 0 && repository.dirty === false
  const worktreeCleanupNoop = worktreeCleanupCount === 0
  const busy = repositoryRefreshing || cleanupLoading

  /* ── repository section ── */

  const refreshRepositoryState = async (): Promise<void> => {
    if (repositoryRefreshing) return
    setRepositoryRefreshing(true)
    try {
      const response = await fetch(`${baseUrl}/api/repository/refresh`, { method: 'POST' })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      showToast('仓库状态已刷新')
    } catch (error) {
      showToast(`刷新失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setRepositoryRefreshing(false)
    }
  }

  const confirmReconfigure = (): void => {
    const confirmed = window.confirm([
      '从头配置当前 dsh 主仓库？',
      '',
      '这会执行两次 git clean -fdx，删除所有未跟踪和 ignored 文件（包括 .env、node_modules 和构建产物），然后拉取 origin/master、重新安装依赖并运行 typecheck。',
      '',
      '若存在 tracked 或 staged 修改，后台会拒绝执行。',
    ].join('\n'))
    if (confirmed) void post('/api/reconfigure', {}, 'reconfigure-harness')
  }

  const inspectWorktreeCleanup = async (): Promise<void> => {
    if (cleanupLoading) return
    setCleanupLoading(true)
    try {
      const response = await fetch(`${baseUrl}/api/worktrees/cleanup/preview`, { method: 'POST' })
      const value = await response.json() as WorktreeCleanupPreview & { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setCleanupPreview(value)
      if (value.candidates.length === 0) {
        showToast(value.busy > 0 ? '没有可清理的 Worktree；有任务正在使用候选项' : '没有非 active PR 的 Worktree')
        return
      }
      const risky = value.candidates.filter(candidate => candidate.needsDecision)
      if (risky.length === 0) {
        if (window.confirm(`清理 ${value.candidates.length} 个不再对应 active PR 的 Worktree？\n\n这些 Worktree 没有本地改动或未推送提交，将被直接删除。`)) {
          await executeWorktreeCleanup([])
        }
        return
      }
      setCleanupDecisions(Object.fromEntries(risky.map(candidate => [candidate.name, 'keep' as const])))
      setCleanupDialogOpen(true)
    } catch (error) {
      showToast(`检查失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setCleanupLoading(false)
    }
  }

  const executeWorktreeCleanup = async (deleteDirty: string[]): Promise<void> => {
    if (cleanupLoading) return
    setCleanupLoading(true)
    try {
      const response = await fetch(`${baseUrl}/api/worktrees/cleanup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deleteDirty }),
      })
      const value = await response.json() as { deleted?: string[]; failed?: Array<{ name: string; error: string }>; error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setCleanupDialogOpen(false)
      setCleanupPreview(undefined)
      const deleted = value.deleted?.length ?? 0
      const failed = value.failed?.length ?? 0
      showToast(failed > 0 ? `已清理 ${deleted} 个，${failed} 个删除失败` : `已清理 ${deleted} 个 Worktree`, failed > 0)
    } catch (error) {
      showToast(`清理失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setCleanupLoading(false)
    }
  }

  /* ── workers section ── */

  const loadModelCatalog = async (): Promise<void> => {
    setModelLoading(true)
    setModelError('')
    try {
      const query = new URLSearchParams({ type: form.type })
      if (form.provider?.trim() !== undefined && form.provider.trim() !== '') query.set('provider', form.provider.trim())
      const response = await fetch(`${baseUrl}/api/worker-models?${query}`)
      const value = await response.json() as { catalog?: WorkerModelCatalog; error?: string }
      if (!response.ok || value.catalog === undefined) throw new Error(value.error ?? `HTTP ${response.status}`)
      setModelCatalog(value.catalog)
    } catch (error) {
      setModelCatalog(undefined)
      setModelError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelLoading(false)
    }
  }

  useEffect(() => {
    if (dialogOpen) void loadModelCatalog()
  }, [dialogOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = (): void => {
    setEditing(undefined)
    setForm(emptyWorkerForm())
    setDialogOpen(true)
  }

  const openEdit = (worker: WorkerConfig): void => {
    setEditing(worker)
    setForm({
      name: worker.name, type: worker.type, enabled: worker.enabled,
      provider: worker.provider, model: worker.model, reasoningEffort: worker.reasoningEffort ?? '',
      baseUrl: worker.baseUrl, searchBaseUrl: worker.searchBaseUrl, apiKeyMode: worker.apiKeyMode,
      apiKeyEnv: worker.apiKeyEnv, apiKey: '',
    })
    setDialogOpen(true)
  }

  const selectedType = workerTypes.find(status => status.type === form.type)
  const typeAvailable = selectedType?.available === true
  const codexStatus = workerTypes.find(status => status.type === 'codex')
  const hasSavedApiKey = editing?.apiKeyMode === 'value' && editing.credentialSource === 'saved'
  const formValid = form.name.trim() !== '' && typeAvailable === true
    && (form.type === 'codex'
      || (form.apiKeyMode === 'environment'
        ? (form.apiKeyEnv?.trim() ?? '') !== ''
        : (form.apiKey?.trim() ?? '') !== '' || hasSavedApiKey === true))

  const save = async (): Promise<void> => {
    if (saving || !formValid) return
    setSaving(true)
    try {
      const path = editing === undefined ? `${baseUrl}/api/workers` : `${baseUrl}/api/workers/${encodeURIComponent(editing.id)}`
      const response = await fetch(path, {
        method: editing === undefined ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setDialogOpen(false)
      showToast(editing === undefined ? 'Worker 已添加' : 'Worker 已更新')
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setSaving(false)
    }
  }

  const saveOrder = async (ids: string[]): Promise<void> => {
    if (reordering || ids.every((id, index) => workers[index]?.id === id)) return
    setReordering(true)
    try {
      const response = await fetch(`${baseUrl}/api/workers/order`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      showToast('Worker 顺序已保存')
    } catch (error) {
      setDisplayedWorkers([...workers])
      showToast(`排序失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setReordering(false)
    }
  }

  const remove = async (worker: WorkerConfig): Promise<void> => {
    if (removing !== undefined || !window.confirm(`删除 Worker「${worker.name}」？`)) return
    setRemoving(worker.id)
    try {
      const response = await fetch(`${baseUrl}/api/workers/${encodeURIComponent(worker.id)}`, { method: 'DELETE' })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      showToast('Worker 已删除')
    } catch (error) {
      showToast(`删除失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setRemoving(undefined)
    }
  }

  const selectedModel = modelCatalog?.models.find(model => model.id === (form.model || modelCatalog.defaultModel))
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? (form.type === 'dsh' ? modelCatalog?.models[0]?.reasoningEfforts ?? [] : [])
  const effectiveDefaultEffort = modelCatalog?.defaultReasoningEffort ?? selectedModel?.defaultReasoningEffort
  const modelPlaceholder = form.type === 'codex'
    ? (modelCatalog?.defaultModel === undefined ? '使用本机默认模型' : `本机默认：${modelCatalog.defaultModel}`)
    : (modelCatalog?.defaultModel ?? '模型名称')

  const riskyWorktrees = cleanupPreview?.candidates.filter(candidate => candidate.needsDecision) ?? []
  const cleanWorktreeCount = cleanupPreview?.candidates.filter(candidate => !candidate.needsDecision).length ?? 0
  const cleanupDeleteCount = cleanWorktreeCount + riskyWorktrees.filter(candidate => cleanupDecisions[candidate.name] === 'delete').length

  /* ── render ── */

  return (
    <>
      <div style={settingsHeaderStyle}>设置</div>
      <div style={settingsLayoutStyle}>
        <aside style={settingsNavStyle}>
          <button type="button" className="dshw-nav" style={section === 'repository' ? settingsNavActiveStyle : settingsNavItemStyle} onClick={() => { setSection('repository') }}>
            <GRepository size={12} />仓库管理
          </button>
          <button type="button" className="dshw-nav" style={section === 'workers' ? settingsNavActiveStyle : settingsNavItemStyle} onClick={() => { setSection('workers') }}>
            <GSettings size={12} />Workers
          </button>
        </aside>

        {section === 'repository' && (
          <section style={settingsSectionStyle}>
            <div style={settingsSectionHeaderStyle}>
              <span style={settingsSectionTitleStyle}>仓库管理</span>
              <span style={settingsSectionSubStyle}>dshw、主仓库与 Worktree</span>
              <button
                type="button"
                className="dshw-icon"
                style={{ ...smallIconButtonStyle, marginLeft: 'auto' }}
                title="刷新仓库状态"
                aria-label="刷新仓库状态"
                disabled={busy}
                onClick={refreshRepositoryState}
              >
                <GSync size={13} />
              </button>
            </div>
            <div style={settingsBodyStyle}>
              <div style={settingsCardStyle}>
              <div style={repoCardStyle}>
                <RepoRow
                  first
                  icon={<GDownload size={14} />}
                  title="更新 dshw"
                  detail="拉取最新代码、安装依赖并重新构建，然后安全重启服务"
                  note={dshwRepositoryLag()}
                  warn={(dshwRepository?.behind ?? 0) > 0 || dshwRepository?.dirty === true}
                  buttonLabel="更新并重启"
                  disabled={devMode || dshwRepository?.state !== 'ready' || dshwRepository?.dirty === true || dshwUpdateNoop}
                  onClick={() => { void post('/api/dshw/update', {}, 'update-dshw') }}
                />
                <RepoRow
                  icon={<GSync size={14} />}
                  title="同步主仓库"
                  detail="更新 deepseek-harness 仓库到最新上游"
                  note={repositoryLag()}
                  warn={(repository?.behind ?? 0) > 0 || repository?.dirty === true}
                  buttonLabel="立即同步"
                  disabled={harnessSyncNoop}
                  onClick={() => { void post('/api/update', {}, 'update-harness') }}
                />
                <RepoRow
                  icon={<GWorktree size={14} />}
                  title="清理 Worktree"
                  detail="删除不再对应 active PR 的 Worktree；本地内容会逐项确认"
                  note={worktreeSummary()}
                  warn={false}
                  buttonLabel={cleanupLoading ? '检查中' : '检查并清理'}
                  disabled={worktreeCleanupNoop}
                  onClick={() => { void inspectWorktreeCleanup() }}
                />
                <RepoRow
                  icon={<GReset size={14} />}
                  title="重新初始化工作环境"
                  detail="清理生成文件，更新 master，重新安装依赖并运行 typecheck"
                  note=""
                  warn={false}
                  buttonLabel="从头配置"
                  disabled={false}
                  onClick={confirmReconfigure}
                />
              </div>
              </div>
            </div>
          </section>
        )}

        {section === 'workers' && (
          <section style={settingsSectionStyle}>
            <div style={settingsSectionHeaderStyle}>
              <span style={settingsSectionTitleStyle}>Workers</span>
              <span style={settingsSectionSubStyle}>拖动排序 · 第一项为默认</span>
              <button type="button" style={addButtonStyle} onClick={openCreate}><GPlus size={12} />添加</button>
            </div>
            {workers.length === 0 ? (
              <div style={emptyStateStyle}>
                <span>暂无 Worker</span>
                <button type="button" className="dshw-link" style={actionLinkStyle} onClick={openCreate}>添加配置</button>
              </div>
            ) : (
              <div style={jobsScrollStyle}>
                <table style={{ ...tableStyle, minWidth: 900 }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, width: 34 }} />
                      <th style={{ ...thStyle, width: 110 }}>状态</th>
                      <th style={{ ...thStyle, width: 220 }}>名称</th>
                      <th style={{ ...thStyle, width: 140 }}>类型</th>
                      <th style={thStyle}>模型</th>
                      <th style={{ ...thStyle, width: 110 }}>推理</th>
                      <th style={thStyle}>Base URL</th>
                      <th style={{ ...thStyle, width: 130 }}>凭据</th>
                      <th style={{ ...thStyle, width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {displayedWorkers.map((worker, index) => (
                      <tr
                        key={worker.id}
                        draggable={worker.enabled && !reordering}
                        style={{ opacity: draggedId === worker.id ? 0.45 : 1 }}
                        onDragStart={(event) => {
                          if (!worker.enabled || reordering) return
                          setDraggedId(worker.id)
                          setDragOverId(worker.id)
                          event.dataTransfer.setData('text/plain', worker.id)
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragOver={(event) => {
                          if (draggedId === undefined || !worker.enabled) return
                          event.preventDefault()
                          if (worker.id === dragOverId) return
                          const from = displayedWorkers.findIndex(candidate => candidate.id === draggedId)
                          const to = displayedWorkers.findIndex(candidate => candidate.id === worker.id)
                          if (from < 0 || to < 0) return
                          const reordered = [...displayedWorkers]
                          const [dragged] = reordered.splice(from, 1)
                          if (dragged !== undefined) reordered.splice(to, 0, dragged)
                          setDisplayedWorkers(reordered)
                          setDragOverId(worker.id)
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          setDraggedId(undefined)
                          setDragOverId(undefined)
                          void saveOrder(displayedWorkers.map(candidate => candidate.id))
                        }}
                        onDragEnd={() => {
                          setDraggedId(undefined)
                          setDragOverId(undefined)
                          setDisplayedWorkers([...workers])
                        }}
                      >
                        <td style={tdCompactStyle}><span style={{ display: 'inline-flex', color: worker.enabled ? C_MUTED : C_FAINT, cursor: worker.enabled ? 'grab' : 'default' }}><GGrip size={13} /></span></td>
                        <td style={tdCompactStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: workerAvailable(worker) ? ok : C_MUTED }}>
                            <StatusDot tone={workerAvailable(worker) ? 'ok' : 'neutral'} />{workerStatus(worker)}
                          </span>
                        </td>
                        <td style={tdCompactStyle}>
                          <span style={workerNameStyle}>{worker.name}</span>
                          {index === 0 && worker.enabled && <span style={defaultBadgeStyle}>默认</span>}
                        </td>
                        <td style={tdCompactStyle}>
                          <span style={{ fontSize: 12, color: C_SECONDARY }}>{typeLabel(worker.type)}</span>
                          {worker.type === 'claude-code' && <span style={{ fontSize: 10.5, color: C_MUTED }}>未支持</span>}
                        </td>
                        <td style={tdCompactStyle}><span style={cellBlockStyle} title={worker.model}>{worker.model || '—'}</span></td>
                        <td style={tdCompactStyle}><span style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C_SECONDARY }}>{worker.reasoningEffort || '默认'}</span></td>
                        <td style={tdCompactStyle}><span style={cellBlockStyle} title={worker.baseUrl}>{worker.type === 'dsh' ? worker.baseUrl || '默认' : '—'}</span></td>
                        <td style={tdCompactStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: worker.hasApiKey ? C_SECONDARY : warn }}>
                            <GKey size={11} />{credentialLabel(worker)}
                          </span>
                        </td>
                        <td style={tdCompactStyle}>
                          <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                            <button type="button" className="dshw-icon" style={smallIconButtonStyle} aria-label="编辑" onClick={() => { openEdit(worker) }}><GPencil size={12} /></button>
                            <button type="button" className="dshw-icon dshw-danger" style={{ ...smallIconButtonStyle, color: C_DANGER }} aria-label="删除" disabled={removing === worker.id} onClick={() => { void remove(worker) }}><GTrash size={12} /></button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>

      {cleanupDialogOpen && cleanupPreview !== undefined && (
        <WorktreeCleanupDialog
          preview={cleanupPreview}
          decisions={cleanupDecisions}
          loading={cleanupLoading}
          deleteCount={cleanupDeleteCount}
          cleanCount={cleanWorktreeCount}
          onDecision={(name, decision) => { setCleanupDecisions(current => ({ ...current, [name]: decision })) }}
          onClose={() => { setCleanupDialogOpen(false) }}
          onExecute={() => {
            void executeWorktreeCleanup(riskyWorktrees
              .filter(candidate => cleanupDecisions[candidate.name] === 'delete')
              .map(candidate => candidate.name))
          }}
        />
      )}

      {dialogOpen && (
        <WorkerFormDialog
          form={form}
          editing={editing}
          typeAvailable={typeAvailable === true}
          codexReason={codexStatus?.reason}
          modelCatalog={modelCatalog}
          modelLoading={modelLoading}
          modelError={modelError}
          modelPlaceholder={modelPlaceholder}
          reasoningEfforts={reasoningEfforts}
          effectiveDefaultEffort={effectiveDefaultEffort}
          hasSavedApiKey={hasSavedApiKey === true}
          formValid={formValid}
          saving={saving}
          onForm={(next) => { setForm(next) }}
          onClose={() => { setDialogOpen(false) }}
          onSave={() => { void save() }}
        />
      )}
    </>
  )
}

/** One repository-management row. */
export function RepoRow({ first = false, icon, title, detail, note, warn, buttonLabel, disabled, onClick }: {
  first?: boolean
  icon: ReactNode
  title: string
  detail: string
  note: string
  warn: boolean
  buttonLabel: string
  disabled: boolean
  onClick: () => void
}): ReactNode {
  return (
    <div style={first ? { ...repoRowStyle, borderTop: 'none' } : repoRowStyle}>
      <span style={repoIconStyle}>{icon}</span>
      <div style={repoTextStyle}>
        <div style={repoTitleStyle}>
          <span>{title}</span>
          {note !== '' && <span style={{ fontSize: 10.5, fontWeight: 400, color: warn ? C_WARNING : C_MUTED }}>{note}</span>}
        </div>
        <div style={repoDetailStyle}>{detail}</div>
      </div>
      <button type="button" className="dshw-btn-default" style={repoButtonStyle} disabled={disabled} onClick={onClick}>{buttonLabel}</button>
    </div>
  )
}

/** Worktree cleanup confirmation dialog. */

/* ── settings styles ── */

export const settingsHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  height: 30,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  /* match the table header (thStyle) look used by the other tabs */
  background: C_SURFACE,
  whiteSpace: 'nowrap',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: C_SECONDARY,
}

export const settingsLayoutStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '144px minmax(0, 1fr)',
}

export const settingsNavStyle: CSSProperties = {
  minHeight: 0,
  padding: 6,
  borderRight: `1px solid ${C_BORDER}`,
}

export const settingsNavItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  height: 30,
  padding: '0 8px',
  boxSizing: 'border-box',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  color: C_SECONDARY,
}

export const settingsNavActiveStyle: CSSProperties = {
  ...settingsNavItemStyle,
  background: C_HOVER,
  color: C_TEXT,
}

export const settingsSectionStyle: CSSProperties = { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }

export const settingsSectionHeaderStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 40,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

export const settingsSectionTitleStyle: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: C_TEXT }

export const settingsSectionSubStyle: CSSProperties = { fontSize: 11, color: C_MUTED }

export const settingsBodyStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' }

export const settingsCardStyle: CSSProperties = {
  margin: '0 auto',
  width: '100%',
  maxWidth: 760,
  padding: 20,
  boxSizing: 'border-box',
}

export const repoCardStyle: CSSProperties = {
  overflow: 'hidden',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 4,
}

export const repoRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minHeight: 64,
  padding: '0 14px',
  boxSizing: 'border-box',
  borderTop: `1px solid ${C_BORDER}`,
}

export const repoIconStyle: CSSProperties = {
  flex: 'none',
  display: 'grid',
  placeItems: 'center',
  width: 28,
  height: 28,
  borderRadius: 8,
  fontSize: 11,
  background: C_HOVER,
  color: C_SECONDARY,
}

export const repoTextStyle: CSSProperties = { flex: 1, minWidth: 0 }

export const repoTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  fontSize: 12.5,
  fontWeight: 500,
  color: C_TEXT,
}

export const repoDetailStyle: CSSProperties = { marginTop: 1, fontSize: 11, color: C_MUTED }

export const repoButtonStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: C_HOVER,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: 'none',
  whiteSpace: 'nowrap',
  color: C_SECONDARY,
}

export const addButtonStyle: CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 26,
  padding: '0 11px',
  border: 'none',
  borderRadius: 4,
  background: C_ACCENT,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: 'none',
  whiteSpace: 'nowrap',
  color: '#fff',
}

export const workerNameStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12.5,
  fontWeight: 500,
  color: C_TEXT,
}

export const defaultBadgeStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  marginLeft: 6,
  padding: '0 4px',
  borderRadius: 3,
  fontSize: 10.5,
  lineHeight: '14px',
  background: C_BADGE,
  color: C_BADGE_FG,
}


export const smallIconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  border: 'none',
  borderRadius: 6,
  padding: 0,
  background: 'transparent',
  cursor: 'pointer',
  color: C_SECONDARY,
}