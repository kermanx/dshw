import type { JobRecord, PrDashboardRecord } from './types.ts'

function belongsToPr(job: JobRecord, pr: PrDashboardRecord): boolean {
  return (pr.syncId !== undefined && job.syncId === pr.syncId)
    || job.summary.startsWith(`${pr.cloneName} / PR #${pr.number}`)
}

export function findBusyJob(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  const running = jobs.filter(job => job.status === 'running' && belongsToPr(job, pr))
  return running.find(job => job.type === 'fix-ci' || job.type === 'merge-base') ?? running[0]
}

/** A dshWorker marks an action that has actually dispatched an Agent. */
export function findWorkingAgent(pr: PrDashboardRecord, jobs: readonly JobRecord[]): JobRecord | undefined {
  return jobs.find(job => job.status === 'running' && job.dshWorker !== undefined && belongsToPr(job, pr))
}
