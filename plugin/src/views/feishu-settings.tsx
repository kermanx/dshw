/** Settings → Feishu: connect the bot, pick the topic chat, and decide which
 *  PR progress events get announced there. */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { FeishuConfig, FeishuConfigInput, FeishuNotifyConfig } from '../../../src/types.ts'
import { GBot, GGithub, GSparkles, GTrash, StatusDot } from '../icons.tsx'
import { dangerButtonStyle, primaryButtonStyle } from '../styles.ts'
import { C_ACCENT, C_BORDER, C_DANGER, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, C_WARNING, FONT_MONO } from '../theme.ts'
import {
  settingsBodyStyle, settingsSectionHeaderStyle, settingsSectionStyle, settingsSectionSubStyle, settingsSectionTitleStyle,
} from './settings.tsx'

interface FeishuThreadView {
  key: string
  title: string
  threadId: string
  updatedAt: string
}

interface Form {
  enabled: boolean
  command: string
  proxy: string
  chatId: string
  webBaseUrl: string
  pollSeconds: number
  notify: FeishuNotifyConfig
}

function formFrom(config: FeishuConfig): Form {
  return {
    enabled: config.enabled,
    command: config.command,
    proxy: '',
    chatId: config.chatId ?? '',
    webBaseUrl: config.webBaseUrl ?? '',
    pollSeconds: config.pollSeconds,
    notify: { ...config.notify },
  }
}

export function FeishuSection({ baseUrl, config, threads, showToast }: {
  baseUrl: string
  config?: FeishuConfig
  threads: readonly FeishuThreadView[]
  showToast: (message: string, bad?: boolean) => void
}): ReactNode {
  const [form, setForm] = useState<Form>(() => config === undefined ? DEFAULT_FORM : formFrom(config))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string>()

  useEffect(() => {
    if (config === undefined || dirty) return
    setForm(formFrom(config))
  }, [config, dirty])

  const update = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm(previous => ({ ...previous, [key]: value }))
    setDirty(true)
  }
  const updateNotify = (key: keyof FeishuNotifyConfig, value: boolean): void => {
    setForm(previous => ({ ...previous, notify: { ...previous.notify, [key]: value } }))
    setDirty(true)
  }

  const request = async <T,>(path: string, method: 'POST' | 'PUT' | 'GET', body?: object): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const value = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    return value
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const input: FeishuConfigInput = {
        enabled: form.enabled,
        command: form.command,
        chatId: form.chatId,
        webBaseUrl: form.webBaseUrl,
        pollSeconds: form.pollSeconds,
        notify: form.notify,
        ...(form.proxy.trim() === '' ? {} : { proxy: form.proxy.trim() }),
      }
      const value = await request<{ config: FeishuConfig }>('/api/feishu/config', 'PUT', input)
      setForm(formFrom(value.config))
      setDirty(false)
      showToast(value.config.enabled ? '飞书通知已保存并开启' : '飞书设置已保存')
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setSaving(false)
    }
  }

  const check = async (): Promise<void> => {
    if (busy !== undefined) return
    setBusy('check')
    try {
      const value = await request<{ status: { available?: boolean, version?: string, botReady?: boolean, userReady?: boolean, error?: string } }>('/api/feishu/check', 'POST', {})
      const status = value.status
      showToast(
        status.available === true && status.botReady === true
          ? `lark-cli 可用（${status.version ?? ''}），${status.userReady === true ? '用户身份也已登录' : '用户身份未登录，话题指令将无法读取'}`
          : `${status.error ?? 'lark-cli 不可用'}`,
        status.available !== true || status.botReady !== true,
      )
    } catch (error) {
      showToast(`检测失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setBusy(undefined)
    }
  }

  const createChat = async (): Promise<void> => {
    const name = window.prompt('话题群名称', 'dshw · PR 进展')
    if (name === null || name.trim() === '') return
    setBusy('chat')
    try {
      const value = await request<{ chatId: string, chatName: string }>('/api/feishu/chat', 'POST', { name: name.trim() })
      setForm(previous => ({ ...previous, chatId: value.chatId }))
      setDirty(false)
      showToast(`已创建话题群「${value.chatName}」，并邀请你加入`)
    } catch (error) {
      showToast(`创建失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setBusy(undefined)
    }
  }

  const sendTest = async (): Promise<void> => {
    setBusy('test')
    try {
      await request('/api/feishu/test', 'POST', {})
      showToast('测试消息已发送')
    } catch (error) {
      showToast(`发送失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setBusy(undefined)
    }
  }

  const forgetThread = async (key: string): Promise<void> => {
    try {
      await request('/api/feishu/thread/forget', 'POST', { key })
      showToast('已移除话题映射；下次通知会重新开话题')
    } catch (error) {
      showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  const status = config?.status
  const statusText = status === undefined
    ? '尚未检测'
    : status.available !== true
      ? status.error ?? 'lark-cli 不可用'
      : `${status.version ?? 'lark-cli'} · 机器人${status.botReady === true ? '已就绪' : '未就绪'} · 用户${status.userReady === true ? '已登录' : '未登录'}`

  return (
    <section style={settingsSectionStyle}>
      <div className="dshw-section-header" style={settingsSectionHeaderStyle}>
        <span style={settingsSectionTitleStyle}>Feishu</span>
        <span style={settingsSectionSubStyle}>PR 进展发到飞书话题群，回复话题即可下指令</span>
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
            title="开启飞书通知"
            detail="评审完成、修复会话结束等进展会发到下面的话题群"
            control={<Switch on={form.enabled} onChange={value => { update('enabled', value) }} label="开启飞书通知" />}
          />
          <Row
            icon={<GGithub size={14} />}
            title="lark-cli"
            detail="dshw 通过 lark-cli 收发飞书消息；需要机器人和用户身份都已登录"
            note={statusText}
            warn={status !== undefined && (status.available !== true || status.botReady !== true)}
            control={(
              <div style={{ display: 'inline-flex', gap: 6 }}>
                <button type="button" style={secondaryButton} disabled={busy !== undefined} onClick={() => { void check() }}>{busy === 'check' ? '检测中…' : '检测'}</button>
                <button type="button" style={secondaryButton} disabled={busy !== undefined || form.chatId === ''} onClick={() => { void sendTest() }}>{busy === 'test' ? '发送中…' : '发送测试'}</button>
              </div>
            )}
          />
          <Row
            icon={<GSparkles size={14} />}
            title="话题群"
            detail="每个 PR 一个话题；话题里的回复会变成 dshw 指令（/review、/fix、/status、/open 或直接说需求）"
            note={form.chatId === '' ? '还没有配置话题群' : `${config?.chatName ?? '已配置'}（${form.chatId}）`}
            warn={form.chatId === ''}
            control={(
              <button type="button" style={secondaryButton} disabled={busy !== undefined} onClick={() => { void createChat() }}>
                {busy === 'chat' ? '创建中…' : '创建话题群'}
              </button>
            )}
          />
          <Row
            icon={<GGithub size={14} />}
            title="看板地址"
            detail="消息里的「看板」链接；打开面板时会自动填入当前访问地址"
            control={(
              <input
                style={{ ...inputStyle, width: 260, fontFamily: FONT_MONO }}
                placeholder="http://127.0.0.1:3079"
                value={form.webBaseUrl}
                onChange={event => { update('webBaseUrl', event.target.value) }}
              />
            )}
          />
          <Row
            icon={<GSparkles size={14} />}
            title="指令轮询"
            detail="每隔多少秒读取一次话题里的新回复"
            control={(
              <input
                style={{ ...inputStyle, width: 90 }}
                type="number"
                min={5}
                max={3600}
                value={form.pollSeconds}
                onChange={event => { update('pollSeconds', Number(event.target.value)) }}
              />
            )}
          />
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>通知内容</div>
          <Row icon={<StatusDot tone="accent" />} title="评审完成" detail="自动评审出意见时发一条汇总" control={<Switch on={form.notify.review} onChange={value => { updateNotify('review', value) }} label="评审完成通知" />} />
          <Row icon={<StatusDot tone="ok" />} title="修复会话结束" detail="dsh 修复会话结束（成功）时发一条结果" control={<Switch on={form.notify.fix} onChange={value => { updateNotify('fix', value) }} label="修复结束通知" />} />
          <Row icon={<StatusDot tone="bad" />} title="失败与阻塞" detail="评审失败、修复失败或无法完成时也发一条" control={<Switch on={form.notify.failure} onChange={value => { updateNotify('failure', value) }} label="失败通知" />} />
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>高级</div>
          <Row
            icon={<GBot size={14} />}
            title="lark-cli 命令"
            detail="默认从 PATH 查找；daemon 的 PATH 里没有时可以填绝对路径"
            control={<input style={{ ...inputStyle, width: 300, fontFamily: FONT_MONO }} value={form.command} onChange={event => { update('command', event.target.value) }} />}
          />
          <Row
            icon={<GGithub size={14} />}
            title="HTTPS 代理"
            detail="访问飞书需要走代理时填写；已保存的值不会回显，留空保持不变"
            note={config?.hasProxy === true ? '已保存代理' : '未配置代理'}
            control={<input style={{ ...inputStyle, width: 300, fontFamily: FONT_MONO }} type="password" placeholder={config?.hasProxy === true ? '已保存，留空不修改' : 'http://proxy:3128'} value={form.proxy} onChange={event => { update('proxy', event.target.value) }} />}
          />
        </div>

        <div style={cardStyle}>
          <div style={cardTitleStyle}>已有话题</div>
          {threads.length === 0 && <p style={hintStyle}>还没有话题；第一次发送进展时会自动创建。</p>}
          {threads.map(thread => (
            <div key={thread.key} style={rowStyle}>
              <span style={{ display: 'inline-flex', flex: 'none', color: C_ACCENT }}><GBot size={14} /></span>
              <div style={rowTextStyle}>
                <div style={rowTitleStyle}>{thread.title}</div>
                <div style={{ ...rowDetailStyle, fontFamily: FONT_MONO }}>{thread.threadId}</div>
              </div>
              <div style={rowControlStyle}>
                <button type="button" style={dangerButtonStyle} onClick={() => { void forgetThread(thread.key) }} title="移除话题映射，不影响群里的消息">
                  <GTrash size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

const DEFAULT_FORM: Form = {
  enabled: false,
  command: 'lark-cli',
  proxy: '',
  chatId: '',
  webBaseUrl: '',
  pollSeconds: 10,
  notify: { review: true, fix: true, failure: true },
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
const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 14, border: `1px solid ${C_BORDER}`, borderRadius: 8, background: C_SURFACE, overflow: 'hidden' }
const cardTitleStyle: CSSProperties = { padding: '9px 12px 3px', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: C_MUTED }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 10, minHeight: 56, padding: '10px 12px', borderBottom: `1px solid ${C_BORDER}` }
const rowTextStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }
const rowTitleStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: C_TEXT }
const rowDetailStyle: CSSProperties = { fontSize: 12, color: C_SECONDARY, lineHeight: 1.45 }
const rowNoteStyle: CSSProperties = { fontSize: 11.5, lineHeight: 1.45 }
const rowControlStyle: CSSProperties = { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, paddingTop: 2 }
const inputStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', height: 28, padding: '0 8px', border: `1px solid ${C_BORDER}`, borderRadius: 5, background: C_SURFACE, color: C_TEXT, fontFamily: 'inherit', fontSize: 12.5, outline: 'none' }
const hintStyle: CSSProperties = { margin: 0, padding: '8px 12px 10px', fontSize: 11.5, color: C_MUTED, lineHeight: 1.5 }
const secondaryButton: CSSProperties = { height: 26, padding: '0 11px', border: `1px solid ${C_BORDER}`, borderRadius: 6, background: C_SURFACE, color: C_TEXT, fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }
const switchStyle: CSSProperties = { position: 'relative', flex: 'none', width: 26, height: 14, border: 'none', borderRadius: 7, cursor: 'pointer', transition: 'background-color 150ms' }
const knobStyle: CSSProperties = { position: 'absolute', top: 2, left: 2, width: 10, height: 10, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transition: 'transform 150ms' }
