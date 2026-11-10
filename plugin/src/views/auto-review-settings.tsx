/** Settings → Auto review: turn the reviewer on, point it at a model, and
 *  decide whether findings should start a dsh fix session automatically. */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { AutoReviewConfig, AutoReviewConfigInput, AutoReviewScope, WorkerConfig } from '../../../src/types.ts'
import { GBot, GGithub, GReset, GSparkles } from '../icons.tsx'
import { dangerButtonStyle, primaryButtonStyle } from '../styles.ts'
import { C_ACCENT, C_BORDER, C_DANGER, C_FAINT, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, C_WARNING, FONT_MONO } from '../theme.ts'
import {
  settingsBodyStyle, settingsSectionHeaderStyle, settingsSectionStyle, settingsSectionSubStyle, settingsSectionTitleStyle,
} from './settings.tsx'

/** Editable form state: the config plus the write-only API key draft. */
interface Form {
  enabled: boolean
  scope: AutoReviewScope
  debounceSeconds: number
  debounceMaxSeconds: number
  /** Comma-separated model list: every entry is reviewed in parallel. */
  models: string
  modelProfile: string
  baseUrl: string
  apiKeyMode: 'value' | 'environment'
  apiKeyEnv: string
  apiKey: string
  engineVersion: string
  timeoutSeconds: number
  autoFix: boolean
  fixSeverity: 'critical' | 'warning'
  workerConfigId: string
  instructions: string
}

function formFrom(config: AutoReviewConfig): Form {
  return {
    enabled: config.enabled,
    scope: config.scope,
    debounceSeconds: config.debounceSeconds,
    debounceMaxSeconds: config.debounceMaxSeconds,
    models: config.models.join(', '),
    modelProfile: config.modelProfile ?? '',
    baseUrl: config.baseUrl,
    apiKeyMode: config.apiKeyMode,
    apiKeyEnv: config.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    apiKey: '',
    engineVersion: config.engineVersion,
    timeoutSeconds: config.timeoutSeconds,
    autoFix: config.autoFix,
    fixSeverity: config.fixSeverity,
    workerConfigId: config.workerConfigId ?? '',
    instructions: config.instructions,
  }
}

export function AutoReviewSection({ baseUrl, config, workers, showToast, onRunRecords }: {
  baseUrl: string
  config?: AutoReviewConfig
  workers: readonly WorkerConfig[]
  showToast: (message: string, bad?: boolean) => void
  onRunRecords?: () => void
}): ReactNode {
  const [form, setForm] = useState<Form>(() => config === undefined ? DEFAULT_FORM : formFrom(config))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [github, setGithub] = useState<{ loading: boolean, authenticated?: boolean, account?: string, repositories?: string[], error?: string }>({ loading: false })
  const [checking, setChecking] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [recommended, setRecommended] = useState<string[]>([])
  const [modelsError, setModelsError] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)

  const loadModels = async (): Promise<void> => {
    setModelsLoading(true)
    try {
      const response = await fetch(`${baseUrl}/api/auto-review/models`)
      const value = await response.json() as { models?: string[], recommended?: string[], error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setModels(value.models ?? [])
      setRecommended(value.recommended ?? [])
      setModelsError(value.error ?? '')
    } catch (error) {
      setModels([])
      setModelsError(error instanceof Error ? error.message : String(error))
    } finally {
      setModelsLoading(false)
    }
  }
  useEffect(() => { void loadModels() }, [baseUrl])

  // Server state wins while the form is untouched (another tab, daemon restart).
  useEffect(() => {
    if (config === undefined || dirty) return
    setForm(formFrom(config))
  }, [config, dirty])

  const update = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const input: AutoReviewConfigInput = {
        enabled: form.enabled,
        scope: form.scope,
        debounceSeconds: form.debounceSeconds,
        debounceMaxSeconds: form.debounceMaxSeconds,
        models: form.models.split(/[,，\s]+/u).map(entry => entry.trim()).filter(entry => entry !== ''),
        baseUrl: form.baseUrl,
        modelProfile: form.modelProfile === '' ? 'auto' : form.modelProfile as 'deepseek' | 'anthropic' | 'openai' | 'glm',
        apiKeyMode: form.apiKeyMode,
        apiKeyEnv: form.apiKeyEnv,
        engineVersion: form.engineVersion,
        timeoutSeconds: form.timeoutSeconds,
        autoFix: form.autoFix,
        fixSeverity: form.fixSeverity,
        workerConfigId: form.workerConfigId,
        instructions: form.instructions,
        ...(form.apiKey.trim() === '' ? {} : { apiKey: form.apiKey.trim() }),
      }
      const response = await fetch(`${baseUrl}/api/auto-review/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
      const value = await response.json() as { config?: AutoReviewConfig, error?: string }
      if (!response.ok || value.config === undefined) throw new Error(value.error ?? `HTTP ${response.status}`)
      setForm(formFrom(value.config))
      setDirty(false)
      showToast(value.config.enabled ? '自动评审已保存并开启' : '自动评审设置已保存')
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setSaving(false)
    }
  }

  const testGithub = async (): Promise<void> => {
    if (checking) return
    setChecking(true)
    setGithub({ loading: true })
    try {
      const response = await fetch(`${baseUrl}/api/auto-review/github`)
      const value = await response.json() as { authenticated?: boolean, account?: string, repositories?: string[], error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      setGithub({ loading: false, authenticated: value.authenticated === true, account: value.account, repositories: value.repositories ?? [], error: value.error })
      showToast(value.authenticated === true ? `GitHub 已连接：${value.account ?? ''}` : 'GitHub 未连接', value.authenticated !== true)
    } catch (error) {
      setGithub({ loading: false, authenticated: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setChecking(false)
    }
  }

  const credential = config === undefined ? '—'
    : config.credentialSource === 'saved' ? '已保存的 Key'
      : config.credentialSource === 'environment' ? `环境变量 ${config.apiKeyEnv ?? ''}`
        : config.credentialSource === 'local' ? `~/.dsh/.env 中的 ${config.apiKeyEnv ?? ''}`
          : '未配置'

  return (
    <section style={settingsSectionStyle}>
      <div className="dshw-section-header" style={settingsSectionHeaderStyle}>
        <span style={settingsSectionTitleStyle}>Auto review</span>
        <span style={settingsSectionSubStyle}>PR 有新提交时自动评审，并可让 dsh 会话修复这些意见</span>
        <button
          type="button"
          style={{ ...primaryButtonStyle, marginLeft: 'auto', ...(dirty ? {} : disabledLook) }}
          disabled={saving || !dirty}
          onClick={() => { void save() }}
        >
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </button>
      </div>
      <div style={settingsBodyStyle}>
        <div style={cardStyle}>
          <Row
            icon={<GBot size={14} />}
            title="开启自动评审"
            detail="监控范围内的 PR 出现新提交时，等待下面设置的安静期后自动运行评审"
            control={<Switch on={form.enabled} onChange={value => { update('enabled', value) }} label="开启自动评审" />}
          />
          <Row
            icon={<GSparkles size={14} />}
            title="立即评审"
            detail="手动触发时跳过安静期，直接评审当前 PR head"
            control={<button type="button" style={secondaryButton} disabled={!form.enabled} onClick={() => { onRunRecords?.() }}>到列表选择 PR</button>}
          />
          <Row
            icon={<GGithub size={14} />}
            title="连接 GitHub"
            detail="评审读取 PR 标题、描述和提交；修复会话 push 回 PR 分支"
            note={github.authenticated === true
              ? `已连接 @${github.account ?? ''}（监控 ${String(github.repositories?.length ?? 0)} 个仓库）`
              : github.authenticated === false ? github.error ?? '未连接' : credential}
            warn={github.authenticated === false}
            control={<button type="button" style={secondaryButton} disabled={checking} onClick={() => { void testGithub() }}>{checking ? '检测中…' : '检测连接'}</button>}
          />
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>评审</div>
          <Field label="监控范围" hint="只评审你自己的 PR、assign 给你的 PR，或全部被监控的 open PR">
            <select style={inputStyle} value={form.scope} onChange={event => { update('scope', event.target.value as AutoReviewScope) }}>
              <option value="mine">我创建的 PR</option>
              <option value="assigned">assign 给我的 PR</option>
              <option value="all">全部被监控的 PR</option>
            </select>
          </Field>
          <div style={inlineFieldsStyle}>
            <Field label="安静期（秒）" hint="最新提交之后再等多久开始评审">
              <input style={inputStyle} type="number" min={10} max={3600} value={form.debounceSeconds} onChange={event => { update('debounceSeconds', Number(event.target.value)) }} />
            </Field>
            <Field label="最长等待（秒）" hint="持续提交时也不会无限推迟">
              <input style={inputStyle} type="number" min={10} max={86400} value={form.debounceMaxSeconds} onChange={event => { update('debounceMaxSeconds', Number(event.target.value)) }} />
            </Field>
          </div>
          <div style={inlineFieldsStyle}>
            <Field label="模型（并行）" hint={modelsError === '' ? `多个模型用逗号分隔，会并行评审后合并；默认同 cc_bot：opus-5.5 / gpt-6-astra / deepseek-flash${models.length > 0 ? `（共 ${String(models.length)} 个可选）` : ''}` : `列表不可用：${modelsError}`}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  style={{ ...inputStyle, fontFamily: FONT_MONO }}
                  list="dshw-auto-review-models"
                  value={form.models}
                  onChange={event => { update('models', event.target.value) }}
                />
                <datalist id="dshw-auto-review-models">
                  {[...recommended, ...models.filter(id => !recommended.includes(id))].map(id => <option key={id} value={id} />)}
                </datalist>
                <button type="button" style={{ ...secondaryButton, flex: 'none' }} disabled={modelsLoading} onClick={() => { void loadModels() }}>
                  {modelsLoading ? '读取中…' : '刷新'}
                </button>
              </div>
            </Field>
            <Field label="超时（秒）">
              <input style={inputStyle} type="number" min={30} max={86400} value={form.timeoutSeconds} onChange={event => { update('timeoutSeconds', Number(event.target.value)) }} />
            </Field>
          </div>
          <Field label="模型协议" hint="决定 Pi 用哪种 thinking/缓存约定；留空按模型 id 推断（claude→anthropic、glm→zai、其他按 deepseek/openai）">
            <select style={inputStyle} value={form.modelProfile} onChange={event => { update('modelProfile', event.target.value) }}>
              <option value="">自动推断</option>
              <option value="deepseek">DeepSeek</option>
              <option value="anthropic">Anthropic（Claude，经 OpenAI 兼容网关）</option>
              <option value="openai">OpenAI / 通用</option>
              <option value="glm">GLM（zai）</option>
            </select>
          </Field>
          <Field label="Base URL" hint="OpenAI 兼容的 chat-completions 端点">
            <input style={{ ...inputStyle, fontFamily: FONT_MONO }} value={form.baseUrl} onChange={event => { update('baseUrl', event.target.value) }} />
          </Field>
          <div style={inlineFieldsStyle}>
            <Field label="凭据来源">
              <select style={inputStyle} value={form.apiKeyMode} onChange={event => { update('apiKeyMode', event.target.value as 'value' | 'environment') }}>
                <option value="environment">环境变量</option>
                <option value="value">直接保存 API Key</option>
              </select>
            </Field>
            {form.apiKeyMode === 'environment' ? (
              <Field label="环境变量名" hint="也可写在 ~/.dsh/.env 中">
                <input style={{ ...inputStyle, fontFamily: FONT_MONO }} value={form.apiKeyEnv} onChange={event => { update('apiKeyEnv', event.target.value) }} />
              </Field>
            ) : (
              <Field label="API Key" hint="单独保存，不会写入配置文件">
                <input style={{ ...inputStyle, fontFamily: FONT_MONO }} type="password" placeholder={config?.hasApiKey === true ? '已保存，留空则不修改' : 'sk-…'} value={form.apiKey} onChange={event => { update('apiKey', event.target.value) }} />
              </Field>
            )}
          </div>
          <Field label="评审引擎版本" hint="Pi coding agent 版本；首次运行会自动安装（需要能访问 npm）">
            <input style={{ ...inputStyle, width: 140, fontFamily: FONT_MONO }} value={form.engineVersion} onChange={event => { update('engineVersion', event.target.value) }} />
          </Field>
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>修复</div>
          <Row
            icon={<GBot size={14} />}
            title="评审后自动修复"
            detail="评审发现问题时，用一个新的 dsh 会话逐条处理意见并 push"
            control={<Switch on={form.autoFix} onChange={value => { update('autoFix', value) }} label="评审后自动修复" />}
          />
          <div style={inlineFieldsStyle}>
            <Field label="触发级别" hint="达到该级别才自动修复">
              <select style={inputStyle} value={form.fixSeverity} onChange={event => { update('fixSeverity', event.target.value as 'critical' | 'warning') }}>
                <option value="warning">必须修复 + 建议修复</option>
                <option value="critical">仅必须修复</option>
              </select>
            </Field>
            <Field label="执行器" hint="留空使用默认 Worker">
              <select style={inputStyle} value={form.workerConfigId} onChange={event => { update('workerConfigId', event.target.value) }}>
                <option value="">默认 Worker</option>
                {workers.filter(worker => worker.enabled).map(worker => (
                  <option key={worker.id} value={worker.id}>{worker.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <p style={hintStyle}>自动修复每个 PR 最多连续 3 次；修复 push 后再出现的新提交会被重新评审。</p>
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>提示词</div>
          <Field label="额外审查指令" hint="追加到评审 prompt 末尾；留空只用内置的评审流程">
            <textarea
              className="dshw-wpta"
              style={{ ...inputStyle, minHeight: 88, resize: 'vertical', lineHeight: '18px', padding: '7px 9px' }}
              value={form.instructions}
              maxLength={4000}
              placeholder="例如：这是一个 TypeScript 项目，重点看并发和错误处理；忽略测试文件的命名风格。"
              onChange={event => { update('instructions', event.target.value) }}
            />
          </Field>
          <p style={hintStyle}>修复会话使用内置 prompt（在 prompts/auto-review-fix.md），会带上本次评审的概述和逐条意见，要求先判断意见是否成立再修改。</p>
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>记录</div>
          <Row
            icon={<GReset size={14} />}
            title="清空评审记录"
            detail="删除所有 PR 的评审结果与修复历史（不影响 PR 本身）"
            control={(
              <button
                type="button"
                style={dangerButtonStyle}
                onClick={() => {
                  if (!window.confirm('清空所有自动评审记录？评审结果和修复历史都会被删除。')) return
                  void (async () => {
                    try {
                      const response = await fetch(`${baseUrl}/api/auto-review/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
                      const value = await response.json() as { error?: string }
                      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
                      showToast('评审记录已清空')
                    } catch (error) {
                      showToast(`清空失败：${error instanceof Error ? error.message : String(error)}`, true)
                    }
                  })()
                }}
              >
                清空
              </button>
            )}
          />
        </div>
      </div>
    </section>
  )
}

/* ── small building blocks ───────────────────────────────────────────────── */

/** Fallback used before the first snapshot arrives. */
const DEFAULT_FORM: Form = {
  enabled: false,
  scope: 'mine',
  debounceSeconds: 90,
  debounceMaxSeconds: 900,
  models: 'anthropic/claude-opus-5.5, openai/gpt-6-astra, deepseek-flash',
  modelProfile: '',
  baseUrl: 'https://llm.modelhub.online/v1',
  apiKeyMode: 'environment',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  apiKey: '',
  engineVersion: '0.85.1',
  timeoutSeconds: 900,
  autoFix: false,
  fixSeverity: 'warning',
  workerConfigId: '',
  instructions: '',
}

function Row({ icon, title, detail, note, warn: isWarn, control }: {
  icon: ReactNode
  title: string
  detail: string
  note?: string
  warn?: boolean
  control: ReactNode
}): ReactNode {
  return (
    <div style={rowStyle}>
      <span style={{ display: 'inline-flex', flex: 'none', color: isWarn === true ? C_WARNING : C_ACCENT }}>{icon}</span>
      <div style={rowTextStyle}>
        <div style={rowTitleStyle}>{title}</div>
        <div style={rowDetailStyle}>{detail}</div>
        {note !== undefined && note !== '' && <div style={{ ...rowNoteStyle, color: isWarn === true ? C_DANGER : C_MUTED }}>{note}</div>}
      </div>
      <div style={rowControlStyle}>{control}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string, hint?: string, children: ReactNode }): ReactNode {
  return (
    <label style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      {children}
      {hint !== undefined && <span style={fieldHintStyle}>{hint}</span>}
    </label>
  )
}

function Switch({ on, onChange, label }: { on: boolean, onChange: (value: boolean) => void, label: string }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => { onChange(!on) }}
      style={{ ...switchStyle, background: on ? C_ACCENT : '#c4c4c4' }}
    >
      <span style={{ ...knobStyle, transform: on ? 'translateX(12px)' : 'none' }} />
    </button>
  )
}

const disabledLook: CSSProperties = { opacity: 0.55, cursor: 'default' }

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginBottom: 14,
  border: `1px solid ${C_BORDER}`,
  borderRadius: 8,
  background: C_SURFACE,
  overflow: 'hidden',
}

const cardTitleStyle: CSSProperties = {
  padding: '9px 12px 3px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: C_MUTED,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  minHeight: 56,
  padding: '10px 12px',
  borderBottom: `1px solid ${C_BORDER}`,
}

const rowTextStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }

const rowTitleStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: C_TEXT }

const rowDetailStyle: CSSProperties = { fontSize: 12, color: C_SECONDARY, lineHeight: 1.45 }

const rowNoteStyle: CSSProperties = { fontSize: 11.5, lineHeight: 1.45 }

const rowControlStyle: CSSProperties = { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, paddingTop: 2 }

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 12px', flex: 1, minWidth: 0 }

const fieldLabelStyle: CSSProperties = { fontSize: 11.5, fontWeight: 600, color: C_SECONDARY }

const fieldHintStyle: CSSProperties = { fontSize: 11, color: C_FAINT, lineHeight: 1.4 }

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  height: 28,
  padding: '0 8px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 5,
  background: C_SURFACE,
  color: C_TEXT,
  fontFamily: 'inherit',
  fontSize: 12.5,
  outline: 'none',
}

const inlineFieldsStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 4, flexWrap: 'wrap' }

const hintStyle: CSSProperties = { margin: 0, padding: '8px 12px 10px', fontSize: 11.5, color: C_MUTED, lineHeight: 1.5 }

const secondaryButton: CSSProperties = {
  height: 26,
  padding: '0 11px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 6,
  background: C_SURFACE,
  color: C_TEXT,
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

const switchStyle: CSSProperties = {
  position: 'relative',
  flex: 'none',
  width: 26,
  height: 14,
  border: 'none',
  borderRadius: 7,
  cursor: 'pointer',
  transition: 'background-color 150ms',
}

const knobStyle: CSSProperties = {
  position: 'absolute',
  top: 2,
  left: 2,
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#fff',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
  transition: 'transform 150ms',
}
