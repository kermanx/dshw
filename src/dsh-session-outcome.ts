export interface SessionOutcome {
  text: string
  reason?: string
  error?: string
}

/** Fold committed session events without reading the runtime's private log. */
export function updateSessionOutcome(
  outcome: SessionOutcome,
  event: { type: string; data: Record<string, unknown> },
): SessionOutcome {
  if (event.type === 'turn/start') return { text: '' }
  if (event.type === 'assistant/message') {
    const text = extractText(event.data.message).join('').trim()
    return text === '' ? outcome : { ...outcome, text }
  }
  if (event.type === 'turn/end') {
    const reason = asRecord(event.data.reason)
    const error = asRecord(reason?.error)
    return {
      ...outcome,
      reason: typeof reason?.kind === 'string' ? reason.kind : undefined,
      error: typeof error?.message === 'string' ? error.message : undefined,
    }
  }
  return outcome
}

function extractText(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(extractText)
  const item = asRecord(value)
  if (item === undefined) return []
  if (item.type === 'text' && typeof item.text === 'string') return [item.text]
  return extractText(item.content)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
