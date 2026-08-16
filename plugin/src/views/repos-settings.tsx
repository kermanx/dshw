/** Repos settings panel: pick which GitHub repos dshw monitors and drag to
 *  reorder them (the order drives every other panel). */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { MonitoredRepo } from '../../../src/types.ts'
import { GGithub, GGrip, StatusDot } from '../icons.tsx'
import {
  actionLinkStyle, emptyStateStyle,
} from '../styles.ts'
import { C_ACCENT, C_BORDER, C_FAINT, C_HOVER, C_MUTED, C_SECONDARY, C_SURFACE, C_TEXT, FONT_MONO } from '../theme.ts'
import { settingsBodyStyle, settingsSectionHeaderStyle, settingsSectionSubStyle, settingsSectionStyle, settingsSectionTitleStyle } from './settings.tsx'

export function ReposSection({ baseUrl, repos, showToast }: {
  baseUrl: string
  repos: readonly MonitoredRepo[]
  showToast: (message: string, bad?: boolean) => void
}): ReactNode {
  const [available, setAvailable] = useState<string[]>()
  const [availableError, setAvailableError] = useState('')
  const [loading, setLoading] = useState(false)
  const [displayed, setDisplayed] = useState<string[]>(() => repos.filter(repo => repo.enabled).map(repo => repo.repoSlug))
  const [dragged, setDragged] = useState<string>()
  const [dragOver, setDragOver] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')

  // Keep the local order in sync with the daemon snapshot (restart / other clients).
  useEffect(() => {
    setDisplayed(current => {
      const next = repos.filter(repo => repo.enabled).map(repo => repo.repoSlug)
      return JSON.stringify(current) === JSON.stringify(next) ? current : next
    })
  }, [repos])

  const loadAvailable = async (): Promise<void> => {
    if (loading) return
    setLoading(true)
    setAvailableError('')
    try {
      const response = await fetch(`${baseUrl}/api/repos/available`)
      const value = await response.json() as { repos?: string[]; error?: string }
      if (!response.ok || value.repos === undefined) throw new Error(value.error ?? `HTTP ${response.status}`)
      setAvailable(value.repos)
    } catch (error) {
      setAvailableError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadAvailable() }, [baseUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: string[]): Promise<void> => {
    if (saving) return
    setSaving(true)
    const previous = displayed
    setDisplayed(next)
    try {
      const response = await fetch(`${baseUrl}/api/repos`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repos: next.map(repoSlug => ({ repoSlug, enabled: true })) }),
      })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      showToast('监控仓库已更新')
    } catch (error) {
      setDisplayed(previous)
      showToast(`更新失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      setSaving(false)
    }
  }

  const toggle = (repoSlug: string, checked: boolean): void => {
    const next = checked
      ? [...displayed, repoSlug]
      : displayed.filter(slug => slug !== repoSlug)
    void save(next)
  }

  const monitored = new Set(displayed)
  const unmonitoredTotal = (available ?? []).filter(slug => !monitored.has(slug)).length
  const trimmedQuery = query.trim().toLowerCase()
  const rest = (available ?? [])
    .filter(slug => !monitored.has(slug))
    .filter(slug => trimmedQuery === '' || slug.toLowerCase().includes(trimmedQuery))
    .sort((left, right) => left.localeCompare(right))

  const row = (repoSlug: string, checked: boolean, draggable: boolean): ReactNode => (
    <div
      key={repoSlug}
      draggable={draggable && !saving}
      style={{ ...repoRowStyle, opacity: dragged === repoSlug ? 0.45 : 1 }}
      onDragStart={event => {
        if (!draggable || saving) return
        setDragged(repoSlug)
        setDragOver(repoSlug)
        event.dataTransfer.setData('text/plain', repoSlug)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={event => {
        if (!draggable || dragged === undefined || saving) return
        event.preventDefault()
        if (repoSlug === dragOver) return
        const from = displayed.findIndex(slug => slug === dragged)
        const to = displayed.findIndex(slug => slug === repoSlug)
        if (from < 0 || to < 0) return
        const reordered = [...displayed]
        const [moved] = reordered.splice(from, 1)
        if (moved !== undefined) reordered.splice(to, 0, moved)
        setDisplayed(reordered)
        setDragOver(repoSlug)
      }}
      onDrop={event => {
        event.preventDefault()
        setDragged(undefined)
        setDragOver(undefined)
        void save(displayed)
      }}
      onDragEnd={() => {
        setDragged(undefined)
        setDragOver(undefined)
        setDisplayed(repos.filter(repo => repo.enabled).map(repo => repo.repoSlug))
      }}
    >
      <span style={{ display: 'inline-flex', flex: 'none', color: draggable ? C_MUTED : C_FAINT, cursor: draggable ? 'grab' : 'default' }}>
        <GGrip size={13} />
      </span>
      <label style={repoCheckboxStyle}>
        <input
          type="checkbox"
          checked={checked}
          disabled={saving}
          onChange={event => { toggle(repoSlug, event.target.checked) }}
          style={repoCheckboxInputStyle}
        />
        <span style={{ display: 'inline-flex', flex: 'none', color: checked ? C_SECONDARY : C_FAINT }}>
          <GGithub size={12} />
        </span>
        <span style={repoNameStyle}>{repoSlug}</span>
      </label>
    </div>
  )

  return (
    <section style={settingsSectionStyle}>
      <div style={settingsSectionHeaderStyle}>
        <span style={settingsSectionTitleStyle}>Repos</span>
        <span style={settingsSectionSubStyle}>勾选要展示的仓库 · 拖动排序（顺序即各面板展示顺序）</span>
      </div>
      <div style={settingsBodyStyle}>
        {available === undefined && loading && (
          <div style={reposLoadingRowStyle}>
            <StatusDot tone="accent" pulse />
            <span>正在读取你有权限的仓库…</span>
          </div>
        )}
        {available !== undefined && (
          <>
            {displayed.map(repoSlug => row(repoSlug, true, true))}
            {unmonitoredTotal > 0 && (
              <>
                <div style={reposDividerStyle}>
                  <span>可选择的仓库</span>
                  <input
                    type="text"
                    placeholder="搜索仓库…"
                    value={query}
                    onChange={event => { setQuery(event.target.value) }}
                    style={reposSearchStyle}
                  />
                </div>
                {rest.map(repoSlug => row(repoSlug, false, false))}
                {trimmedQuery !== '' && rest.length === 0 && (
                  <div style={reposEmptyQueryStyle}>没有匹配的仓库</div>
                )}
              </>
            )}
            {displayed.length === 0 && (available?.length ?? 0) === 0 && (
              <div style={emptyStateStyle}>
                <span>没有找到你有权限的仓库</span>
              </div>
            )}
          </>
        )}
        {availableError !== '' && (
          <div style={availableErrorStripStyle}>
            <span style={{ fontSize: 11.5, color: C_MUTED }}>仓库列表读取失败：{availableError}</span>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={() => { void loadAvailable() }}>重试</button>
          </div>
        )}
      </div>
    </section>
  )
}

/* ── styles ── */

const repoRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 34,
  padding: '0 12px',
  borderBottom: `1px solid ${C_BORDER}`,
  background: C_SURFACE,
}

const repoCheckboxStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  flex: 1,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const repoCheckboxInputStyle: React.CSSProperties = {
  flex: 'none',
  width: 13,
  height: 13,
  margin: 0,
  accentColor: C_ACCENT,
  cursor: 'pointer',
}

const repoNameStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: FONT_MONO,
  fontSize: 12,
  color: C_TEXT,
}

const availableErrorStripStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  background: C_HOVER,
  borderBottom: `1px solid ${C_BORDER}`,
  color: C_SECONDARY,
}

const reposDividerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px 4px',
  fontSize: 10.5,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: C_MUTED,
  background: C_SURFACE,
  borderBottom: `1px solid ${C_BORDER}`,
}

const reposSearchStyle: React.CSSProperties = {
  marginLeft: 'auto',
  width: 190,
  height: 22,
  padding: '0 8px',
  boxSizing: 'border-box',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 4,
  outline: 'none',
  background: C_SURFACE,
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: C_TEXT,
}

const reposEmptyQueryStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 12,
  color: C_MUTED,
}

const reposLoadingRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 12px',
  fontSize: 12,
  color: C_SECONDARY,
  borderBottom: `1px solid ${C_BORDER}`,
}
