import type {
  CiCheck,
  CloneRecord,
  DshRunRecord,
  DshwRepositoryStatus,
  DshWorkerProgress,
  EventRecord,
  HarnessRepositoryStatus,
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
  WorkerModelCatalog,
  WorkerModelOption,
  WorkerReasoningEffort,
  WorkerTypeAvailability,
  WorktreeCleanupCandidate,
  WorktreeCleanupPreview,
} from '../../src/types.ts'

export type { CiCheck, DshRunRecord, DshwRepositoryStatus, DshWorkerProgress, EventRecord, HarnessRepositoryStatus, JobPage, JobRecord, LogPage, PrDashboardRecord, PrDashboardStatus, PullRequestReview, ReviewRequestRecord, SyncRecord, WorkerConfig, WorkerConfigInput, WorkerModelCatalog, WorkerModelOption, WorkerReasoningEffort, WorkerTypeAvailability, WorktreeCleanupCandidate, WorktreeCleanupPreview }

export interface WorkflowSnapshot extends Omit<ServiceState, 'prDashboardCache'> {
  service: {
    startedAt?: string
    draining: boolean
    activeJobs: number
    port: number
    devMode: boolean
    updatingDshw: boolean
    rateLimited: boolean
    rateLimitResetAt?: string
  }
  clones: CloneRecord[]
  worktreeCleanupCount?: number
  prs: PrDashboardRecord[]
  prDashboard: PrDashboardStatus
  reviewRequests: ReviewRequestRecord[]
  reviewRequestsStatus: PrDashboardStatus
  jobProgress: Record<string, DshWorkerProgress>
  workers: WorkerConfig[]
  workerTypes: WorkerTypeAvailability[]
  harnessRepository: HarnessRepositoryStatus
  dshwRepository: DshwRepositoryStatus
}

export type UpdateState = ServiceState['update']
export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'
