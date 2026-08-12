import type {
  CiCheck,
  CloneRecord,
  DshRunRecord,
  DshWorkerProgress,
  EventRecord,
  JobRecord,
  PrDashboardStatus,
  PrDashboardRecord,
  PullRequestReview,
  ReviewRequestRecord,
  ServiceState,
} from '../../src/types.ts'

export type { CiCheck, DshRunRecord, DshWorkerProgress, EventRecord, JobRecord, PrDashboardRecord, PrDashboardStatus, PullRequestReview, ReviewRequestRecord }

export interface WorkflowSnapshot extends Omit<ServiceState, 'prDashboardCache'> {
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
  prDashboard: PrDashboardStatus
  reviewRequests: ReviewRequestRecord[]
  jobProgress: Record<string, DshWorkerProgress>
}

export type UpdateState = ServiceState['update']
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'
