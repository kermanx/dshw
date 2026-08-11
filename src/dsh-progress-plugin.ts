export const name = 'dshw-progress-reporter'

const FRAME_PREFIX = '\u001edshw-progress '

interface SessionEventLike {
  type: string
  data: Record<string, unknown>
}

interface ProgressContext {
  on(name: 'session/event', listener: (session: unknown, event: SessionEventLike) => void): void
}

export function formatProgressEvent(event: SessionEventLike): string | undefined {
  const data = event.data
  switch (event.type) {
    case 'turn/start':
      return `开始任务（turn ${String(data.turn ?? '?')}）`
    case 'step/start':
      return `步骤 ${String(data.step ?? '?')} 开始`
    case 'assistant/message': {
      const text = messageText(data.message)
      return text === '' ? undefined : `Agent：${clip(text, 3_000)}`
    }
    case 'tool/call':
      return `调用工具 ${String(data.name ?? 'unknown')}：${clip(prettyArguments(data.arguments), 1_200)}`
    case 'tool/result': {
      const error = asRecord(data.error)
      const text = messageText(data.message)
      const status = error === undefined ? '完成' : `失败（${String(error.code ?? error.name ?? 'error')}）`
      return `工具结果 ${status}${text === '' ? '' : `：${clip(text, 2_000)}`}`
    }
    case 'step/end':
      return `步骤 ${String(data.step ?? '?')} 完成`
    case 'turn/end': {
      const reason = asRecord(data.reason)
      return `任务结束：${String(reason?.kind ?? 'unknown')}`
    }
    default:
      return undefined
  }
}

export function apply(ctx: ProgressContext): void {
  ctx.on('session/event', (_session, event) => {
    const text = formatProgressEvent(event)
    if (text === undefined) return
    process.stderr.write(`${FRAME_PREFIX}${JSON.stringify({ text })}\n`)
  })
}

function messageText(value: unknown): string {
  const message = asRecord(value)
  return extractText(message?.content).join('\n').trim()
}

function extractText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(extractText)
  const item = asRecord(value)
  if (item === undefined) return []
  if (item.type === 'text' && typeof item.text === 'string') return [item.text]
  return extractText(item.content)
}

function prettyArguments(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '(无参数)'
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function clip(value: string, length: number): string {
  const normalized = value.replace(/\s+\n/g, '\n').trim()
  return normalized.length <= length ? normalized : `${normalized.slice(0, length)}…`
}
