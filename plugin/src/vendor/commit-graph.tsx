/*
 * Fallback commit graph renderer.
 *
 * The Git view renders its lane graph with `@dreamcatcher-tech/commit-graph`.
 * That package is a regular dependency, so a machine with registry access
 * resolves the real component and never loads this file. It only exists so a
 * checkout without installed dependencies (for example an offline development
 * box) can still build the client bundle; `scripts/build-plugin.mjs` aliases
 * the import here when the package cannot be resolved.
 *
 * The element contract matches what `views/git.tsx` measures after a render:
 *
 *   - the root renders `<div><div><svg width={…} height={…}>…</svg></div></div>`
 *   - every commit node is `<g filter="url(#filter_<sha>_node)">` with a
 *     `<circle cx={…}>` child, coloured per branch lane
 *
 * Keep those two promises when touching this file: the Git view derives its
 * graph gutter width and per-branch colours from them.
 */
import type { ReactElement } from 'react'

/** One commit as the Git view hands it to the graph. */
export interface CommitGraphCommit {
  sha: string
  commit: {
    author: { name: string, email: string, date: Date }
    message: string
  }
  parents: Array<{ sha: string }>
}

/** One branch tip rendered next to its commit. */
export interface CommitGraphBranchHead {
  name: string
  commit: { sha: string }
  link?: string
}

/** Spacing and palette knobs (a superset of what the Git view passes). */
export interface CommitGraphStyle {
  commitSpacing?: number
  branchSpacing?: number
  branchColors?: readonly string[]
  nodeRadius?: number
}

export interface CommitGraphProps {
  commits: readonly CommitGraphCommit[]
  branchHeads?: readonly CommitGraphBranchHead[]
  graphStyle?: CommitGraphStyle
  currentBranch?: string
  fullSha?: boolean
  selected?: readonly string[]
  onClick?: (sha: string, event: unknown) => void
}

const DEFAULT_STYLE: Required<CommitGraphStyle> = {
  commitSpacing: 90,
  branchSpacing: 20,
  nodeRadius: 2,
  branchColors: ['#010A40', '#FC42C9', '#3D91F0', '#29E3C1', '#C5A15A', '#FA7978', '#5D6280', '#5AC58D', '#5C5AC5', '#EB7340'],
}

/** One laid-out row: the commit, its lane and its pixel position. */
interface Row {
  sha: string
  lane: number
  y: number
  parents: string[]
}

/** A vertical slice of a lane that has to be drawn. */
interface Segment {
  lane: number
  fromY: number
  toY: number
}

/**
 * Assign lanes top-to-bottom. A commit inherits the lane of its first child
 * (the row above that points at it); commits without one take the leftmost
 * free lane, so independent branches spread out and merges collapse back.
 */
export function layoutCommitGraph(commits: readonly CommitGraphCommit[]): { rows: Row[]; laneCount: number } {
  const lanes: Array<string | undefined> = []
  const rows: Row[] = []
  const indexOf = new Map<string, number>()
  commits.forEach((commit, index) => { indexOf.set(commit.sha, index) })

  commits.forEach((commit, index) => {
    let lane = lanes.indexOf(commit.sha)
    if (lane < 0) {
      lane = lanes.indexOf(undefined)
      if (lane < 0) {
        lane = lanes.length
        lanes.push(undefined)
      }
    }
    // Keep the lane reserved for this commit until it has been consumed, then
    // hand it to the first parent; later parents open their own lanes.
    const parents = commit.parents.map(parent => parent.sha).filter(sha => indexOf.has(sha))
    lanes[lane] = parents[0]
    for (const parent of parents.slice(1)) {
      if (lanes.includes(parent)) continue
      const free = lanes.indexOf(undefined)
      if (free < 0) lanes.push(parent)
      else lanes[free] = parent
    }
    rows.push({ sha: commit.sha, lane, y: index, parents })
    // Drop rows whose only remaining obligation was this commit.
    while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) lanes.pop()
  })

  const laneCount = rows.reduce((maximum, row) => Math.max(maximum, row.lane + 1), 0)
  return { rows, laneCount }
}

/** Collect the lane segments connecting every commit to its parents. */
function segmentsOf(rows: readonly Row[], byIndex: ReadonlyMap<string, number>): Segment[] {
  const segments: Segment[] = []
  for (const row of rows) {
    for (const parent of row.parents) {
      const parentIndex = byIndex.get(parent)
      if (parentIndex === undefined) continue
      const parentRow = rows[parentIndex]
      if (parentRow === undefined) continue
      segments.push({ lane: row.lane, fromY: Math.min(row.y, parentRow.y), toY: Math.max(row.y, parentRow.y) })
      if (parentRow.lane !== row.lane) {
        segments.push({ lane: parentRow.lane, fromY: Math.min(row.y, parentRow.y), toY: Math.max(row.y, parentRow.y) })
      }
    }
  }
  return segments
}

/**
 * Lane graph: vertical branch lines plus one node per commit. Commit rows are
 * drawn by the Git view itself; the graph only owns the gutter beside them.
 */
export function CommitGraph({ commits, graphStyle }: CommitGraphProps): ReactElement {
  const style = { ...DEFAULT_STYLE, ...graphStyle }
  const { rows, laneCount } = layoutCommitGraph(commits)
  const byIndex = new Map(rows.map((row, index) => [row.sha, index]))
  const columnX = (lane: number): number => 4 * style.nodeRadius + lane * style.branchSpacing
  const rowY = (index: number): number => index * style.commitSpacing + 2 * style.nodeRadius
  const width = laneCount === 0 ? 0 : laneCount * (style.branchSpacing + 2 * style.nodeRadius) + 3
  const height = rows.length === 0 ? 0 : (rows.length - 1) * style.commitSpacing + 8 * style.nodeRadius + 64
  const segments = segmentsOf(rows, byIndex)
  const colorOf = (lane: number): string => style.branchColors[lane % style.branchColors.length] ?? '#010A40'

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', zIndex: 0 }}>
      <div style={{ maxWidth: 500, overflowX: 'scroll', scrollbarWidth: 'none' }}>
        <svg width={width} height={height}>
          {segments.map((segment, index) => (
            <line
              key={`segment-${String(index)}`}
              x1={columnX(segment.lane)}
              y1={rowY(segment.fromY)}
              x2={columnX(segment.lane)}
              y2={rowY(segment.toY)}
              stroke={colorOf(segment.lane)}
              strokeWidth={2 * style.nodeRadius}
              strokeLinecap="round"
            />
          ))}
          {rows.map(row => (
            <g key={`node-${row.sha}`} filter={`url(#filter_${row.sha}_node)`} fill={colorOf(row.lane)}>
              <circle cx={columnX(row.lane)} cy={rowY(row.y)} r={style.nodeRadius} fill={colorOf(row.lane)} />
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}

export default CommitGraph
