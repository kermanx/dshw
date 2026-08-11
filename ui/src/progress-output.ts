export type ProgressOutputKind = 'agent' | 'tool-call' | 'tool-result' | 'step' | 'stderr' | 'plain'

export interface ProgressOutputBlock {
  kind: ProgressOutputKind
  title?: string
  body: string
  preview?: string
  failed?: boolean
}

/** Parse the bounded plain-text progress tail without bringing a Markdown renderer into the live path. */
export function parseProgressOutput(output: string): ProgressOutputBlock[] {
  const blocks: ProgressOutputBlock[] = []
  let current: ProgressOutputBlock | undefined

  const flush = (): void => {
    if (current === undefined) return
    current.body = current.body.replace(/\n+$/u, '')
    current.preview = previewOf(current.body)
    blocks.push(current)
    current = undefined
  }

  for (const line of output.split('\n')) {
    const next = blockStart(line)
    if (next !== undefined) {
      flush()
      current = next
      continue
    }
    if (current === undefined) current = { kind: 'plain', body: line }
    else current.body += `${current.body === '' ? '' : '\n'}${line}`
  }
  flush()
  return blocks
}

function blockStart(line: string): ProgressOutputBlock | undefined {
  if (line.startsWith('Agent：')) return { kind: 'agent', title: 'Agent', body: line.slice('Agent：'.length) }

  const toolCall = /^调用工具 (.+?)：(.*)$/u.exec(line)
  if (toolCall !== null) return { kind: 'tool-call', title: toolCall[1] ?? 'unknown', body: toolCall[2] ?? '' }

  const toolResult = /^工具结果 (完成|失败(?:（.*?）)?)(?:：(.*))?$/u.exec(line)
  if (toolResult !== null) {
    const status = toolResult[1] ?? '完成'
    return {
      kind: 'tool-result',
      title: status,
      body: toolResult[2] ?? '',
      failed: status.startsWith('失败'),
    }
  }

  if (/^(?:开始任务（|步骤 .+ (?:开始|完成)$|任务结束：)/u.test(line)) {
    return { kind: 'step', body: line }
  }
  if (line.startsWith('[stderr]')) return { kind: 'stderr', body: line.slice('[stderr]'.length).trimStart() }
  return undefined
}

function previewOf(body: string): string | undefined {
  const line = body.split('\n')
    .map(candidate => candidate.trim())
    .find(candidate => candidate !== '' && !['{', '}', '[', ']', '},', '],'].includes(candidate))
  if (line === undefined || line === '') return undefined
  return line.length <= 110 ? line : `${line.slice(0, 110)}…`
}
