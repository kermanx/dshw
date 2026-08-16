/** Git view (GitTree.vue port): branch list + commit graph (reusing
 *  @dreamcatcher-tech/commit-graph) + commit rows. */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { CommitGraph } from '@dreamcatcher-tech/commit-graph'
import type { GitGraphBranch, GitGraphSnapshot, MonitoredRepo } from '../../../src/types.ts'
import { shortTimeLabel } from '../data.ts'
import { GGitGraph, StatusDot } from '../icons.tsx'
import {
  actionLinkStyle, draftBadgeStyle, emptyStateLineStyle, emptyStateStyle,
  emptyStateSubStyle, emptyStateTitleStyle,
} from '../styles.ts'
import { bad, warn, C_ACCENT, C_ACCENT_SOFT, C_BORDER, C_FAINT, C_MUTED, C_SURFACE, C_TEXT, FONT_MONO } from '../theme.ts'

/* ── Git view (GitTree.vue port, reusing @dreamcatcher-tech/commit-graph) ── */

export const ROW_HEIGHT = 32
export const PAGE_SIZE = 100
export const GRAPH_NODE_RADIUS = 2
export const GRAPH_TOP = ROW_HEIGHT / 2 - GRAPH_NODE_RADIUS * 4
export const GRAPH_LEFT_PADDING = 12
export const GRAPH_TEXT_GAP = 12
export const GRAPH_PALETTE = ['#007acc', '#388a34', '#bf8803', '#a1260d', '#7b61a8', '#00838f', '#ad4e00', '#5b7c19', '#6c5ce7', '#c44569']

export function GitView({ baseUrl, refreshKey, repos, openReposSettings }: { baseUrl: string; refreshKey: number; repos: readonly MonitoredRepo[]; openReposSettings: () => void }): ReactNode {
  const [graph, setGraph] = useState<GitGraphSnapshot>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedRepo, setSelectedRepo] = useState<string>()
  const [focusedBranchOid, setFocusedBranchOid] = useState<string>()
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [graphWidth, setGraphWidth] = useState(72)
  const [graphCanvasWidth, setGraphCanvasWidth] = useState(72)
  const [colors, setColors] = useState<Record<string, string>>({})
  const graphHostRef = useRef<HTMLDivElement>(null)
  const graphScrollRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<AbortController | undefined>(undefined)

  const commits = graph?.commits ?? []
  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const children = new Map<string, string[]>()
  for (const commit of commits) {
    for (const parent of commit.parents) {
      children.set(parent, [...(children.get(parent) ?? []), commit.hash])
    }
  }

  const ancestorsOf = (tip: string): Set<string> => {
    const ancestors = new Set<string>()
    const pending = [tip]
    while (pending.length > 0) {
      const hash = pending.pop()!
      if (ancestors.has(hash)) continue
      ancestors.add(hash)
      const commit = byHash.get(hash)
      if (commit !== undefined) pending.push(...commit.parents)
    }
    return ancestors
  }

  const masterOid = graph?.branches.find(branch => branch.kind === 'master')?.oid
  const visibleBranches = graph?.branches.filter(branch => (
    focusedBranchOid === undefined || branch.oid === focusedBranchOid || branch.kind === 'master'
  )) ?? []
  const focusedCommits = commits.filter(commit => {
    if (focusedBranchOid === undefined || masterOid === undefined) return true
    const branchAncestors = ancestorsOf(focusedBranchOid)
    const masterAncestors = ancestorsOf(masterOid)
    return branchAncestors.has(commit.hash) || masterAncestors.has(commit.hash)
  })
  const allOrderedCommits = ((): typeof commits => {
    const readyOrder = [...focusedCommits].sort((left, right) => {
      if (left.hash === masterOid) return -1
      if (right.hash === masterOid) return 1
      return right.author.timestamp - left.author.timestamp || left.hash.localeCompare(right.hash)
    })
    const seen = new Set<string>()
    const result: typeof commits = []
    const visit = (hash: string): void => {
      if (seen.has(hash)) return
      const commit = byHash.get(hash)
      if (commit === undefined) return
      seen.add(hash)
      for (const child of children.get(hash) ?? []) visit(child)
      result.push(commit)
    }
    for (const commit of readyOrder) visit(commit.hash)
    return result
  })()
  const orderedCommits = allOrderedCommits.slice(0, visibleCount)
  const hasMore = orderedCommits.length < allOrderedCommits.length
  const graphHeight = orderedCommits.length * ROW_HEIGHT
  const graphContentHeight = graphHeight + (hasMore ? ROW_HEIGHT : 0)
  const branchesByOid = new Map<string, GitGraphBranch[]>()
  for (const branch of visibleBranches) {
    branchesByOid.set(branch.oid, [...(branchesByOid.get(branch.oid) ?? []), branch])
  }

  const load = async (repoSlug: string | undefined): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    try {
      const query = repoSlug === undefined ? '' : `?repo=${encodeURIComponent(repoSlug)}`
      const response = await fetch(`${baseUrl}/api/git-graph${query}`, { cache: 'no-store', signal: controller.signal })
      const value = await response.json() as GitGraphSnapshot & { error?: string }
      if (!response.ok) throw new Error(value.error ?? 'Git tree 加载失败')
      setColors({})
      setVisibleCount(PAGE_SIZE)
      setGraph(value)
      if (focusedBranchOid !== undefined && !value.branches.some(branch => branch.oid === focusedBranchOid)) {
        setFocusedBranchOid(undefined)
      }
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  const effectiveRepo = repos.length === 0
    ? undefined
    : selectedRepo !== undefined && repos.some(repo => repo.repoSlug === selectedRepo)
      ? selectedRepo
      : repos[0]!.repoSlug

  useEffect(() => {
    if (repos.length === 0) {
      setGraph(undefined)
      setError('')
      return
    }
    void load(effectiveRepo)
    return () => { controllerRef.current?.abort() }
  }, [baseUrl, refreshKey, effectiveRepo, repos.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Measure the rendered CommitGraph: canvas width + per-branch colors.
  useEffect(() => {
    const host = graphHostRef.current
    if (host === null) return
    const frame = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(() => {
        const svg = host.querySelector('svg')
        const width = svg?.width.baseVal.value
        if (width !== undefined && Number.isFinite(width)) setGraphCanvasWidth(Math.max(44, Math.min(220, width)))
        const nodes = [...host.querySelectorAll<SVGGElement>('svg g[filter^="url(#filter_"]')]
        const next: Record<string, string> = {}
        let rightmostNode = 0
        for (const node of nodes) {
          const match = node.getAttribute('filter')?.match(/^url\(#filter_(.+)_node\)$/u)
          if (match?.[1] === undefined) continue
          const circle = node.querySelector('circle')
          const color = node.getAttribute('fill') ?? circle?.getAttribute('fill')
          if (color !== null && color !== undefined) next[match[1]] = color
          const x = Number(circle?.getAttribute('cx'))
          if (Number.isFinite(x)) rightmostNode = Math.max(rightmostNode, x)
        }
        setColors(next)
        setGraphWidth(Math.max(44, Math.min(220, GRAPH_LEFT_PADDING + rightmostNode + GRAPH_NODE_RADIUS + GRAPH_TEXT_GAP)))
      })
      return () => { cancelAnimationFrame(inner) }
    })
    return () => { cancelAnimationFrame(frame) }
  }, [orderedCommits, graph])

  const focusBranch = (branch: GitGraphBranch): void => {
    setColors({})
    setVisibleCount(PAGE_SIZE)
    setFocusedBranchOid(current => current === branch.oid ? undefined : branch.oid)
  }

  const loadMore = (): void => {
    if (!hasMore) return
    setVisibleCount(Math.min(visibleCount + PAGE_SIZE, allOrderedCommits.length))
  }

  const onGraphScroll = (): void => {
    const element = graphScrollRef.current
    if (element === null || !hasMore) return
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= ROW_HEIGHT * 12) loadMore()
  }

  const branchColor = (oid: string, fallbackIndex: number): string => colors[oid] ?? GRAPH_PALETTE[fallbackIndex % GRAPH_PALETTE.length]!
  const commitUrl = (hash: string): string => `https://github.com/${graph?.repoSlug ?? 'deepseek-harness/deepseek-harness'}/commit/${hash}`
  const commitTime = (timestamp: number): string => shortTimeLabel(new Date(timestamp).toISOString())

  const visible = new Set(orderedCommits.map(commit => commit.hash))
  const graphCommits = orderedCommits.map(commit => ({
    sha: commit.hash,
    commit: {
      author: {
        name: commit.author.name,
        email: commit.author.email,
        date: commit.hash === masterOid
          ? new Date(8_639_999_999_999_999)
          : new Date(commit.author.timestamp),
      },
      message: commit.subject,
    },
    parents: commit.parents.filter(parent => visible.has(parent)).map(sha => ({ sha })),
  }))
  const branchHeads = visibleBranches
    .filter(branch => visible.has(branch.oid))
    .map(branch => ({ name: branch.label, commit: { sha: branch.oid }, link: branch.url }))

  return (
    <div style={gitLayoutStyle}>
      <aside style={gitSidebarStyle}>
        <div style={gitSidebarHeaderStyle}>
          <div style={gitSidebarTitleStyle}>
            <span style={{ display: 'inline-flex', flex: 'none', color: C_ACCENT }}><GGitGraph size={14} /></span>
            {repos.length > 1 ? (
              <select
                value={effectiveRepo ?? ''}
                aria-label="选择仓库"
                style={repoSelectStyle}
                onChange={event => { setSelectedRepo(event.target.value === '' ? undefined : event.target.value) }}
              >
                {repos.map(repo => <option key={repo.repoSlug} value={repo.repoSlug}>{repo.repoSlug}</option>)}
              </select>
            ) : (
              <span style={gitSidebarTitleTextStyle}>{effectiveRepo ?? 'Git tree'}</span>
            )}
          </div>
          <div style={gitSidebarSubStyle}>
            {graph !== undefined
              ? `${graph.commits.length} 个提交 · ${graph.branches.length} 个分支`
              : '正在读取 Git 历史…'}
          </div>
        </div>
        {graph !== undefined && (
          <div style={gitSidebarListStyle}>
            {graph.branches.map((branch, index) => {
              const active = focusedBranchOid === branch.oid
              return (
                <div
                  key={`${branch.kind}:${branch.name}:${branch.number ?? ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  data-dshw-kanban="gitbranch"
                  onClick={() => { focusBranch(branch) }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusBranch(branch) }
                  }}
                  style={active ? gitBranchItemActiveStyle : gitBranchItemStyle}
                >
                  <span style={{ ...gitBranchDotStyle, background: branchColor(branch.oid, index) }} />
                  <span style={gitBranchTextStyle}>
                    <span style={gitBranchLineStyle}>
                      {branch.kind === 'pr' && branch.url !== undefined ? (
                        <>
                          <a style={gitPrLinkStyle} data-dshw-kanban="gitpr" href={branch.url} target="_blank" rel="noreferrer" onClick={event => { event.stopPropagation() }}>
                            PR #{branch.number}
                          </a>
                          <span style={gitBranchSeparatorStyle}>·</span>
                          <span style={gitBranchNameStyle}>{branch.name}</span>
                        </>
                      ) : (
                        <span style={gitBranchNameStyle}>{branch.name}</span>
                      )}
                      {branch.isDraft === true && <span style={draftBadgeStyle}>draft</span>}
                    </span>
                    {branch.title !== undefined && <span style={gitBranchTitleStyle} title={branch.title}>{branch.title}</span>}
                    <span style={gitBranchOidStyle}>{branch.oid.slice(0, 8)}</span>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </aside>

      <section style={gitMainStyle}>
        <div style={gitToolbarStyle}>
          <span style={gitToolbarTitleStyle}>Commit history</span>
          {graph !== undefined && (
            <>
              <span style={{ marginLeft: 'auto' }}>{shortTimeLabel(graph.generatedAt)} 更新</span>
              {graph.truncated === true && <span style={{ color: warn }}>仅显示相关历史</span>}
              {loading && (
                <span style={gitRefreshRowStyle}><StatusDot tone="accent" pulse />刷新中</span>
              )}
            </>
          )}
        </div>

        {repos.length === 0 && (
          <div style={emptyStateStyle}>
            <p style={emptyStateTitleStyle}>还没有选择要监控的仓库</p>
            <p style={emptyStateSubStyle}>选择仓库后，这里会显示它的 Git 历史和分支</p>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={openReposSettings}>去设置 Repos →</button>
          </div>
        )}
        {loading && graph === undefined && (
          <div style={emptyStateStyle}>
            <span style={emptyStateLineStyle}><StatusDot tone="accent" pulse />正在读取 Git 历史…</span>
          </div>
        )}
        {error !== '' && (
          <div style={emptyStateStyle}>
            <span style={{ ...emptyStateTitleStyle, color: bad }}>Git tree 加载失败</span>
            <span style={emptyStateSubStyle}>{error}</span>
            <button type="button" className="dshw-link" style={actionLinkStyle} onClick={() => { void load(effectiveRepo) }}>重试</button>
          </div>
        )}
        {graph !== undefined && (
          <div ref={graphScrollRef} style={gitScrollStyle} onScroll={onGraphScroll}>
            <div style={{ position: 'relative', minWidth: 760, height: graphContentHeight }}>
              <div
                ref={graphHostRef}
                data-dshw-kanban="gitgraph"
                aria-hidden="true"
                style={{ position: 'absolute', zIndex: 2, pointerEvents: 'none', overflow: 'hidden', left: GRAPH_LEFT_PADDING, top: GRAPH_TOP, width: graphCanvasWidth, height: Math.max(0, graphHeight - GRAPH_TOP) }}
              >
                <CommitGraph
                  commits={graphCommits}
                  branchHeads={branchHeads}
                  graphStyle={{ commitSpacing: ROW_HEIGHT, branchSpacing: 13, branchColors: GRAPH_PALETTE, nodeRadius: GRAPH_NODE_RADIUS }}
                  currentBranch="master"
                />
              </div>
              {orderedCommits.map(commit => (
                <div
                  key={commit.hash}
                  data-dshw-kanban="gitrow"
                  style={{ ...gitCommitRowStyle, paddingLeft: graphWidth }}
                  title={`${commit.hash}\n${commit.subject}\n${commit.author.name} <${commit.author.email}>`}
                >
                  <a
                    style={gitHashStyle}
                    data-dshw-kanban="githash"
                    href={commitUrl(commit.hash)}
                    target="_blank"
                    rel="noreferrer"
                    title={`在 GitHub 查看 ${commit.hash}`}
                  >{commit.hash.slice(0, 7)}</a>
                  {(branchesByOid.get(commit.hash) ?? []).map(branch => {
                    const color = branchColor(commit.hash, 0)
                    const chip = { ...refChipStyle(color), maxWidth: 240 }
                    return branch.url !== undefined ? (
                      <a key={`${branch.kind}:${branch.name}`} style={chip} href={branch.url} target="_blank" rel="noreferrer" title={branch.title}>
                        <span style={{ fontWeight: 600 }}>#{branch.number}</span>
                        <span style={gitChipTextStyle}>{branch.name}</span>
                        {branch.isDraft === true && <span style={{ opacity: 0.7 }}>draft</span>}
                      </a>
                    ) : (
                      <span key={`${branch.kind}:${branch.name}`} style={chip}>{branch.name}</span>
                    )
                  })}
                  <span style={gitSubjectStyle}>{commit.subject}</span>
                  <span style={gitAuthorStyle}>{commit.author.name}</span>
                  <time style={gitTimeStyle}>{commitTime(commit.author.timestamp)}</time>
                </div>
              ))}
              {hasMore && (
                <button type="button" data-dshw-kanban="loadmore" style={{ ...gitLoadMoreStyle, top: graphHeight }} onClick={loadMore}>
                  加载更多（剩余 {allOrderedCommits.length - orderedCommits.length} 条）
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}


/* ── git view styles ── */

/* ── git view styles ── */

export const gitLayoutStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '270px minmax(0, 1fr)',
  background: C_SURFACE,
}

export const gitSidebarStyle: CSSProperties = {
  minHeight: 0,
  overflowY: 'auto',
  borderRight: `1px solid ${C_BORDER}`,
  background: C_SURFACE,
}

export const gitSidebarHeaderStyle: CSSProperties = {
  padding: '10px 12px',
  borderBottom: `1px solid ${C_BORDER}`,
}

export const gitSidebarTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  fontWeight: 600,
  color: C_TEXT,
}

export const repoSelectStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '2px 6px',
  border: `1px solid ${C_BORDER}`,
  borderRadius: 4,
  background: C_SURFACE,
  color: C_TEXT,
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
}

export const gitSidebarTitleTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export const gitSidebarSubStyle: CSSProperties = { marginTop: 3, fontSize: 11.5, color: C_MUTED }

export const gitSidebarListStyle: CSSProperties = { padding: '5px 0' }

export const gitBranchItemStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '7px 12px',
  cursor: 'pointer',
}

export const gitBranchItemActiveStyle: CSSProperties = {
  ...gitBranchItemStyle,
  background: C_ACCENT_SOFT,
}

export const gitBranchDotStyle: CSSProperties = {
  flex: 'none',
  width: 7,
  height: 7,
  marginTop: 6,
  borderRadius: '50%',
}

export const gitBranchTextStyle: CSSProperties = { minWidth: 0, flex: 1 }

export const gitBranchLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  fontSize: 12,
  fontWeight: 500,
  color: C_TEXT,
}

export const gitPrLinkStyle: CSSProperties = { flex: 'none', color: 'inherit' }

export const gitBranchSeparatorStyle: CSSProperties = { color: C_MUTED }

export const gitBranchNameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export const gitBranchTitleStyle: CSSProperties = {
  display: 'block',
  marginTop: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: C_MUTED,
}

export const gitBranchOidStyle: CSSProperties = {
  display: 'block',
  marginTop: 1,
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_FAINT,
}

export const gitMainStyle: CSSProperties = {
  position: 'relative',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: C_SURFACE,
}

export const gitToolbarStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 36,
  padding: '0 12px',
  boxSizing: 'border-box',
  borderBottom: `1px solid ${C_BORDER}`,
  fontSize: 11.5,
  color: C_MUTED,
}

export const gitToolbarTitleStyle: CSSProperties = { fontWeight: 600, color: C_TEXT }

export const gitRefreshRowStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5 }

export const gitScrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' }

export const gitCommitRowStyle: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: ROW_HEIGHT,
  paddingRight: 12,
  boxSizing: 'border-box',
  borderBottom: `1px solid color-mix(in srgb, ${C_BORDER} 55%, transparent)`,
}

export const gitHashStyle: CSSProperties = {
  flex: 'none',
  width: 58,
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_FAINT,
}

export const gitChipTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

export const gitSubjectStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
  color: C_TEXT,
}

export const gitAuthorStyle: CSSProperties = {
  flex: 'none',
  maxWidth: 130,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: C_MUTED,
}

export const gitTimeStyle: CSSProperties = {
  flex: 'none',
  width: 70,
  textAlign: 'right',
  fontFamily: FONT_MONO,
  fontSize: 10.5,
  color: C_FAINT,
}

export const gitLoadMoreStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: ROW_HEIGHT,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: C_MUTED,
}

export const refChipStyle = (color: string): CSSProperties => ({
  display: 'inline-flex',
  flex: 'none',
  alignItems: 'center',
  gap: 3,
  height: 20,
  border: `1px solid color-mix(in srgb, ${color} 38%, white)`,
  borderRadius: 3,
  padding: '0 4px',
  boxSizing: 'border-box',
  fontSize: 10.5,
  lineHeight: '18px',
  textDecoration: 'none',
  background: `color-mix(in srgb, ${color} 10%, white)`,
  color: `color-mix(in srgb, ${color} 82%, black)`,
})
