declare module '@dreamcatcher-tech/commit-graph/dist/esm/index.js' {
  import type { ComponentType } from 'react'

  interface CommitGraphCommit {
    sha: string
    commit: {
      author: { name: string; date: string | number | Date; email?: string }
      message: string
    }
    parents: Array<{ sha: string }>
    html_url?: string
  }

  interface CommitGraphBranch {
    name: string
    commit: { sha: string }
    link?: string
  }

  export const CommitGraph: ComponentType<{
    commits: CommitGraphCommit[]
    branchHeads: CommitGraphBranch[]
    graphStyle?: {
      commitSpacing: number
      branchSpacing: number
      branchColors: string[]
      nodeRadius: number
    }
    currentBranch?: string
  }>
}
