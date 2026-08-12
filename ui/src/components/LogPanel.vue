<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { shortTime } from '../format.ts'
import type { EventRecord, LogPage } from '../types.ts'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ recent: EventRecord[] }>()
const records = ref<EventRecord[]>([])
const cursor = ref<string>()
const hasMore = ref(true)
const loading = ref(false)
const error = ref('')
const scroller = ref<HTMLElement>()

function levelTone(level: EventRecord['level']): 'bad' | 'warn' | 'neutral' {
  return level === 'error' ? 'bad' : level === 'warning' ? 'warn' : 'neutral'
}

function levelLabel(level: EventRecord['level']): string {
  return level === 'error' ? '错误' : level === 'warning' ? '警告' : '信息'
}

function mergeRecords(incoming: EventRecord[]): void {
  const byId = new Map(records.value.map(record => [record.id, record]))
  for (const record of incoming) byId.set(record.id, record)
  records.value = sortRecords([...byId.values()])
}

function sortRecords(incoming: readonly EventRecord[]): EventRecord[] {
  return [...incoming].sort((left, right) => (
    Date.parse(right.time) - Date.parse(left.time) || right.id.localeCompare(left.id)
  ))
}

function mergeLive(incoming: EventRecord[]): void {
  const newest = records.value[0]
  if (newest === undefined) return
  const newestIndex = incoming.findIndex(record => record.id === newest.id)
  const fresh = newestIndex >= 0
    ? incoming.slice(newestIndex + 1)
    : incoming.filter(record => Date.parse(record.time) > Date.parse(newest.time))
  if (fresh.length > 0) mergeRecords(fresh)
}

async function fetchPage(before?: string): Promise<LogPage> {
  const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
  const response = await fetch(`/api/logs${query}`)
  const value = await response.json() as LogPage & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

async function loadMore(): Promise<void> {
  if (loading.value || !hasMore.value) return
  loading.value = true
  error.value = ''
  try {
    const page = await fetchPage(cursor.value)
    mergeRecords(page.records)
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
    records.value = sortRecords(page.records)
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

watch(() => props.recent, mergeLive)

onMounted(() => void loadInitial())

const thClass = 'h-30px px-12px b-b b-b-solid b-b-line bg-surface text-secondary text-11px font-500 uppercase tracking-[0.05em] text-left whitespace-nowrap sticky top-0 z-1'
const tdClass = 'h-32px px-12px align-middle'
</script>

<template>
  <div v-if="records.length === 0 && !loading" class="empty-state">
    <span>{{ error ? `日志加载失败：${error}` : '暂无日志' }}</span>
    <button v-if="error" class="text-link cursor-pointer hover:underline" @click="loadInitial">重试</button>
  </div>
  <div v-else ref="scroller" class="h-full overflow-auto" @scroll="onScroll">
    <table class="w-full min-w-760px border-collapse table-fixed">
      <thead>
        <tr>
          <th class="w-110px" :class="thClass">级别</th>
          <th class="w-130px" :class="thClass">来源</th>
          <th :class="thClass">日志</th>
          <th class="w-100px" :class="thClass">时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in records" :key="record.id" class="transition-colors duration-100 hover:bg-alt">
          <td :class="tdClass">
            <span class="inline-flex items-center gap-6px text-11.5px whitespace-nowrap" :class="`st-${levelTone(record.level)}`">
              <StatusDot :tone="levelTone(record.level)" />
              {{ levelLabel(record.level) }}
            </span>
          </td>
          <td :class="tdClass"><span class="block truncate font-mono text-muted text-11px" :title="record.kind">{{ record.kind }}</span></td>
          <td :class="tdClass"><span class="block min-w-0 truncate text-secondary text-12.5px" :title="record.message">{{ record.message }}</span></td>
          <td :class="tdClass"><time class="font-mono text-faint text-11px whitespace-nowrap">{{ shortTime(record.time) }}</time></td>
        </tr>
      </tbody>
    </table>
    <div class="h-32px flex items-center justify-center text-11.5px text-muted">
      <span v-if="loading">正在加载更多日志…</span>
      <button v-else-if="error" class="text-link cursor-pointer hover:underline" @click="loadMore">加载失败，重试</button>
      <span v-else-if="!hasMore">已显示全部日志</span>
      <button v-else class="text-link cursor-pointer hover:underline" @click="loadMore">加载更多日志</button>
    </div>
  </div>
</template>
