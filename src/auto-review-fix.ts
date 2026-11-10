/**
 * Reading the un-pushed fix work left in a PR clone.
 *
 * The auto-review fix session deliberately never commits: the model edits the
 * working tree and dshw shows `git diff` to the user, who decides later whether
 * to push (from Feishu or the review page). This module turns the working tree
 * into a snapshot for the card and a live diff for the page.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { now } from './util.ts'

const run = promisify(execFile)

/** One snapshot of the working-tree changes. */
export interface FixDiff {
  /** `git diff --stat` last line, e.g. `2 files changed, 10 insertions(+), 3 deletions(-)`. */
  stat: string
  /** Unified diff, capped so a card/page stays small. */
  patch: string
  /** Tracked files with changes, plus untracked files. */
  files: string[]
  additions: number
  deletions: number
  truncated: boolean
  capturedAt: string
}

const MAX_PATCH = 200 * 1024

async function git(clonePath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', clonePath, ...args], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/** Capture the working-tree diff of a clone; undefined when it cannot be read. */
export async function captureFixDiff(clonePath: string): Promise<FixDiff | undefined> {
  try {
    const status = await git(clonePath, ['status', '--porcelain'])
    if (status.trim() === '') return undefined
    const stat = (await git(clonePath, ['diff', '--stat'])).trim().split('\n').at(-1) ?? ''
    const patch = await git(clonePath, ['diff', '--no-color'])
    const files = status.split('\n').map(line => line.slice(3).trim()).filter(Boolean)
    let additions = 0
    let deletions = 0
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
    }
    return {
      stat,
      patch: patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n…（diff 已截断）` : patch,
      files,
      additions,
      deletions,
      truncated: patch.length > MAX_PATCH,
      capturedAt: now(),
    }
  } catch {
    return undefined
  }
}

/** Short card copy: `3 个文件 · +42 −7`. */
export function formatFixDiff(diff: FixDiff | undefined): string {
  if (diff === undefined) return '工作区没有改动'
  const files = diff.files.length === 1 ? `1 个文件` : `${String(diff.files.length)} 个文件`
  return `${files} · +${String(diff.additions)} −${String(diff.deletions)}`
}

/** Parse the summary turn's `SUMMARY:` / `NOTES:` block. */
export function parseFixSummary(output: string): { summary: string, notes: string[] } {
  const lines = output.split('\n').map(line => line.trim())
  const summaryLine = lines.find(line => /^SUMMARY:/u.test(line))
  const summary = summaryLine === undefined ? '' : summaryLine.replace(/^SUMMARY:[ \t]*/u, '').trim()
  const notes: string[] = []
  const notesIndex = lines.findIndex(line => /^NOTES:/u.test(line))
  if (notesIndex >= 0) {
    const inline = lines[notesIndex]!.replace(/^NOTES:[ \t]*/u, '').trim()
    if (inline !== '' && !/^无$/u.test(inline)) notes.push(inline)
    for (const line of lines.slice(notesIndex + 1)) {
      if (line === '') break
      const bullet = /^[-*]\s*(.+)$/u.exec(line)
      if (bullet === null) break
      const note = bullet[1]!.trim()
      if (note !== '' && !/^无$/u.test(note)) notes.push(note)
    }
  }
  return { summary, notes }
}
