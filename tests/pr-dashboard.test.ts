import assert from 'node:assert/strict'
import test from 'node:test'
import { mergePrDashboardSyncState } from '../src/pr-dashboard.ts'

test('overlays live sync scheduling state onto cached PR dashboard records', () => {
  const record = {
    repoSlug: 'deepseek-harness/deepseek-harness',
    number: 2192,
    syncId: 'stale-sync',
    syncEnabled: false,
    pendingBaseCheckAt: '2026-08-11T00:01:00.000Z',
    agentPausedReason: 'stale reason',
  } as Parameters<typeof mergePrDashboardSyncState>[0][number]
  const sync = {
    id: 'live-sync',
    repoSlug: record.repoSlug,
    prNumber: record.number,
    enabled: true,
    pendingBaseCheckAt: '2026-08-11T00:10:00.000Z',
  } as Parameters<typeof mergePrDashboardSyncState>[1][number]

  const scheduled = mergePrDashboardSyncState([record], [sync])[0]!
  assert.equal(scheduled.syncId, 'live-sync')
  assert.equal(scheduled.syncEnabled, true)
  assert.equal(scheduled.pendingBaseCheckAt, '2026-08-11T00:10:00.000Z')
  assert.equal('agentPausedReason' in scheduled, false)

  sync.enabled = false
  sync.pendingBaseCheckAt = undefined
  sync.agentPausedReason = '等待处理'
  const cleared = mergePrDashboardSyncState([scheduled], [sync])[0]!
  assert.equal(cleared.syncEnabled, false)
  assert.equal('pendingBaseCheckAt' in cleared, false)
  assert.equal(cleared.agentPausedReason, '等待处理')
})
