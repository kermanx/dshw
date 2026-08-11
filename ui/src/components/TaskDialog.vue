<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { elapsedTime, jobLabel, jobTone, kindLabel, phaseLabel, shortTime, stripAnsi } from '../format.ts'
import type { DshRunRecord, DshWorkerProgress, EventRecord, JobRecord } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{
  job: JobRecord
  progress?: DshWorkerProgress
  run?: DshRunRecord
  events: EventRecord[]
  cancelling: boolean
}>()
const emit = defineEmits<{ close: [], cancel: [jobId: string] }>()
const now = ref(Date.now())
const outputElement = ref<HTMLElement>()
let timer: number | undefined

const phase = computed(() => props.job.status === 'running'
  ? props.progress !== undefined ? phaseLabel(props.progress.phase) : props.job.dshWorker !== undefined ? 'Agent 运行中' : '后台检查中'
  : jobLabel(props.job.status))
const output = computed(() => stripAnsi(props.progress?.outputTail || props.run?.finalOutput || ''))
const outputLines = computed(() => output.value.split('\n'))
const placeholder = computed(() => props.job.status === 'running' && props.job.dshWorker?.handle.progressProtocol !== 'memory-events-v1'
  ? '这个任务由升级前的 worker 启动，实时输出不可用；状态和事件仍会自动更新。'
  : props.progress?.message ?? '等待任务产生输出…')
const elapsed = computed(() => elapsedTime(props.job.startedAt ?? props.job.createdAt, props.job.finishedAt, now.value))
const running = computed(() => props.job.status === 'running')
const tone = computed(() => jobTone(props.job.status))
const timeline = computed(() => {
  const sync = props.job.dshWorker?.sync
  const start = Date.parse(props.job.startedAt ?? props.job.createdAt) - 1_000
  return [...props.events]
    .filter(event => Date.parse(event.time) >= start && (
      sync === undefined || event.message.includes(`PR #${sync.prNumber}`) || event.message.includes(sync.cloneName) || event.kind === 'service'
    ))
    .reverse()
    .slice(0, 18)
})

const tlItemClass = 'relative pb-14px pl-16px text-secondary text-12px leading-[1.45] last:pb-0'
  + ' before:content-[""] before:absolute before:left-1px before:top-5px before:w-7px before:h-7px before:rounded-full'
  + ' after:content-[""] after:absolute after:left-4px after:top-16px after:bottom-1px after:w-1px after:bg-line last:after:hidden'

function scrollToEnd(): void {
  const element = outputElement.value
  if (element !== undefined) element.scrollTop = element.scrollHeight
}

watch(output, async () => {
  const element = outputElement.value
  const stick = element === undefined || element.scrollHeight - element.scrollTop - element.clientHeight < 70
  await nextTick()
  if (stick) scrollToEnd()
})

// 打开对话框或切换到另一个任务时，直接定位到末尾
watch(() => props.job.id, async () => {
  await nextTick()
  scrollToEnd()
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now() }, 1_000)
  window.addEventListener('keydown', onKeydown)
  void nextTick(scrollToEnd)
})
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay max-[720px]:p-0" role="presentation" @click.self="emit('close')">
    <section
      class="w-[min(960px,100%)] h-[min(680px,100%)] grid grid-rows-[auto_minmax(0,1fr)_40px] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop max-[720px]:w-full max-[720px]:h-full max-[720px]:b-0 max-[720px]:rounded-0"
      role="dialog"
      aria-modal="true"
    >
      <header class="flex items-center justify-between gap-16px min-h-56px py-8px pl-16px pr-12px b-b b-b-solid b-b-line">
        <div class="min-w-0">
          <h2 class="m-0 text-13.5px font-600 leading-[1.35] truncate">{{ job.summary }}</h2>
          <div class="flex items-center gap-6px mt-3px text-muted text-11.5px">
            <span class="inline-flex items-center gap-6px whitespace-nowrap" :class="`st-${tone}`">
              <StatusDot :tone="tone" :pulse="running" />
              {{ phase }}
            </span>
            <span class="text-faint">·</span>
            <span>{{ kindLabel(job.type) }}</span>
            <span class="text-faint">·</span>
            <span class="font-mono">{{ elapsed }}</span>
            <template v-if="running">
              <span class="text-faint">·</span>
              <span>实时</span>
            </template>
          </div>
        </div>
        <button class="icon-btn flex-none" aria-label="关闭" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="min-h-0 grid grid-cols-[minmax(0,1fr)_280px] max-[720px]:grid-cols-1">
        <section class="min-h-0 overflow-hidden flex flex-col">
          <div ref="outputElement" class="flex-1 min-h-0 overflow-auto px-14px py-12px bg-code-bg font-mono text-12px leading-[1.65]">
            <template v-if="output">
              <div
                v-for="(line, index) in outputLines"
                :key="index"
                class="min-h-[1.65em] whitespace-pre-wrap break-anywhere"
                :class="line.startsWith('[stderr]') ? 'text-warn' : 'text-code-text'"
              >{{ line }}</div>
              <div v-if="running" class="mt-2px"><span class="inline-block w-7px h-13px bg-code-text opacity-70 animate-pulse" /></div>
            </template>
            <span v-else class="text-muted">{{ placeholder }}</span>
          </div>
        </section>
        <aside class="min-h-0 overflow-hidden b-l b-l-solid b-l-line max-[720px]:hidden">
          <div class="h-full overflow-auto px-14px py-10px">
            <div
              :class="tlItemClass"
              class="before:bg-accent before:shadow-[0_0_0_3px_var(--accent-soft)]"
            >
              <strong class="font-600">{{ progress?.message ?? phase }}</strong>
              <time class="block mt-3px font-mono text-faint text-11px">{{ shortTime(progress?.updatedAt ?? job.finishedAt ?? job.startedAt) }}</time>
            </div>
            <div v-for="event in timeline" :key="event.id" :class="tlItemClass" class="before:bg-line-strong">
              <div class="break-anywhere">{{ event.message }}</div>
              <time class="block mt-3px font-mono text-faint text-11px">{{ shortTime(event.time) }}</time>
            </div>
          </div>
        </aside>
      </div>

      <footer class="flex items-center justify-between gap-16px px-16px b-t b-t-solid b-t-line text-muted text-12px">
        <span>{{ running ? '输出实时传输中，完整日志已落盘保存' : '任务已结束，显示最终结果' }}</span>
        <button v-if="running" class="btn btn-danger" :disabled="job.cancelRequestedAt !== undefined || cancelling" @click="emit('cancel', job.id)">{{ job.cancelRequestedAt || cancelling ? '终止中' : '终止任务' }}</button>
      </footer>
    </section>
  </div>
</template>
