import type { Tone } from './types.ts'

export function stripAnsi(value: unknown): string {
  return String(value ?? '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
}

export function shortTime(value?: string): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export function relativeTime(value?: string, now = Date.now()): string {
  if (value === undefined) return '—'
  const time = Date.parse(value)
  if (Number.isNaN(time)) return '—'
  const seconds = Math.max(0, Math.floor((now - time) / 1000))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  return `${Math.floor(seconds / 3600)} 小时前`
}

export function elapsedTime(startValue?: string, endValue?: string, current = Date.now()): string {
  const start = startValue === undefined ? current : Date.parse(startValue)
  const end = endValue === undefined ? current : Date.parse(endValue)
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

export const ciLabel = (value: string): string => ({ passed: '通过', failed: '失败', pending: '运行中', none: '无检查' })[value] ?? value
export const ciTone = (value: string): Tone => value === 'passed' ? 'ok' : value === 'failed' ? 'bad' : value === 'pending' ? 'warn' : 'neutral'
export const reviewLabel = (value: string): string => ({ APPROVED: '已批准', CHANGES_REQUESTED: '需修改', REVIEW_REQUIRED: '待 review' })[value] ?? '无要求'
export const reviewTone = (value: string): Tone => value === 'APPROVED' ? 'ok' : value === 'CHANGES_REQUESTED' ? 'bad' : 'neutral'
export const mergeLabel = (value: string): string => ({ MERGEABLE: '可合并', CONFLICTING: '冲突', UNKNOWN: '计算中' })[value] ?? value
export const mergeTone = (value: string): Tone => value === 'MERGEABLE' ? 'ok' : value === 'CONFLICTING' ? 'bad' : 'neutral'
export const jobLabel = (value: string): string => ({ running: '运行中', succeeded: '已完成', blocked: '无法完成', failed: '失败', cancelled: '已终止', queued: '等待中' })[value] ?? value
export const jobTone = (value: string): Tone => value === 'succeeded' ? 'ok' : value === 'failed' || value === 'blocked' ? 'bad' : value === 'running' ? 'warn' : 'neutral'
export const kindLabel = (value: string): string => ({ 'merge-base': '合并 base', 'fix-ci': '修 CI', 'update-harness': '更新 Harness', 'sync-check': '状态检查' })[value] ?? value
export const phaseLabel = (value: string): string => ({ starting: '正在启动', running: 'Agent 运行中', finishing: '正在收尾' })[value] ?? '等待输出'
export const cloneNameOf = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
