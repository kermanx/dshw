/**
 * Read-only HTML page for one reviewed PR.
 *
 * Feishu messages link here so a review can be read in any browser (phone
 * included) without opening the whole kanban. The daemon serves it at
 * `/review/<repo>/<number>`; through the plugin's `/api/dshw` proxy the same
 * page is reachable at the dsh web origin the user already has open.
 *
 * Deliberately dependency-free: no scripts, no external assets, and every
 * dynamic value is escaped. The page is a snapshot, not a live app.
 */
import type { AutoReviewComment, AutoReviewRecord, ReviewDiffFile, ReviewDiffPayload } from './types.ts'
import { formatCost } from './review/pricing.ts'
import type { FixDiff } from './auto-review-fix.ts'

/** Diff detail included in the page, bounded so one huge PR cannot stall it. */
export interface ReviewPageDiff {
  fromOid: string
  toOid: string
  additions: number
  deletions: number
  files: ReviewDiffFile[]
  payloads: ReviewDiffPayload[]
}

const MAX_COMMENT_CHARS = 4_000
const MAX_ROWS_PER_FILE = 400

/** Escape text for HTML text and attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function severityLabel(severity: AutoReviewComment['severity']): string {
  return severity === 'critical' ? '必须修复' : severity === 'warning' ? '建议修复' : '建议'
}

function commentAnchor(comment: AutoReviewComment): string {
  return `${comment.file}:${String(comment.line ?? comment.lineStart ?? 0)}`
}

function renderRows(payload: ReviewDiffPayload): string {
  const rows = payload.rows.slice(0, MAX_ROWS_PER_FILE)
  const body = rows.map(row => {
    const kind = row.kind === 'hunk' ? 'hunk' : row.kind === 'added' ? 'add' : row.kind === 'removed' ? 'del' : 'ctx'
    const oldLine = row.oldLine === undefined ? '' : String(row.oldLine)
    const newLine = row.newLine === undefined ? '' : String(row.newLine)
    const text = row.kind === 'hunk' ? row.text : row.text === '' ? ' ' : row.text
    return `<tr class="${kind}"><td class="ln">${escapeHtml(oldLine)}</td><td class="ln">${escapeHtml(newLine)}</td><td class="code">${escapeHtml(text)}</td></tr>`
  }).join('\n')
  const truncated = payload.rows.length > MAX_ROWS_PER_FILE
    ? `<p class="note">仅显示前 ${String(MAX_ROWS_PER_FILE)} 行（共 ${String(payload.rows.length)} 行），完整 diff 请打开看板。</p>`
    : ''
  return `<table class="diff">${body}</table>${truncated}`
}

function renderFile(file: ReviewDiffFile, payload: ReviewDiffPayload | undefined): string {
  const status = file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : file.status === 'copied' ? 'C' : 'M'
  const rename = file.oldPath === undefined ? '' : `<span class="renamed">← ${escapeHtml(file.oldPath)}</span>`
  const body = payload === undefined
    ? '<p class="note">没有这个文件的 diff。</p>'
    : payload.kind === 'unavailable'
      ? `<p class="note">${escapeHtml(payload.reason)}</p>`
      : renderRows(payload)
  return `<section class="file" id="f-${escapeHtml(file.path)}">
  <h3><span class="st">${status}</span>${escapeHtml(file.path)}${rename}</h3>
  ${body}
</section>`
}

/** Where the page's action form posts, and how the last action went. */
export interface ReviewPageOptions {
  /** Browser-visible path of this page (includes the plugin proxy prefix). */
  actionPath?: string
  flash?: { ok: boolean, message: string }
  /** Live working-tree diff of the un-pushed fix. */
  fixDiff?: FixDiff
}

/** Render the page for one review. */
export function renderReviewPage(record: AutoReviewRecord, diff: ReviewPageDiff | undefined, options: ReviewPageOptions = {}): string {
  const counts = record.counts
  const total = counts.critical + counts.warning + counts.suggestion
  const comments = record.comments.map(comment => {
    const line = comment.line ?? comment.lineStart
    const where = line === undefined ? comment.file : `${comment.file}:${String(line)}`
    const message = comment.message.length > MAX_COMMENT_CHARS ? `${comment.message.slice(0, MAX_COMMENT_CHARS)}…` : comment.message
    return `<li class="c ${comment.severity}" id="c-${escapeHtml(commentAnchor(comment))}">
      <div class="chead"><span class="sev">${severityLabel(comment.severity)}</span><code>${escapeHtml(where)}</code>${comment.locationValid ? '' : '<span class="note">未定位到 diff</span>'}</div>
      <div class="cmsg">${escapeHtml(message)}</div>
    </li>`
  }).join('\n')
  const diffFiles = diff === undefined
    ? '<p class="note">还没有可展示的改动（评审之后没有新提交时会这样）。</p>'
    : diff.files.length === 0
      ? `<p class="note">${diff.fromOid === diff.toOid ? '评审后还没有新提交。' : '评审后的提交没有改动文件内容。'}</p>`
      : diff.files.map(file => renderFile(file, diff.payloads.find(payload => payload.file.index === file.index))).join('\n')
  const fix = record.fix === undefined ? '' : `<p class="meta">修复会话：${escapeHtml(record.fix.status)}${record.fix.producedHeadOid === undefined ? '' : ` · ${escapeHtml(record.fix.headOid.slice(0, 7))} → ${escapeHtml(record.fix.producedHeadOid.slice(0, 7))}`}</p>`
  const status = record.status === 'reviewed' ? '评审完成' : record.status === 'failed' ? '评审失败' : record.status === 'running' ? '评审中' : record.status === 'pending' ? '等待评审' : '尚未评审'
  const fixSection = record.fix === undefined ? '' : `<section class="fixbox" id="fix">
    <h3>修复会话</h3>
    <p class="meta">状态：<strong>${escapeHtml(record.fix.status === 'succeeded' ? '已完成' : record.fix.status === 'blocked' ? '无法完成' : record.fix.status === 'running' ? '进行中' : record.fix.status === 'cancelled' ? '已终止' : '失败')}</strong>${record.fix.producedHeadOid === undefined || record.fix.producedHeadOid === record.fix.headOid ? '' : ` · 提交 ${escapeHtml(record.fix.headOid.slice(0, 7))} → ${escapeHtml(record.fix.producedHeadOid.slice(0, 7))}`}</p>
    ${record.fix.blockedReason === undefined || record.fix.blockedReason === '' ? '' : `<p class="meta">${escapeHtml(record.fix.blockedReason.slice(-400))}</p>`}
  </section>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`#${String(record.number)} ${record.title}`)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 13px/1.6 -apple-system, "PingFang SC", "Segoe UI", sans-serif; color: #333; background: #fafafa; }
  main { max-width: 1100px; margin: 0 auto; }
  header { border-bottom: 1px solid #e7e7e7; padding-bottom: 12px; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  h1 a { color: inherit; text-decoration: none; }
  h1 a:hover { text-decoration: underline; }
  h2 { font-size: 14px; margin: 24px 0 10px; }
  h3 { font-size: 12.5px; margin: 0 0 6px; font-family: ui-monospace, Menlo, monospace; display: flex; align-items: center; gap: 6px; }
  .meta { color: #616161; font-size: 12px; margin: 2px 0; }
  .cost { color: #717171; }
  .chip { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; padding: 0 6px; height: 18px; border-radius: 3px; font-size: 11.5px; background: #eee; }
  .chip.bad { background: rgba(161,38,13,.1); color: #a1260d; }
  .chip.warn { background: rgba(191,136,3,.12); color: #8a6200; }
  .chip.ok { background: rgba(56,138,52,.12); color: #2f6f2b; }
  .summary { margin: 12px 0; padding: 12px; background: #fff; border: 1px solid #e7e7e7; border-radius: 8px; white-space: pre-wrap; }
  section.fixbox { margin: 12px 0; padding: 10px 12px; background: #fff; border: 1px solid #e7e7e7; border-left: 3px solid #007acc; border-radius: 8px; }
  pre.patch { max-height: 60vh; overflow: auto; margin: 8px 0 0; padding: 10px; background: #fff; border: 1px solid #e7e7e7; border-radius: 6px; font-size: 12px; line-height: 1.5; }
  section.fixbox h3 { font-family: inherit; font-size: 12px; margin: 0 0 4px; color: #616161; font-weight: 600; }
  ul.comments { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  li.c { padding: 10px 12px; background: #fff; border: 1px solid #e7e7e7; border-left-width: 3px; border-radius: 6px; }
  li.c.critical { border-left-color: #a1260d; }
  li.c.warning { border-left-color: #bf8803; }
  li.c.suggestion { border-left-color: #9a9a9a; }
  .chead { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #616161; }
  .sev { font-weight: 600; }
  li.c.critical .sev { color: #a1260d; }
  li.c.warning .sev { color: #8a6200; }
  .cmsg { margin-top: 4px; white-space: pre-wrap; }
  section.file { background: #fff; border: 1px solid #e7e7e7; border-radius: 8px; margin: 12px 0; overflow: hidden; }
  section.file h3 { margin: 0; padding: 8px 10px; background: #f6f6f6; border-bottom: 1px solid #e7e7e7; }
  .st { display: inline-block; width: 14px; text-align: center; font-weight: 700; color: #bf8803; }
  .renamed { color: #9a9a9a; font-weight: 400; }
  table.diff { width: 100%; border-collapse: collapse; font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; }
  table.diff td { padding: 0 6px; vertical-align: top; }
  table.diff td.ln { width: 42px; text-align: right; color: #9a9a9a; background: #fafafa; user-select: none; }
  table.diff td.code { white-space: pre-wrap; overflow-wrap: anywhere; }
  tr.add td.code { background: rgba(56,138,52,.09); }
  tr.del td.code { background: rgba(161,38,13,.08); }
  tr.hunk td.code { background: #f3f3f3; color: #616161; }
  .note { color: #717171; font-size: 12px; margin: 6px 10px; }
  footer { margin-top: 28px; color: #9a9a9a; font-size: 11.5px; }
  form.actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0 4px; padding: 12px; background: #fff; border: 1px solid #e7e7e7; border-radius: 8px; }
  form.actions button.primary { height: 30px; padding: 0 14px; border: none; border-radius: 6px; background: #007acc; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .flash { margin: 10px 0 0; padding: 8px 12px; border-radius: 6px; font-size: 12.5px; }
  .flash.ok { background: rgba(56,138,52,.12); color: #2f6f2b; }
  .flash.bad { background: rgba(191,136,3,.14); color: #7a5600; }
</style>
</head>
<body>
<main>
  <header>
    <h1><a href="${escapeHtml(record.url)}">#${String(record.number)} ${escapeHtml(record.title)}</a></h1>
    <p class="meta">${escapeHtml(record.repoSlug)} · <code>${escapeHtml(record.baseRefName)} ← ${escapeHtml(record.branch)}</code></p>
    ${record.usage === undefined ? '' : `<p class="meta"><span class="cost">${escapeHtml(formatCost(record.usage))}</span></p>`}
    <p class="meta">
      <span class="chip ${record.status === 'failed' ? 'bad' : record.status === 'reviewed' ? 'ok' : ''}">${status}</span>
      <span class="chip ${counts.critical > 0 ? 'bad' : counts.warning > 0 ? 'warn' : ''}">${String(total)} 条意见 · ${String(counts.critical)} 必须 · ${String(counts.warning)} 建议 · ${String(counts.suggestion)} 其他</span>
      ${record.model === undefined ? '' : `<span class="chip">${escapeHtml(record.model)}</span>`}
    </p>
    ${fix}
  </header>
  ${fixSection}
  ${options.fixDiff === undefined ? '' : `<section class="fixbox" id="fixdiff">
    <h3>修复改动（未推送）</h3>
    <p class="meta">${escapeHtml(options.fixDiff.stat === '' ? '工作区有改动' : options.fixDiff.stat)}</p>
    <pre class="patch">${escapeHtml(options.fixDiff.patch)}</pre>
  </section>`}
  ${record.summary.trim() === '' ? '' : `<div class="summary">${escapeHtml(record.summary)}</div>`}
  ${record.error === undefined ? '' : `<div class="summary" style="border-color:#e0b4ac;background:#fdf3f1"><strong>评审失败：</strong>${escapeHtml(record.error)}</div>`}
  ${options.actionPath === undefined ? '' : `<form class="actions" method="post" action="${escapeHtml(options.actionPath)}/fix">
    <button type="submit" class="primary">开始修复</button>
    <span class="note">启动一个 dsh 会话逐条处理这些意见；进展会更新在飞书卡片上。</span>
  </form>`}
  ${options.flash === undefined ? '' : `<p class="flash ${options.flash.ok ? 'ok' : 'bad'}">${escapeHtml(options.flash.message)}</p>`}
  <h2>评审意见</h2>
  ${record.comments.length === 0 ? '<p class="note">这次评审没有发现问题。</p>' : `<ul class="comments">${comments}</ul>`}
  <h2>评审后的改动${diff === undefined ? '' : ` （${escapeHtml(diff.fromOid.slice(0, 7))} → ${escapeHtml(diff.toOid.slice(0, 7))}，+${String(diff.additions)} −${String(diff.deletions)}）`}</h2>
  ${diffFiles}
  <footer>dshw · PR Auto Reviewer · 这是一次评审的快照，交互与对话请打开看板。</footer>
</main>
</body>
</html>`
}

/** Render the not-found page with the same look. */
export function renderReviewPageMissing(message: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>找不到评审</title>
<style>body{margin:0;padding:40px;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;color:#333;background:#fafafa}main{max-width:680px;margin:0 auto}h1{font-size:18px}p{color:#616161}</style>
</head><body><main><h1>找不到这条评审</h1><p>${escapeHtml(message)}</p><p>打开 dshw 看板 → Auto review 可以看到全部记录。</p></main></body></html>`
}
