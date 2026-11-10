import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientGhNetworkError, retryTransientGhOperation } from '../src/github.ts'

const gatewayError = new Error(
  'gh pr list --repo deepseek-harness/deepseek-harness --author @me failed: HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)',
)

test('recognizes transient GitHub GraphQL failures', () => {
  assert.equal(isTransientGhNetworkError(gatewayError), true)
  assert.equal(isTransientGhNetworkError(new Error('gh pr list failed: unexpected end of JSON input')), true)
  assert.equal(isTransientGhNetworkError(new Error('gh pr list failed: Post "https://api.github.com/graphql": EOF')), true)
  assert.equal(isTransientGhNetworkError(new Error('gh pr list failed: error connecting to api.github.com')), true)
  assert.equal(isTransientGhNetworkError(new Error('gh pr list failed: HTTP 401: Bad credentials')), false)
  assert.equal(isTransientGhNetworkError(new Error('fatal: remote branch master not found')), false)
})

test('retries a transient GitHub failure until it succeeds', async () => {
  let attempts = 0
  const result = await retryTransientGhOperation(async () => {
    attempts += 1
    if (attempts <= 2) throw gatewayError
    return 'ok'
  }, { retryDelaysMs: [0, 0] })

  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('stops retrying after the configured delays', async () => {
  let attempts = 0
  await assert.rejects(
    retryTransientGhOperation(async () => {
      attempts += 1
      throw gatewayError
    }, { retryDelaysMs: [0, 0] }),
    gatewayError,
  )
  assert.equal(attempts, 3)
})

test('does not retry a deterministic GitHub failure', async () => {
  let attempts = 0
  const error = new Error('gh pr list failed: HTTP 401: Bad credentials')
  await assert.rejects(
    retryTransientGhOperation(async () => {
      attempts += 1
      throw error
    }, { retryDelaysMs: [0] }),
    error,
  )
  assert.equal(attempts, 1)
})
