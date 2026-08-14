/** Worker add/edit form dialog (WorkerSettings.vue port). */
import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { WorkerConfig, WorkerConfigInput, WorkerModelCatalog, WorkerReasoningEffort } from '../../../src/types.ts'
import { GClose } from '../icons.tsx'
import {
  dialogActionButtonStyle, dialogCloseButtonStyle, dialogFooterStyle, dialogHeaderStyle,
  dialogMaskStyle, dialogOverlayStyle, dialogStyle, jobDialogTitleStyle, primaryButtonStyle,
} from '../styles.ts'
import { warn, C_BORDER, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT } from '../theme.ts'

/** Worker config form state (WorkerSettings.vue form). */
export type WorkerForm = WorkerConfigInput

export function WorkerFormDialog({ form, editing, typeAvailable, codexReason, modelCatalog, modelLoading, modelError, modelPlaceholder, reasoningEfforts, effectiveDefaultEffort, hasSavedApiKey, formValid, saving, onForm, onClose, onSave }: {
  form: WorkerForm
  editing?: WorkerConfig
  typeAvailable: boolean
  codexReason?: string
  modelCatalog?: WorkerModelCatalog
  modelLoading: boolean
  modelError: string
  modelPlaceholder: string
  reasoningEfforts: readonly WorkerReasoningEffort[]
  effectiveDefaultEffort?: string
  hasSavedApiKey: boolean
  formValid: boolean
  saving: boolean
  onForm: (next: WorkerForm) => void
  onClose: () => void
  onSave: () => void
}): ReactNode {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])
  const set = (patch: Partial<WorkerForm>): void => { onForm({ ...form, ...patch }) }
  const effortOptions = [...reasoningEfforts]
  const current = form.reasoningEffort?.trim()
  if (current !== undefined && current !== '' && !effortOptions.some(option => option.id === current)) effortOptions.push({ id: current, name: current })
  return createPortal(
    <div style={dialogOverlayStyle} role="presentation" data-dshw-kanban="root">
      <div style={dialogMaskStyle} aria-hidden="true" onClick={onClose} />
      <section style={{ ...dialogStyle, width: 560, maxHeight: '85vh', overflow: 'auto' }} role="dialog" aria-modal="true" aria-label={editing === undefined ? '添加 Worker' : '编辑 Worker'}>
        <header style={dialogHeaderStyle}>
          <span style={jobDialogTitleStyle}>{editing === undefined ? '添加 Worker' : '编辑 Worker'}</span>
          <button type="button" className="dshw-icon" style={dialogCloseButtonStyle} aria-label="关闭" onClick={onClose}><GClose size={15} /></button>
        </header>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '11px 12px', padding: 14 }}>
          <div style={{ gridColumn: '1 / -1', fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: C_MUTED }}>基本</div>
          <label style={formFieldStyle}>
            <span style={formLabelStyle}>名称</span>
            <input autoFocus style={formInputStyle} placeholder="例如：日常 dsh" value={form.name}
              onChange={event => { set({ name: event.target.value }) }} />
          </label>
          <label style={formFieldStyle}>
            <span style={formLabelStyle}>类型</span>
            <select style={formInputStyle} value={form.type}
              onChange={event => { set({ type: event.target.value as WorkerForm['type'] }) }}>
              <option value="dsh">dsh</option>
              <option value="codex" disabled={!typeAvailable}>Codex{typeAvailable ? '' : '（不可用）'}</option>
              <option value="claude-code" disabled>Claude Code（未支持）</option>
            </select>
          </label>
          <label style={{ ...formFieldStyle, display: 'flex', alignItems: 'flex-end', gap: 6, paddingBottom: 6 }}>
            <input type="checkbox" disabled={!typeAvailable} checked={form.enabled === true}
              onChange={event => { set({ enabled: event.target.checked }) }} />
            启用
          </label>
          {!typeAvailable && codexReason !== undefined && (
            <div style={{ gridColumn: '1 / -1', fontSize: 11, color: C_MUTED }}>{codexReason}</div>
          )}
          <div style={{ gridColumn: '1 / -1', marginTop: 2, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: C_MUTED }}>模型</div>
          {form.type === 'dsh' && (
            <label style={formFieldStyle}>
              <span style={formLabelStyle}>Provider</span>
              <input style={formInputStyle} placeholder="deepseek-official" value={form.provider ?? ''}
                onChange={event => { set({ provider: event.target.value }) }} />
            </label>
          )}
          <label style={{ ...formFieldStyle, ...(form.type === 'codex' ? { gridColumn: '1 / -1' } : {}) }}>
            <span style={formLabelStyle}>模型{form.type === 'codex' ? '（可选）' : ''}</span>
            <input style={formInputStyle} list="dshw-worker-model-options" placeholder={modelPlaceholder} value={form.model ?? ''}
              onChange={event => { set({ model: event.target.value }) }} />
            <datalist id="dshw-worker-model-options">
              {modelCatalog?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </datalist>
          </label>
          <label style={{ ...formFieldStyle, gridColumn: '1 / -1' }}>
            <span style={formLabelStyle}>推理强度</span>
            <select style={formInputStyle} value={form.reasoningEffort ?? ''}
              onChange={event => { set({ reasoningEffort: event.target.value }) }}>
              <option value="">{effectiveDefaultEffort === undefined ? '使用默认值' : `默认（${effectiveDefaultEffort}）`}</option>
              {effortOptions.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
            </select>
          </label>
          {modelLoading && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: C_MUTED }}>正在读取可用模型…</div>}
          {modelError !== '' && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: warn }}>模型列表读取失败：{modelError}</div>}
          {form.type === 'dsh' && (
            <>
              <div style={{ gridColumn: '1 / -1', marginTop: 2, fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: C_MUTED }}>连接</div>
              <label style={{ ...formFieldStyle, gridColumn: '1 / -1' }}>
                <span style={formLabelStyle}>Base URL</span>
                <input style={formInputStyle} type="url" placeholder="留空则使用 DEEPSEEK_BASE_URL" value={form.baseUrl ?? ''}
                  onChange={event => { set({ baseUrl: event.target.value }) }} />
              </label>
              <label style={{ ...formFieldStyle, gridColumn: '1 / -1' }}>
                <span style={formLabelStyle}>Search Base URL</span>
                <input style={formInputStyle} type="url" placeholder="留空则使用 DEEPSEEK_SEARCH_BASE_URL" value={form.searchBaseUrl ?? ''}
                  onChange={event => { set({ searchBaseUrl: event.target.value }) }} />
              </label>
              <label style={formFieldStyle}>
                <span style={formLabelStyle}>API Key 来源</span>
                <select style={formInputStyle} value={form.apiKeyMode}
                  onChange={event => { set({ apiKeyMode: event.target.value as WorkerForm['apiKeyMode'] }) }}>
                  <option value="value">直接输入</option>
                  <option value="environment">环境变量</option>
                </select>
              </label>
              {form.apiKeyMode === 'value' ? (
                <label style={formFieldStyle}>
                  <span style={formLabelStyle}>API Key</span>
                  <input style={formInputStyle} type="password" autoComplete="new-password"
                    placeholder={hasSavedApiKey ? '已保存；留空不变' : '输入 API Key'}
                    value={form.apiKey ?? ''}
                    onChange={event => { set({ apiKey: event.target.value }) }} />
                </label>
              ) : (
                <label style={formFieldStyle}>
                  <span style={formLabelStyle}>环境变量</span>
                  <input style={formInputStyle} placeholder="DEEPSEEK_API_KEY" value={form.apiKeyEnv ?? ''}
                    onChange={event => { set({ apiKeyEnv: event.target.value }) }} />
                </label>
              )}
            </>
          )}
        </div>
        <footer style={dialogFooterStyle}>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="dshw-btn-ghost" style={dialogActionButtonStyle} onClick={onClose}>取消</button>
            <button type="button" style={primaryButtonStyle} disabled={saving || !formValid} onClick={onSave}>
              {saving ? '保存中' : '保存'}
            </button>
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}


/* ── form dialog styles ── */

export const formFieldStyle: CSSProperties = { display: 'block', fontSize: 11.5, color: C_SECONDARY }

export const formLabelStyle: CSSProperties = { display: 'block', marginBottom: 4 }

export const formInputStyle: CSSProperties = {
  width: '100%',
  height: 28,
  padding: '0 8px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  outline: 'none',
  background: C_SURFACE,
  fontFamily: 'inherit',
  fontSize: 12.5,
  color: C_TEXT,
}