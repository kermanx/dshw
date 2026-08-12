import type {
  CiCheck,
  CloneRecord,
  DshRunRecord,
  DshWorkerProgress,
  EventRecord,
  JobRecord,
  JobPage,
  LogPage,
  PrDashboardStatus,
  PrDashboardRecord,
  PullRequestReview,
  ReviewRequestRecord,
  ServiceState,
  SyncRecord,
  WorkerConfig,
  WorkerConfigInput,
} from '../../src/types.ts'

export type { CiCheck, DshRunRecord, DshWorkerProgress, EventRecord, JobPage, JobRecord, LogPage, PrDashboardRecord, PrDashboardStatus, PullRequestReview, ReviewRequestRecord, SyncRecord, WorkerConfig, WorkerConfigInput }

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
  reviewRequestsStatus: PrDashboardStatus
  jobProgress: Record<string, DshWorkerProgress>
  workers: WorkerConfig[]
}

export type UpdateState = ServiceState['update']
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'
