/** Worktree cleanup confirmation dialog (WorkerSettings.vue port). */
import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorktreeCleanupCandidate, WorktreeCleanupPreview } from '../../../src/types.ts'
import { GClose } from '../icons.tsx'
import {
  dialogActionButtonStyle, dialogCloseButtonStyle, dialogFooterStyle, dialogHeaderStyle,
  dialogMaskStyle, dialogOverlayStyle, dialogStyle, jobDialogTitleStyle, primaryButtonStyle,
} from '../styles.ts'
import { warn, C_BORDER, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, FONT_MONO } from '../theme.ts'

export function WorktreeCleanupDialog({ preview, decisions, loading, deleteCount, cleanCount, onDecision, onClose, onExecute }: {
  preview: WorktreeCleanupPreview
  decisions: Record<string, 'keep' | 'delete'>
  loading: boolean
  deleteCount: number
  cleanCount: number
  onDecision: (name: string, decision: 'keep' | 'delete') => void
  onClose: () => void
  onExecute: () => void
}): ReactNode {
  const risky = preview.candidates.filter(candidate => candidate.needsDecision)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  const detail = (candidate: WorktreeCleanupCandidate): string => {
    const parts = [
      candidate.staged ? '有暂存改动' : '',
      candidate.unstaged ? '有未提交改动' : '',
      candidate.merging ? '正在合并' : '',
      candidate.ahead > 0 ? `领先上游 ${candidate.ahead} 个提交` : '',
      candidate.inspectionError ? '状态检查失败' : '',
    ].filter(Boolean)
    return parts.join(' · ') || '需要人工确认'
  }
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <section style={{ ...dialogStyle, width: 620, maxHeight: '80vh' }} role="dialog" aria-modal="true" aria-label="清理 Worktree">
        <header style={dialogHeaderStyle}>
          <span style={jobDialogTitleStyle}>清理 Worktree</span>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}><GClose size={15} /></button>
        </header>
        <div style={{ padding: 14, overflow: 'auto' }}>
          <p style={{ margin: 0, fontSize: 11.5, color: C_MUTED }}>
            只处理不再对应 active PR、且没有运行中任务占用的 Worktree。
            {cleanCount > 0 ? ` ${cleanCount} 个无本地内容的 Worktree 将直接删除。` : ''}
          </p>
          <div style={{ marginTop: 12, marginBottom: 5, fontSize: 10.5, fontWeight: 600, color: C_SECONDARY }}>需要确认的本地内容</div>
          <div style={{ border: `1px solid ${C_BORDER}`, borderRadius: 8, overflow: 'auto', maxHeight: 320 }}>
            {risky.map(candidate => (
              <div key={candidate.name} style={cleanupRowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={cleanupNameStyle}>{candidate.name}</span>
                    <span style={cleanupBranchStyle}>{candidate.branch}</span>
                  </div>
                  <div style={{ marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: warn }} title={candidate.inspectionError}>
                    {detail(candidate)}
                  </div>
                </div>
                <select
                  style={cleanupSelectStyle}
                  value={decisions[candidate.name] ?? 'keep'}
                  onChange={event => { onDecision(candidate.name, event.target.value as 'keep' | 'delete') }}
                >
                  <option value="keep">保留</option>
                  <option value="delete">删除并丢弃</option>
                </select>
              </div>
            ))}
          </div>
        </div>
        <footer style={dialogFooterStyle}>
          <span style={{ fontSize: 10.5, color: C_MUTED }}>选择删除后不会保留 stash 或本地分支</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="dshw-btn-ghost" style={dialogActionButtonStyle} disabled={loading} onClick={onClose}>取消</button>
            <button type="button" style={primaryButtonStyle} disabled={loading || deleteCount === 0} onClick={onExecute}>
              {loading ? '清理中' : `清理 ${deleteCount} 个`}
            </button>
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

/** Worker add/edit dialog. */

/* ── cleanup dialog styles ── */

export const cleanupRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 52,
  padding: '0 10px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
}

export const cleanupNameStyle: CSSProperties = { fontFamily: FONT_MONO, fontSize: 11.5, fontWeight: 500, color: C_TEXT }

export const cleanupBranchStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, color: C_MUTED }

export const cleanupSelectStyle: CSSProperties = {
  flex: 'none',
  width: 148,
  height: 28,
  padding: '0 7px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  background: C_SURFACE,
  outline: 'none',
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: C_TEXT,
}
