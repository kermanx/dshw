/**
 * Feishu interactive cards for PR progress.
 *
 * Layout (chosen from three prototypes):
 *   header → PR number + full title → conclusion block → fix session block →
 *   collapsed findings panel → two jump buttons.
 *
 * Deliberate choices:
 *  - No red anywhere (user preference); severity is carried by wording and
 *    orange/grey chips.
 *  - The PR title is its own full-width line so a phone preview shows it.
 *  - The fix session block is the progress display: it is patched in place as
 *    the dsh session runs, and the primary button jumps to the review page
 *    (which carries the live-ish fix summary and the diff).
 *  - The findings panel ends with the estimated review cost.
 *
 * Only `open_url` buttons are used, so the card needs no callback endpoint.
 */
import type { AutoReviewComment, AutoReviewRecord } from './types.ts'
import { formatFixDiff } from './auto-review-fix.ts'

/** Card JSON (Feishu Card 2.0) as a JSON string ready for `--content`. */
export type CardJson = string

/** Progress shown in the fix block while the dsh session runs. */
export interface FixProgress {
  status: string
  message?: string
  phase?: string
}

type Tone = 'blue' | 'green' | 'orange' | 'grey'

const MAX_TITLE = 60
const MAX_SUMMARY = 600
const MAX_PROGRESS = 160

/** Feishu markdown is HTML-ish; escape the characters that can open a tag. */
function md(value: string): string {
  return value.replace(/</gu, '&#60;').replace(/>/gu, '&#62;')
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`
}

/** Header copy + palette for one review state. */
export function reviewHeader(record: AutoReviewRecord): { tone: Tone, title: string, icon: string, subtitle: string } {
  if (record.status === 'failed') return { tone: 'orange', title: `PR #${String(record.number)} · 评审失败`, icon: 'warning_outlined', subtitle: record.repoSlug }
  if (record.status === 'running' || record.status === 'pending') return { tone: 'blue', title: `PR #${String(record.number)} · 正在评审`, icon: 'info_outlined', subtitle: record.repoSlug }
  if (record.counts.critical + record.counts.warning + record.counts.suggestion === 0) {
    return { tone: 'green', title: `PR #${String(record.number)} · 评审通过`, icon: 'done_outlined', subtitle: record.repoSlug }
  }
  return { tone: 'blue', title: `PR #${String(record.number)} · 评审完成`, icon: 'info_outlined', subtitle: record.repoSlug }
}

/** Review page link (served by the daemon, proxied under the GUI origin). */
export function reviewLink(record: AutoReviewRecord, webBaseUrl: string | undefined): string | undefined {
  if (webBaseUrl === undefined || webBaseUrl === '') return undefined
  return `${webBaseUrl.replace(/\/+$/u, '')}/api/dshw/review/${encodeURIComponent(record.repoSlug)}/${String(record.number)}`
}

function button(label: string, url: string | undefined, filled: boolean): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: filled ? 'primary_filled' : 'default',
    width: 'fill',
    ...(url === undefined ? { disabled: true, disabled_tips: { tag: 'plain_text', content: '还没有配置看板地址' } } : { behaviors: [{ type: 'open_url', default_url: url }] }),
  }
}

/** A button whose click is delivered to the app as `card.action.trigger`. */
function actionButton(label: string, value: Record<string, string>, filled: boolean): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: filled ? 'primary_filled' : 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value }],
  }
}

/**
 * Action row: real card buttons (callback) plus the review-page jump.
 *
 * The action values are tiny (`{a, k}`: action + record id) because Feishu
 * echoes them back verbatim; the daemon resolves the record from `k`.
 * `flow` lets a phone wrap three buttons into two lines instead of squeezing.
 */
function buttons(record: AutoReviewRecord, link: string | undefined): Record<string, unknown> {
  const fixing = record.fix?.status === 'running'
  const key = record.id
  const columns: Array<Record<string, unknown>> = []
  const push = (element: Record<string, unknown>): void => {
    columns.push({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })
  }
  if (fixing) {
    push(button('查看修复进度', `${link ?? ''}#fix`, true))
    push(actionButton('重新评审', { a: 'review', k: key }, false))
  } else if (record.fix === undefined) {
    push(actionButton('开始修复', { a: 'fix', k: key }, true))
    push(actionButton('重新评审', { a: 'review', k: key }, false))
    push(button('打开评审页', `${link ?? ''}#fix`, false))
  } else if (record.fix.status === 'ready') {
    push(button('查看修复', `${link ?? ''}#fix`, true))
    push(actionButton('推送', { a: 'push', k: key }, false))
    push(actionButton('重新评审', { a: 'review', k: key }, false))
  } else {
    push(button('查看修复结果', `${link ?? ''}#fix`, true))
    push(actionButton('再修一次', { a: 'fix', k: key }, false))
    push(actionButton('重新评审', { a: 'review', k: key }, false))
  }
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns,
  }
}

/** PR identity line: plain text (no bold), the number links to the PR. */
function titleLine(record: AutoReviewRecord): Record<string, unknown> {
  const title = md(truncate(record.title, 200))
  return {
    tag: 'markdown',
    content: `<font color='grey'>[#${String(record.number)}](${record.url})</font> · ${title}`,
  }
}

/**
 * The whole review result as one compact line.
 *
 * Findings themselves live on the review page (behind the button); the card is
 * a glanceable state summary, so it carries the three counts only.
 */
function countsLine(record: AutoReviewRecord): Record<string, unknown> {
  if (record.status === 'failed') return { tag: 'markdown', content: `<font color='orange'>**评审没有完成**</font> · ${md(truncate(record.error ?? '未知错误', 120))}` }
  if (record.status === 'running' || record.status === 'pending') return { tag: 'markdown', content: '**正在评审…**' }
  const counts = record.counts
  if (counts.critical + counts.warning + counts.suggestion === 0) return { tag: 'markdown', content: `<font color='green'>**未发现问题**</font>` }
  const parts: string[] = []
  parts.push(`<font color='orange'>**${String(counts.critical)}**</font> 必须修复`)
  parts.push(`**${String(counts.warning)}** 建议修复`)
  parts.push(`<font color='grey'>**${String(counts.suggestion)}**</font> 建议`)
  return { tag: 'markdown', content: parts.join('　·　') }
}

/**
 * Compress one worker progress line for the card.
 *
 * The daemon forwards the worker's latest event line verbatim — usually
 * `调用工具 <name>：<json>` or `思考：…` — which is too long and too raw for a
 * notification. Keep the tool name and the interesting argument (path/command).
 */
export function summarizeProgress(message: string): string {
  const trimmed = message.trim()
  const tool = /^调用工具 ([^：]+)：(.*)$/u.exec(trimmed)
  if (tool !== null) {
    const name = tool[1]!.trim()
    const payload = tool[2]!.trim()
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      for (const key of ['path', 'file', 'file_path', 'pattern', 'command']) {
        const value = parsed[key]
        if (typeof value === 'string' && value !== '') return `调用工具 ${name}：${truncate(value, 80)}`
      }
    } catch {
      // Not JSON: fall through to the raw text.
    }
    return `调用工具 ${name}：${truncate(payload, 80)}`
  }
  const label = /^(思考|Agent|工具结果|步骤 \d+ (?:开始|完成)|开始任务|任务结束)/u.exec(trimmed)
  return label === null ? truncate(trimmed, 100) : truncate(trimmed, 100)
}

/** One grey state line: review outcome + fix session progress. */
function stateLine(record: AutoReviewRecord, progress: FixProgress | undefined, hint: string | undefined): Record<string, unknown> {
  const parts: string[] = []
  const status = progress?.status ?? record.fix?.status
  if (status === undefined || status === 'idle') {
    parts.push(`修复会话 · 未启动${hint === undefined ? '' : `（${md(hint)}）`}`)
  } else if (status === 'running') {
    const message = progress?.message?.trim() ?? ''
    parts.push(`修复会话 · **进行中**${message === '' ? '' : ` · ${md(summarizeProgress(message))}`}`)
  } else if (status === 'ready') {
    const diff = record.fix?.diff
    const detail = diff === undefined ? '' : ` · ${formatFixDiff(diff)}`
    const summary = record.fix?.summary === undefined ? '' : `\n${md(truncate(record.fix.summary, 200))}`
    parts.push(`修复会话 · **待你确认**（未推送）${detail}${summary}`)
  } else if (status === 'pushed') {
    const produced = record.fix?.producedHeadOid
    const detail = produced === undefined ? '' : ` · \`${produced.slice(0, 7)}\``
    parts.push(`修复会话 · **已推送**${detail}`)
  } else if (status === 'succeeded') {
    const produced = record.fix?.producedHeadOid
    parts.push(`修复会话 · **已完成**${produced === undefined || produced === record.fix?.headOid ? '' : ` · \`${record.fix!.headOid.slice(0, 7)}\` → \`${produced.slice(0, 7)}\``}`)
  } else if (status === 'blocked') {
    parts.push(`修复会话 · **无法完成**${record.fix?.blockedReason === undefined ? '' : ` · ${md(truncate(record.fix.blockedReason, 120))}`}`)
  } else if (status === 'cancelled') {
    parts.push('修复会话 · **已终止**')
  } else {
    parts.push('修复会话 · **失败**')
  }
  return { tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${parts.join('')}</font>` }
}

/** Colored verdict block (orange only when the review failed). */
function conclusionBlock(tone: Tone, headline: string, body: string): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      background_style: `${tone}-50`,
      padding: '10px 12px',
      elements: [
        { tag: 'markdown', content: headline },
        ...(body === '' ? [] : [{ tag: 'markdown', margin: '4px 0px 0px 0px', content: body }]),
      ],
    }],
  }
}

/** Assemble the card skeleton shared by review/fix cards. */
function card(options: {
  tone: Tone
  title: string
  subtitle: string
  icon: string
  summary: string
  elements: Array<Record<string, unknown>>
}): CardJson {
  return JSON.stringify({
    schema: '2.0',
    config: { width_mode: 'default', summary: { content: options.summary } },
    header: {
      title: { tag: 'plain_text', content: truncate(options.title, MAX_TITLE) },
      subtitle: { tag: 'plain_text', content: options.subtitle },
      template: options.tone,
      icon: { tag: 'standard_icon', token: options.icon },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: options.elements,
    },
  })
}

/** Review-finished card (also used while a fix session is running). */
export function buildReviewCard(record: AutoReviewRecord, webBaseUrl?: string, progress?: FixProgress, fixHint?: string): CardJson {
  const header = reviewHeader(record)
  const link = reviewLink(record, webBaseUrl)
  const elements: Array<Record<string, unknown>> = [titleLine(record), countsLine(record)]
  if (record.status === 'reviewed') elements.push(stateLine(record, progress, fixHint))
  elements.push(buttons(record, link))
  return card({ ...header, subtitle: header.subtitle, summary: `PR #${String(record.number)} ${record.title}`, elements })
}

/** Fix-session card: same skeleton, verdict is the session outcome. */
export function buildFixCard(record: AutoReviewRecord, progress: FixProgress, webBaseUrl?: string): CardJson {
  const status = progress.status
  const ready = status === 'ready'
  const pushed = status === 'pushed'
  const tone: Tone = status === 'running' ? 'blue' : status === 'succeeded' || pushed ? 'green' : status === 'blocked' || ready ? 'orange' : 'grey'
  const title = status === 'running' ? `PR #${String(record.number)} 修复进行中`
    : ready ? `PR #${String(record.number)} 修复待确认`
      : pushed ? `PR #${String(record.number)} 修复已推送`
        : status === 'succeeded' ? `PR #${String(record.number)} 修复完成`
          : status === 'blocked' ? `PR #${String(record.number)} 修复无法完成`
            : status === 'cancelled' ? `PR #${String(record.number)} 修复已终止`
              : `PR #${String(record.number)} 修复失败`
  const icon = status === 'succeeded' || pushed ? 'done_outlined' : status === 'running' ? 'info_outlined' : 'warning_outlined'
  const headline = status === 'running' ? '**正在处理评审意见**'
    : ready ? '**改动已在工作区，等待确认**'
      : pushed ? '**已推送修复提交**'
        : status === 'succeeded' ? '**修复完成**'
      : `**${md(truncate(record.fix?.blockedReason ?? '修复会话没有产生新提交', MAX_SUMMARY))}**`
  const elements: Array<Record<string, unknown>> = [
    titleLine(record),
    conclusionBlock(tone, headline, ''),
    stateLine(record, progress, undefined),
  ]
  elements.push(buttons(record, reviewLink(record, webBaseUrl)))
  return card({ tone, title, subtitle: record.repoSlug, icon, summary: title, elements })
}
