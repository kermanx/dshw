import assert from 'node:assert/strict'
import test from 'node:test'
import { updateSessionOutcome } from '../src/dsh-session-outcome.ts'

test('collects the final assistant answer and completion from committed events', () => {
  const events = [
    { type: 'turn/start', data: {} },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working…' }] } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'tool output' }] } } },
    { type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'DSHW_RESULT: ' },
      { type: 'text', text: 'completed' },
    ] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const outcome = events.reduce(updateSessionOutcome, { text: '' })
  assert.equal(outcome.text, 'DSHW_RESULT: completed')
  assert.equal(outcome.reason, 'completed')
  assert.equal(outcome.error, undefined)
})

test('a resumed turn cannot reuse a previous answer or successful result', () => {
  const started = updateSessionOutcome({ text: 'previous answer', reason: 'completed' }, { type: 'turn/start', data: {} })
  const failed = updateSessionOutcome(started, {
    type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'provider unavailable' } } },
  })
  assert.deepEqual(failed, { text: '', reason: 'error', error: 'provider unavailable' })
  assert.deepEqual(updateSessionOutcome(failed, { type: 'turn/start', data: {} }), { text: '' })
})

test('reasoning-only messages leave the latest visible answer intact', () => {
  assert.deepEqual(updateSessionOutcome({ text: 'answer' }, {
    type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'thinking' }] } },
  }), { text: 'answer' })
})
