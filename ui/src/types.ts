import type {
  CiCheck,
  CloneRecord,
  DshRunRecord,
  DshWorkerProgress,
  EventRecord,
  JobRecord,
  PrDashboardRecord,
  ReviewRequestRecord,
  ServiceState,
} from '../../src/types.ts'

export type { CiCheck, DshRunRecord, DshWorkerProgress, EventRecord, JobRecord, PrDashboardRecord, ReviewRequestRecord }

export interface WorkflowSnapshot extends ServiceState {
  service: {
    startedAt?: string
    draining: boolean
    activeJobs: number
    port: number
    devMode: boolean
    rateLimited: boolean
    rateLimitResetAt?: string
  }
  clones: CloneRecord[]
  prs: PrDashboardRecord[]
  reviewRequests: ReviewRequestRecord[]
  jobProgress: Record<string, DshWorkerProgress>
}

export type UpdateState = ServiceState['update']
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'
