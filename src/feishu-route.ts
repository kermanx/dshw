/**
 * Natural-language routing for Feishu topic messages.
 *
 * The user talks to the bot in the PR topic; one small model call decides what
 * the message wants (a review, a fix instruction, a status question, an answer)
 * so the topic works like a chat instead of a command list. The prompt is kept
 * tiny and the parse is defensive: any failure degrades to "start a fix session
 * with this text", which is the pre-router behaviour.
 */
import type { AutoReviewRecord } from './types.ts'

/** What a topic message should do. */
export type FeishuAction = 'review' | 'fix' | 'push' | 'answer' | 'status' | 'stop'

export interface FeishuRoute {
  action: FeishuAction
  /** Extra instruction handed to the fix session (fix only). */
  instruction?: string
  /** Text the bot sends back into the topic. */
  reply: string
}

/** Human label for the fix state. */
function fixState(record: AutoReviewRecord): string {
  const status = record.fix?.status
  if (status === undefined) return '未启动'
  if (status === 'running') return '进行中'
  if (status === 'ready') return '改动已在工作区，未推送（等待用户确认）'
  if (status === 'pushed') return '已推送'
  return status
}

/** Compact PR context; findings are truncated so the prompt stays cheap. */
export function routeContext(record: AutoReviewRecord, fixRunning: boolean): string {
  const findings = record.comments.slice(0, 8).map(comment => (
    `- [${comment.severity}] ${comment.file}${comment.line === undefined ? '' : `:${String(comment.line)}`} ${comment.message.trim().split('\n')[0]?.slice(0, 160) ?? ''}`
  ))
  return [
    `PR #${String(record.number)} · ${record.title}（${record.repoSlug}）`,
    `评审状态：${record.status}；问题：${String(record.counts.critical)} 必须修复 / ${String(record.counts.warning)} 建议修复 / ${String(record.counts.suggestion)} 建议`,
    record.summary === '' ? '' : `评审摘要：${record.summary.slice(0, 1_200)}`,
    findings.length === 0 ? '没有具体意见。' : `意见（部分）：\n${findings.join('\n')}`,
    `修复会话：${fixState(record)}`,
    fixRunning ? '现在有一个修复会话正在运行，可以直接给它下指令。' : '',
  record.fix?.status === 'ready' ? '修复改动已放在工作区（未提交、未推送），用户可以直接说“推吧”来提交并推送。' : '',
  ].filter(line => line !== '').join('\n')
}

export const ROUTE_SYSTEM_PROMPT = [
  '你在一个 PR 的飞书话题里充当助手的调度器。用户用自然语言说话，你决定要执行哪个动作，并写好给用户的简短回复。',
  '只输出 JSON，不要代码块，不要多余文字：',
  '{"action":"review|fix|push|answer|status|stop","instruction":"给修复会话的补充指令（fix 时可选）","reply":"回复用户的话（中文，1-3 句）"}',
  '动作含义：',
  '- review：重新评审当前提交（用户说重新评审/再看看/再跑一遍等）。',
  '- fix：让 dsh 会话去改代码（用户说修一下/处理掉/改成 X/只修 critical 等）。instruction 里写清楚要做什么。',
  '- push：用户确认把当前未推送的修复提交并推送上去（说"推吧/提交推送/可以推了"等）。',
  '- answer：用户在问问题（为什么算 critical/这条是什么意思/怎么改合适），用 reply 直接回答，不要启动任何会话。',
  '- status：用户在问进度/状态（修好了吗/进行到哪了）。',
  '- stop：用户要求停下/取消当前任务。',
  '拿不准是提问还是指令时：如果用户表达了希望改动代码，选 fix；如果只是询问信息，选 answer。',
].join('\n')

/** Build the two messages for the router call. */
export function routePrompt(record: AutoReviewRecord, message: string, fixRunning: boolean): { system: string, user: string } {
  return {
    system: ROUTE_SYSTEM_PROMPT,
    user: `当前上下文：\n${routeContext(record, fixRunning)}\n\n用户消息：${message}`,
  }
}

/** Parse the router's JSON, falling back to "fix with this text". */
export function parseRoute(raw: string, fallbackMessage: string): FeishuRoute {
  const fallback: FeishuRoute = { action: 'fix', instruction: fallbackMessage, reply: '' }
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text)
  if (fenced !== null) text = fenced[1]!.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return fallback
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return fallback
  }
  if (value === null || typeof value !== 'object') return fallback
  const data = value as Record<string, unknown>
  const action = data.action
  if (action !== 'review' && action !== 'fix' && action !== 'push' && action !== 'answer' && action !== 'status' && action !== 'stop') return fallback
  const reply = typeof data.reply === 'string' ? data.reply.trim().slice(0, 1_000) : ''
  const instruction = typeof data.instruction === 'string' && data.instruction.trim() !== ''
    ? data.instruction.trim().slice(0, 2_000)
    : undefined
  return {
    action,
    reply,
    ...(action === 'fix' ? { instruction: instruction ?? fallbackMessage } : instruction === undefined ? {} : { instruction }),
  }
}
