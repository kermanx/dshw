<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { shortTime } from '../format.ts'
import type { EventRecord, LogPage } from '../types.ts'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ recent: EventRecord[] }>()
const records = ref<EventRecord[]>([...props.recent])
const cursor = ref<string>()
const hasMore = ref(true)
const loading = ref(false)
const error = ref('')
const scroller = ref<HTMLElement>()
const initialized = ref(false)

function levelTone(level: EventRecord['level']): 'bad' | 'warn' | 'neutral' {
  return level === 'error' ? 'bad' : level === 'warning' ? 'warn' : 'neutral'
}

function levelLabel(level: EventRecord['level']): string {
  return level === 'error' ? '错误' : level === 'warning' ? '警告' : '信息'
}

function mergeRecords(incoming: EventRecord[]): void {
  const byId = new Map(records.value.map(record => [record.id, record]))
  for (const record of incoming) byId.set(record.id, record)
  records.value = [...byId.values()].sort((left, right) => (
    Date.parse(left.time) - Date.parse(right.time) || left.id.localeCompare(right.id)
  ))
}

async function fetchPage(before?: string): Promise<LogPage> {
  const query = before === undefined ? '' : `?before=${encodeURIComponent(before)}`
  const response = await fetch(`/api/logs${query}`)
  const value = await response.json() as LogPage & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

async function loadOlder(preservePosition = true): Promise<void> {
  if (loading.value || !hasMore.value) return
  loading.value = true
  error.value = ''
  const element = scroller.value
  const previousHeight = element?.scrollHeight ?? 0
  try {
    const page = await fetchPage(cursor.value)
    mergeRecords(page.records)
    cursor.value = page.nextCursor
    hasMore.value = page.hasMore
    await nextTick()
    if (preservePosition && element !== undefined) element.scrollTop += element.scrollHeight - previousHeight
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function loadInitial(): Promise<void> {
  initialized.value = false
  loading.value = true
  error.value = ''
  try {
    const page = await fetchPage()
    records.value = [...page.records].reverse()
    cursor.value = page.nextCursor
    hasMore.value = page.hasMore
    loading.value = false
    await nextTick()
    while (hasMore.value && error.value === '' && scroller.value !== undefined && scroller.value.scrollHeight <= scroller.value.clientHeight) {
      await loadOlder(false)
    }
    await nextTick()
    if (scroller.value !== undefined) scroller.value.scrollTop = scroller.value.scrollHeight
    initialized.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
    initialized.value = true
  }
}

function onScroll(): void {
  if (initialized.value && (scroller.value?.scrollTop ?? 100) < 48) void loadOlder()
}

watch(() => props.recent, async recent => {
  const element = scroller.value
  const stickToBottom = element === undefined || element.scrollHeight - element.scrollTop - element.clientHeight < 48
  mergeRecords(recent)
  await nextTick()
  if (stickToBottom && element !== undefined) element.scrollTop = element.scrollHeight
})

onMounted(() => void loadInitial())
</script>

<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="flex-none flex items-center gap-8px h-30px px-12px b-b b-b-solid b-b-line text-11.5px text-muted">
      <span>持久化日志</span>
      <span class="text-faint">·</span>
      <span>已加载 {{ records.length }} 条</span>
      <span v-if="error" class="ml-auto truncate text-danger" :title="error">加载失败：{{ error }}</span>
    </div>
    <div ref="scroller" class="flex-1 min-h-0 overflow-auto" @scroll="onScroll">
      <div class="h-30px flex items-center justify-center text-11.5px text-muted">
        <span v-if="loading">正在加载更早日志…</span>
        <button v-else-if="error" class="text-link cursor-pointer hover:underline" @click="loadOlder()">重试加载</button>
        <span v-else-if="!hasMore">已到最早日志</span>
        <button v-else class="text-link cursor-pointer hover:underline" @click="loadOlder()">加载更早日志</button>
      </div>
      <div v-if="records.length === 0 && !loading" class="empty-state">暂无日志</div>
      <div
        v-for="record in records"
        :key="record.id"
        class="grid grid-cols-[92px_72px_116px_minmax(0,1fr)] items-center h-32px px-12px transition-colors duration-100 hover:bg-alt"
      >
        <time class="font-mono text-faint text-11px whitespace-nowrap">{{ shortTime(record.time) }}</time>
        <span class="inline-flex items-center gap-6px text-11.5px" :class="`st-${levelTone(record.level)}`">
          <StatusDot :tone="levelTone(record.level)" />
          {{ levelLabel(record.level) }}
        </span>
        <span class="truncate font-mono text-muted text-11px" :title="record.kind">{{ record.kind }}</span>
        <span class="min-w-0 truncate text-secondary text-12.5px" :title="record.message">{{ record.message }}</span>
      </div>
    </div>
  </div>
</template>
