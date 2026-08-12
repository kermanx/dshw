<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { jobLabel, jobTone, kindLabel, shortTime } from '../format.ts'
import type { JobPage, JobRecord, SyncRecord } from '../types.ts'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ jobs: JobRecord[], syncs: SyncRecord[], pending: ReadonlySet<string> }>()
const emit = defineEmits<{ open: [job: JobRecord], cancel: [jobId: string] }>()
const records = ref<JobRecord[]>([...props.jobs].filter(job => job.type !== 'sync-check').reverse())
const cursor = ref<string>()
const hasMore = ref(true)
const loading = ref(false)
const error = ref('')
const scroller = ref<HTMLElement>()

function mergeLive(incoming: JobRecord[]): void {
  const byId = new Map(records.value.map(job => [job.id, job]))
  for (const job of incoming) byId.set(job.id, job)
  const order = [
    ...[...incoming].filter(job => job.type !== 'sync-check').reverse().map(job => job.id),
    ...records.value.map(job => job.id),
  ]
  records.value = [...new Set(order)].map(id => byId.get(id)!).filter(Boolean)
}

async function fetchPage(before?: string): Promise<JobPage> {
  const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
  const response = await fetch(`/api/jobs${query}`)
  const value = await response.json() as JobPage & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

async function loadMore(): Promise<void> {
  if (loading.value || !hasMore.value) return
  loading.value = true
  error.value = ''
  try {
    const page = await fetchPage(cursor.value)
    const known = new Set(records.value.map(job => job.id))
    records.value.push(...page.records.filter(job => !known.has(job.id)))
    cursor.value = page.nextCursor
    hasMore.value = page.hasMore
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function loadInitial(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const page = await fetchPage()
    records.value = page.records
    cursor.value = page.nextCursor
    hasMore.value = page.hasMore
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

function onScroll(): void {
  const element = scroller.value
  if (element !== undefined && element.scrollHeight - element.scrollTop - element.clientHeight < 48) void loadMore()
}

watch(() => props.jobs, mergeLive)
onMounted(() => void loadInitial())

function jobSync(job: JobRecord): SyncRecord | undefined {
  return job.dshWorker?.sync ?? props.syncs.find(sync => sync.id === job.syncId)
}

function jobTarget(job: JobRecord): string {
  const sync = jobSync(job)
  return sync === undefined ? '全局' : `#${sync.prNumber}`
}

function jobTargetTitle(job: JobRecord): string {
  const sync = jobSync(job)
  return sync === undefined ? '不针对特定 PR' : `${sync.repoSlug}#${sync.prNumber}\n${sync.branch} → ${sync.baseRefName}`
}

const thClass = 'h-30px px-12px b-b b-b-solid b-b-line bg-surface text-secondary text-11px font-500 uppercase tracking-[0.05em] text-left whitespace-nowrap sticky top-0 z-1'
const tdClass = 'h-32px px-12px align-middle'
</script>

<template>
  <div v-if="records.length === 0 && !loading" class="empty-state">
    <span>{{ error ? `任务加载失败：${error}` : '暂无任务' }}</span>
    <button v-if="error" class="text-link cursor-pointer hover:underline" @click="loadInitial">重试</button>
  </div>
  <div v-else ref="scroller" class="h-full overflow-auto" @scroll="onScroll">
    <table class="w-full min-w-760px border-collapse table-fixed">
      <thead>
        <tr>
          <th class="w-110px" :class="thClass">状态</th>
          <th class="w-100px" :class="thClass">目标</th>
          <th :class="thClass">任务</th>
          <th class="w-100px" :class="thClass">时间</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="job in records"
          :key="job.id"
          class="cursor-pointer transition-colors duration-100 hover:bg-alt"
          tabindex="0"
          @click="emit('open', job)"
          @keydown.enter="emit('open', job)"
        >
          <td :class="tdClass">
            <span class="inline-flex items-center gap-6px text-11.5px whitespace-nowrap" :class="`st-${jobTone(job.status)}`">
              <StatusDot :tone="jobTone(job.status)" :pulse="job.status === 'running'" />
              {{ jobLabel(job.status) }}
            </span>
          </td>
          <td :class="tdClass">
            <span class="block truncate font-mono text-11.5px text-secondary" :title="jobTargetTitle(job)">{{ jobTarget(job) }}</span>
          </td>
          <td :class="tdClass">
            <div class="flex items-center gap-8px min-w-0">
              <span class="min-w-0 truncate text-fg text-12.5px" :title="job.summary">{{ kindLabel(job.type) }}</span>
              <button
                v-if="job.status === 'running'"
                class="btn btn-danger btn-sm ml-auto flex-none"
                :disabled="job.cancelRequestedAt !== undefined || pending.has(`cancel:${job.id}`)"
                @click.stop="emit('cancel', job.id)"
              >{{ job.cancelRequestedAt !== undefined ? '终止中' : '终止' }}</button>
            </div>
          </td>
          <td :class="tdClass">
            <time class="font-mono text-faint text-11px whitespace-nowrap">{{ shortTime(job.finishedAt ?? job.startedAt ?? job.createdAt) }}</time>
          </td>
        </tr>
      </tbody>
    </table>
    <div class="h-32px flex items-center justify-center text-11.5px text-muted">
      <span v-if="loading">正在加载更多任务…</span>
      <button v-else-if="error" class="text-link cursor-pointer hover:underline" @click="loadMore">加载失败，重试</button>
      <span v-else-if="!hasMore">已显示全部任务</span>
      <button v-else class="text-link cursor-pointer hover:underline" @click="loadMore">加载更多任务</button>
    </div>
  </div>
</template>
