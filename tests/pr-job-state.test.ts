import assert from 'node:assert/strict'
import test from 'node:test'
import { findBusyJob, findWorkingAgent } from '../plugin/src/data.ts'
import type { JobRecord, PrDashboardRecord } from '../src/types.ts'

const pr = {
  cloneName: 'pr-42',
  repoSlug: 'deepseek-ai/deepseek-harness',
  number: 42,
  syncId: 'sync-42',
} as PrDashboardRecord

function job(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: 'job-1',
    type: 'fix-ci',
    status: 'running',
    syncId: 'sync-42',
    createdAt: '2026-08-12T00:00:00.000Z',
    summary: 'pr-42 / PR #42: 修复 CI',
    ...overrides,
  }
}

test('finds an Agent currently working on a PR', () => {
  const working = job({ dshWorker: {} as JobRecord['dshWorker'] })
  assert.equal(findWorkingAgent(pr, [working]), working)
})

test('does not treat built-in PR work as a working Agent', () => {
  const directMerge = job({ type: 'merge-base', dshWorker: undefined })
  assert.equal(findBusyJob(pr, [directMerge]), directMerge)
  assert.equal(findWorkingAgent(pr, [directMerge]), undefined)
})

test('does not associate unrelated jobs when a PR has no sync id', () => {
  const untrackedPr = { ...pr, cloneName: 'pr-99', number: 99, syncId: undefined }
  const unrelated = job({ syncId: undefined })
  assert.equal(findBusyJob(untrackedPr, [unrelated]), undefined)
  assert.equal(findWorkingAgent(untrackedPr, [unrelated]), undefined)
})
