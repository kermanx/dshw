import assert from 'node:assert/strict'
import test from 'node:test'
import { isTransientGitNetworkError, retryTransientGitNetworkOperation } from '../src/git.ts'

const sslError = new Error(
  "git fetch --no-tags origin +refs/heads/master:refs/remotes/origin/master failed: fatal: unable to access 'https://github.com/deepseek-harness/deepseek-harness.git/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443",
)

test('recognizes transient git SSL syscall errors', () => {
  assert.equal(isTransientGitNetworkError(sslError), true)
  assert.equal(isTransientGitNetworkError(new Error('fatal: remote branch master not found')), false)
})

test('retries a transient git SSL error at most three times', async () => {
  let attempts = 0
  const result = await retryTransientGitNetworkOperation(async () => {
    attempts += 1
    if (attempts <= 3) throw sslError
    return 'ok'
  }, { retryDelaysMs: [0, 0, 0] })

  assert.equal(result, 'ok')
  assert.equal(attempts, 4)

  attempts = 0
  await assert.rejects(
    retryTransientGitNetworkOperation(async () => {
      attempts += 1
      throw sslError
    }, { retryDelaysMs: [0, 0, 0] }),
    sslError,
  )
  assert.equal(attempts, 4)
})

test('does not retry a deterministic git error', async () => {
  let attempts = 0
  const error = new Error('fatal: remote branch master not found')
  await assert.rejects(
    retryTransientGitNetworkOperation(async () => {
      attempts += 1
      throw error
    }, { retryDelaysMs: [0, 0, 0] }),
    error,
  )
  assert.equal(attempts, 1)
})
