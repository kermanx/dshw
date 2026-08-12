<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import HarnessStatus from './components/HarnessStatus.vue'
import Icon from './components/Icon.vue'
import JobsTable from './components/JobsTable.vue'
import LogPanel from './components/LogPanel.vue'
import PullRequestsTable from './components/PullRequestsTable.vue'
import ReviewRequests from './components/ReviewRequests.vue'
import StatusDot from './components/StatusDot.vue'
import TaskDialog from './components/TaskDialog.vue'
import WorkerSettings from './components/WorkerSettings.vue'
import WorkerLaunchDialog from './components/WorkerLaunchDialog.vue'
import { relativeTime, shortTime } from './format.ts'
import type { JobRecord, Tone } from './types.ts'
import { useWorkflow } from './use-workflow.ts'

const { snapshot, connection, load } = useWorkflow()
const views = ['prs', 'reviews', 'jobs', 'logs', 'settings'] as const
type View = typeof views[number]
const initialHash = location.hash.slice(1)
const initialView = (initialHash === 'activity' ? 'logs' : initialHash) as View
const view = ref<View>(views.includes(initialView) ? initialView : 'prs')
const focusedLogId = ref<string>()
const activeJobId = ref<string>()
const selectedJob = ref<JobRecord>()
type WorkerAction = 'merge-base' | 'fix-ci' | 'resolve-comments'
const workerLaunch = ref<{ name: string, action: WorkerAction }>()
const pending = reactive(new Set<string>())
const currentTime = ref(Date.now())
const toast = reactive({ message: '', bad: false, visible: false })
let clock: number | undefined
let toastTimer: number | undefined

const activeJob = computed(() => snapshot.value?.jobs.find(job => job.id === activeJobId.value)
  ?? (selectedJob.value?.id === activeJobId.value ? selectedJob.value : undefined))
const activeProgress = computed(() => activeJob.value === undefined ? undefined : snapshot.value?.jobProgress[activeJob.value.id])
const activeRun = computed(() => {
  const runId = activeJob.value?.dshWorker?.handle.runId
  return runId === undefined ? undefined : snapshot.value?.dshRuns.find(run => run.id === runId)
})

const liveTone = computed<Tone>(() => snapshot.value?.service.draining === true ? 'warn' : connection.value === 'live' ? 'ok' : 'warn')
const liveLabel = computed(() => snapshot.value?.service.draining === true
  ? '正在重启'
  : connection.value === 'live' ? 'Live' : connection.value === 'reconnecting' ? '重新连接' : '连接中')
const latestPrUpdate = computed(() => Math.max(0, ...(snapshot.value?.prs ?? []).map(pr => Date.parse(pr.updatedAt) || 0)))
const prRefreshStatus = computed(() => {
  if (snapshot.value === undefined) return ''
  if (snapshot.value.prDashboard.state === 'loading') return '正在首次同步'
  if (snapshot.value.prDashboard.state === 'error') return 'PR 同步失败'
  if (latestPrUpdate.value === 0) return '等待首次同步'
  return `PR 状态更新于 ${relativeTime(new Date(latestPrUpdate.value).toISOString(), currentTime.value)}`
})
const prRefreshTitle = computed(() => [
  '刷新 Pull requests（重新发现并拉取最新状态）',
  prRefreshStatus.value,
].filter(Boolean).join('\n'))
const prCount = computed(() => snapshot.value?.prs.length ?? 0)
const runningJobs = computed(() => snapshot.value?.service.activeJobs ?? 0)
const updateFailed = computed(() => snapshot.value?.update.lastStatus === 'failed')
const updatingDshw = computed(() => pending.has('update-dshw') || snapshot.value?.service.updatingDshw === true)
const updating = computed(() => pending.has('update-harness') || (snapshot.value?.jobs.some(job => job.type === 'update-harness' && job.status === 'running') ?? false))
const reconfiguring = computed(() => pending.has('reconfigure-harness') || (snapshot.value?.jobs.some(job => job.type === 'reconfigure-harness' && job.status === 'running') ?? false))

function select(id: View): void {
  if (id === 'logs') focusedLogId.value = undefined
  view.value = id
  history.replaceState(null, '', `#${id}`)
}

function openLogs(eventId?: string): void {
  focusedLogId.value = eventId
  view.value = 'logs'
  history.replaceState(null, '', '#logs')
}

const tabs = computed(() => [
  { id: 'prs', icon: 'branch', label: 'Pull requests', count: prCount.value },
  { id: 'reviews', icon: 'review', label: 'Reviews', count: snapshot.value?.reviewRequests.length ?? 0 },
  { id: 'jobs', icon: 'list', label: 'Jobs', count: runningJobs.value },
  { id: 'logs', icon: 'history', label: 'Logs', count: 0 },
  { id: 'settings', icon: 'settings', label: 'Settings', count: 0 },
] as const)

function openJob(job: JobRecord | string): void {
  selectedJob.value = typeof job === 'string' ? undefined : job
  activeJobId.value = typeof job === 'string' ? job : job.id
}

function closeJob(): void {
  activeJobId.value = undefined
  selectedJob.value = undefined
}

function runPrAction(name: string, action: WorkerAction | 'merge-base-direct'): void {
  if (action === 'merge-base-direct') {
    void post('/api/pr-action', { name, action }, `${action}:${name}`)
    return
  }
  const defaultWorker = snapshot.value?.workers.find(worker => worker.enabled)
  if (defaultWorker === undefined) {
    select('settings')
    showToast('请先添加可用的 Worker', true)
    return
  }
  if (snapshot.value?.workerTypes.find(status => status.type === defaultWorker.type)?.available !== true) {
    chooseWorker(name, action)
    return
  }
  void post('/api/pr-action', { name, action }, `${action}:${name}`)
}

function chooseWorker(name: string, action: WorkerAction): void {
  const usable = snapshot.value?.workers.some(worker => worker.enabled && snapshot.value?.workerTypes.find(status => status.type === worker.type)?.available === true) === true
  if (!usable) {
    select('settings')
    showToast('请先添加可用的 Worker', true)
    return
  }
  workerLaunch.value = { name, action }
}

function startWithWorker(workerConfigId: string, additionalInstruction: string): void {
  const launch = workerLaunch.value
  if (launch === undefined) return
  workerLaunch.value = undefined
  void post('/api/pr-action', {
    name: launch.name,
    action: launch.action,
    workerConfigId,
    additionalInstruction: additionalInstruction.trim(),
  }, `${launch.action}:${launch.name}`)
}

async function post(path: string, body: object, key: string): Promise<void> {
  if (pending.has(key)) return
  pending.add(key)
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const value = await response.json() as { error?: string }
    if (!response.ok) throw new Error(value.error ?? '请求失败')
    showToast('操作已提交')
  } catch (error) {
    showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    pending.delete(key)
  }
}

async function runMaintenance(
  path: string,
  key: 'update-harness' | 'reconfigure-harness',
  startedMessage: string,
  completedMessage: string,
): Promise<void> {
  if (pending.has(key)) return
  pending.add(key)
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const value = await response.json() as { jobId?: string, error?: string }
    if (!response.ok) throw new Error(value.error ?? '请求失败')
    if (value.jobId === undefined) throw new Error('后台任务缺少 jobId')
    showToast(startedMessage)
    const job = await waitForJob(value.jobId)
    if (job.status !== 'succeeded') throw new Error(job.summary)
    showToast(completedMessage)
  } catch (error) {
    showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    pending.delete(key)
  }
}

async function waitForJob(jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    await load().catch(() => {})
    const job = snapshot.value?.jobs.find(candidate => candidate.id === jobId)
    if (job !== undefined && job.status !== 'queued' && job.status !== 'running') return job
    await new Promise(resolve => window.setTimeout(resolve, 500))
  }
  throw new Error('等待后台任务完成超时')
}

async function updateDshw(): Promise<void> {
  const key = 'update-dshw'
  if (pending.has(key)) return
  pending.add(key)
  const previousStartedAt = snapshot.value?.service.startedAt
  try {
    const response = await fetch('/api/dshw/update', { method: 'POST' })
    const value = await response.json() as { error?: string }
    if (!response.ok) throw new Error(value.error ?? '请求失败')
    showToast('dshw 已更新，正在重启服务')
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 500))
      try {
        const stateResponse = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
        if (!stateResponse.ok) continue
        const state = await stateResponse.json() as { service?: { startedAt?: string } }
        if (previousStartedAt === undefined || state.service?.startedAt !== previousStartedAt) {
          window.location.reload()
          return
        }
      } catch {}
    }
    showToast('dshw 已更新；服务恢复后请刷新页面')
  } catch (error) {
    showToast(`更新失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    pending.delete(key)
  }
}

function showToast(message: string, bad = false): void {
  toast.message = message
  toast.bad = bad
  toast.visible = true
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.visible = false }, 2_600)
}

onMounted(() => { clock = window.setInterval(() => { currentTime.value = Date.now() }, 1_000) })
onBeforeUnmount(() => {
  if (clock !== undefined) window.clearInterval(clock)
  if (toastTimer !== undefined) window.clearTimeout(toastTimer)
})
</script>

<template>
  <div class="h-full grid grid-rows-[var(--titlebar-h)_var(--tabbar-h)_minmax(0,1fr)_var(--statusbar-h)] bg-surface">
    <header class="row-start-1 flex items-center justify-between gap-16px px-12px bg-titlebar text-fg select-none">
      <div class="flex items-center gap-8px min-w-0">
        <span class="w-18px h-18px grid place-items-center rounded bg-accent text-white text-10px font-700 tracking-[-0.02em]">dw</span>
        <span class="text-13px font-600">dshw</span>
        <span class="text-secondary text-12px">DeepSeek Harness workflow</span>
      </div>
      <div class="flex items-center gap-8px text-secondary text-12px">
        <span class="inline-flex items-center gap-6px">
          <StatusDot :tone="liveTone" :pulse="liveTone === 'warn'" />
          <span>{{ liveLabel }}</span>
        </span>
      </div>
    </header>

    <nav v-if="snapshot" class="row-start-2 flex items-stretch bg-tabbar overflow-x-auto select-none">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="inline-flex items-center gap-6px px-12px bg-tab-inactive text-[var(--tab-fg-inactive)] text-12.5px whitespace-nowrap cursor-pointer transition-colors duration-100 hover:text-fg"
        :class="{ '!bg-surface !text-fg': view === tab.id }"
        @click="select(tab.id)"
      >
        <Icon :name="tab.icon" :size="14" />
        <span>{{ tab.label }}</span>
        <span v-if="tab.count" class="badge">{{ tab.count }}</span>
      </button>
      <button
        v-if="view === 'prs' || view === 'reviews'"
        class="icon-btn ml-auto mr-6px self-center"
        :class="{ 'opacity-45 pointer-events-none': pending.has('prs-refresh') }"
        :title="prRefreshTitle"
        @click="post('/api/prs/refresh', {}, 'prs-refresh')"
      ><Icon name="sync" :size="13" :class="{ 'animate-spin': pending.has('prs-refresh') }" /></button>
    </nav>

    <main class="row-start-3 min-h-0 overflow-hidden flex flex-col bg-surface">
      <template v-if="snapshot">
        <HarnessStatus v-if="updateFailed" :update="snapshot.update" />
        <div v-if="snapshot.service.rateLimited" class="flex items-center gap-8px px-12px min-h-32px b-b b-b-solid b-b-line bg-warn-soft text-12px">
          <Icon class="flex-none text-warn" name="alert" :size="13" />
          <span class="text-secondary">
            GitHub API 限流中，PR 数据可能不是最新
            <template v-if="snapshot.service.rateLimitResetAt"> · {{ shortTime(snapshot.service.rateLimitResetAt) }} 重置</template>
          </span>
        </div>
        <div class="flex-1 min-h-0 overflow-hidden">
          <PullRequestsTable
            v-if="view === 'prs'"
            :prs="snapshot.prs"
            :status="snapshot.prDashboard"
            :jobs="snapshot.jobs"
            :pending="pending"
            @action="runPrAction"
            @choose-worker="chooseWorker"
            @open-job="openJob"
            @open-activity="openLogs"
            @refresh="post('/api/prs/refresh', {}, 'prs-refresh')"
            @toggle-sync="(name, enabled) => post('/api/sync/toggle', { name, enabled }, `sync-toggle:${name}`)"
          />
          <ReviewRequests
            v-else-if="view === 'reviews'"
            :requests="snapshot.reviewRequests"
            :status="snapshot.reviewRequestsStatus"
            :pending="pending"
            @refresh="post('/api/prs/refresh', {}, 'prs-refresh')"
            @open-logs="openLogs"
          />
          <JobsTable
            v-else-if="view === 'jobs'"
            :jobs="snapshot.jobs"
            :syncs="snapshot.syncs"
            :pending="pending"
            @open="openJob"
            @cancel="id => post('/api/jobs/cancel', { jobId: id }, `cancel:${id}`)"
          />
          <LogPanel v-else-if="view === 'logs'" :recent="snapshot.events" :focus-id="focusedLogId" />
          <WorkerSettings
            v-else
            :workers="snapshot.workers"
            :worker-types="snapshot.workerTypes"
            :dshw-repository="snapshot.dshwRepository"
            :repository="snapshot.harnessRepository"
            :update="snapshot.update"
            :updating="updating"
            :reconfiguring="reconfiguring"
            :updating-dshw="updatingDshw"
            :dev-mode="snapshot.service.devMode"
            :worktree-count="snapshot.clones.length"
            :worktree-cleanup-count="snapshot.worktreeCleanupCount"
            @changed="load"
            @toast="showToast"
            @update-dshw="updateDshw"
            @update-harness="runMaintenance('/api/update', 'update-harness', '正在同步主仓库', '主仓库同步完成')"
            @reconfigure-harness="runMaintenance('/api/reconfigure', 'reconfigure-harness', '正在重新配置工作环境', '工作环境配置完成')"
          />
        </div>
      </template>
      <div v-else class="flex-1 flex items-center justify-center gap-8px text-muted text-13px">
        <StatusDot tone="accent" pulse />
        <span>正在连接 dshw daemon…</span>
      </div>
    </main>

    <footer class="row-start-4 flex items-center justify-between bg-statusbar text-statusbar-fg text-11px select-none">
      <div class="flex items-center min-w-0">
        <span class="inline-flex items-center gap-5px h-full px-10px whitespace-nowrap transition-colors duration-100 hover:bg-statusbar-item-hover">{{ prCount }} 个 PR</span>
        <span class="inline-flex items-center gap-5px h-full px-10px whitespace-nowrap transition-colors duration-100 hover:bg-statusbar-item-hover">{{ runningJobs }} 个任务运行中</span>
      </div>
      <div class="flex items-center min-w-0">
        <span v-if="updateFailed" class="inline-flex items-center gap-5px h-full px-10px whitespace-nowrap bg-statusbar-alert">更新失败</span>
        <span v-if="snapshot?.service.devMode" class="inline-flex items-center gap-5px h-full px-10px whitespace-nowrap transition-colors duration-100 hover:bg-statusbar-item-hover">dev</span>
        <span v-if="snapshot" class="inline-flex items-center gap-5px h-full px-10px whitespace-nowrap font-mono transition-colors duration-100 hover:bg-statusbar-item-hover">:{{ snapshot.service.port }}</span>
      </div>
    </footer>
  </div>

  <TaskDialog
    v-if="activeJob && snapshot"
    :job="activeJob"
    :progress="activeProgress"
    :run="activeRun"
    :events="snapshot.events"
    :cancelling="pending.has(`cancel:${activeJob.id}`)"
    :pausing="pending.has(`pause:${activeJob.id}`)"
    :steering="pending.has(`steer:${activeJob.id}`)"
    @close="closeJob"
    @cancel="id => post('/api/jobs/cancel', { jobId: id }, `cancel:${id}`)"
    @pause="id => post('/api/jobs/pause', { jobId: id }, `pause:${id}`)"
    @steer="(id, prompt) => post('/api/jobs/steer', { jobId: id, prompt }, `steer:${id}`)"
    @toast="showToast"
  />

  <WorkerLaunchDialog
    v-if="workerLaunch && snapshot"
    :action="workerLaunch.action"
    :workers="snapshot.workers"
    :worker-types="snapshot.workerTypes"
    @close="workerLaunch = undefined"
    @start="startWithWorker"
  />

  <div
    class="fixed right-12px bottom-[calc(var(--statusbar-h)+12px)] z-70 max-w-420px px-14px py-8px b b-solid b-line rounded-md bg-widget text-secondary text-12.5px shadow-pop opacity-0 translate-y-4px pointer-events-none transition-[opacity,transform] duration-150"
    :class="{ 'opacity-100 translate-y-0': toast.visible, 'b-l-2 !b-l-danger': toast.bad }"
  >{{ toast.message }}</div>
</template>
