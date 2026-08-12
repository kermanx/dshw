<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { elapsedTime, jobLabel, jobTone, kindLabel, phaseLabel, shortTime, stripAnsi } from '../format.ts'
import { mergeProgressOutput, parseProgressOutput, type ProgressOutputBlock } from '../progress-output.ts'
import type { DshRunRecord, DshWorkerProgress, EventRecord, JobRecord } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{
  job: JobRecord
  progress?: DshWorkerProgress
  run?: DshRunRecord
  events: EventRecord[]
  cancelling: boolean
  pausing: boolean
  steering: boolean
}>()
const emit = defineEmits<{
  close: []
  cancel: [jobId: string]
  pause: [jobId: string]
  steer: [jobId: string, prompt: string]
  toast: [message: string, bad?: boolean]
}>()
const now = ref(Date.now())
const outputElement = ref<HTMLElement>()
const timelineElement = ref<HTMLElement>()
const promptElement = ref<HTMLTextAreaElement>()
const persistedOutput = ref('')
const outputLoading = ref(false)
const outputBefore = ref<number>()
const hasOlderOutput = ref(false)
const loadingOlderOutput = ref(false)
const prompt = ref('')
let timer: number | undefined
let lastOutputRefreshAt = 0

const phase = computed(() => props.job.status === 'running'
  ? props.progress !== undefined ? phaseLabel(props.progress.phase) : props.job.dshWorker !== undefined ? 'Agent 运行中' : '后台检查中'
  : jobLabel(props.job.status))
const output = computed(() => stripAnsi(mergeProgressOutput(
  persistedOutput.value || props.job.output || props.run?.finalOutput || '',
  props.progress?.outputTail ?? '',
)))
const outputBlocks = computed(() => parseProgressOutput(output.value).filter(block => block.kind !== 'step'))
type OutputItem = { kind: 'tool', call?: ProgressOutputBlock, result?: ProgressOutputBlock } | { kind: 'block', block: ProgressOutputBlock }
const outputItems = computed<OutputItem[]>(() => {
  const items: OutputItem[] = []
  const blocks = outputBlocks.value
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    if (block.kind === 'tool-call') {
      const next = blocks[index + 1]
      const result = next?.kind === 'tool-result' ? next : undefined
      items.push({ kind: 'tool', call: block, ...(result === undefined ? {} : { result }) })
      if (result !== undefined) index += 1
    } else if (block.kind === 'tool-result') {
      items.push({ kind: 'tool', result: block })
    } else {
      items.push({ kind: 'block', block })
    }
  }
  return items
})
const placeholder = computed(() => {
  if (props.job.status !== 'running') return '这个任务没有文本输出。'
  if (props.job.dshWorker === undefined) return '等待后台任务产生输出…'
  return props.job.dshWorker.handle.progressProtocol === undefined
    ? '这个任务由升级前的 worker 启动，实时输出不可用；状态和事件仍会自动更新。'
    : props.progress?.message ?? '等待任务产生输出…'
})
const elapsed = computed(() => elapsedTime(props.job.startedAt ?? props.job.createdAt, props.job.finishedAt, now.value))
const running = computed(() => props.job.status === 'running')
const controllable = computed(() => running.value && props.job.dshWorker?.handle.progressProtocol === 'session-control-v1')
const paused = computed(() => props.progress?.phase === 'paused')
const tone = computed(() => jobTone(props.job.status))
const workerLabel = computed(() => {
  const type = props.job.dshWorker?.handle.workerType
  if (props.job.dshWorker === undefined) return undefined
  if (type === 'codex') return 'Codex worker'
  if (type === 'claude-code') return 'Claude Code worker'
  return 'dsh worker'
})
const activityLabel = computed(() => phase.value)
const dialogTitle = computed(() => compactPrLabel(props.job.summary))
const timeline = computed(() => {
  const sync = props.job.dshWorker?.sync
  const start = Date.parse(props.job.startedAt ?? props.job.createdAt) - 1_000
  return [...props.events]
    .filter(event => Date.parse(event.time) >= start && (
      sync === undefined || event.message.includes(`PR #${sync.prNumber}`) || event.message.includes(sync.cloneName) || event.kind === 'service'
    ))
    .slice(-18)
})

const tlItemClass = 'relative pb-14px pl-16px text-secondary text-12px leading-[1.45] last:pb-0'
  + ' before:content-[""] before:absolute before:left-1px before:top-5px before:w-7px before:h-7px before:rounded-full'
  + ' after:content-[""] after:absolute after:left-4px after:top-16px after:bottom-1px after:w-1px after:bg-line last:after:hidden'

function scrollToEnd(): void {
  const element = outputElement.value
  if (element !== undefined) element.scrollTop = element.scrollHeight
}

function compactPrLabel(value: string): string {
  const sync = props.job.dshWorker?.sync
  if (sync === undefined || sync.cloneName.toLowerCase() !== `pr-${sync.prNumber}`) return value
  return value.replaceAll(`${sync.cloneName} / PR #${sync.prNumber}`, `PR #${sync.prNumber}`)
}

function scrollTimelineToEnd(): void {
  const element = timelineElement.value
  if (element !== undefined) element.scrollTop = element.scrollHeight
}

function focusPrompt(): void {
  if (controllable.value) promptElement.value?.focus({ preventScroll: true })
}

function onOutputScroll(): void {
  if ((outputElement.value?.scrollTop ?? Infinity) < 80) void loadOlderOutput()
}

watch(output, async () => {
  const element = outputElement.value
  const stick = element === undefined || element.scrollHeight - element.scrollTop - element.clientHeight < 70
  await nextTick()
  if (stick) scrollToEnd()
})

// 打开对话框或切换到另一个任务时，直接定位到末尾
watch(() => props.job.id, async () => {
  await loadPersistedOutput()
  await nextTick()
  scrollToEnd()
  scrollTimelineToEnd()
  focusPrompt()
})
watch(() => props.job.status, () => void loadPersistedOutput())
watch(() => [timeline.value.at(-1)?.id, props.progress?.updatedAt], async () => {
  await nextTick()
  scrollTimelineToEnd()
})
watch(() => props.progress?.updatedAt, () => {
  if ((props.progress?.outputTail.length ?? 0) < 47_000 || Date.now() - lastOutputRefreshAt < 10_000) return
  lastOutputRefreshAt = Date.now()
  void refreshPersistedOutput()
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

function sendSteer(): void {
  const value = prompt.value.trim()
  if (value === '' || props.steering) return
  emit('steer', props.job.id, value)
  prompt.value = ''
}

function onPromptKeydown(event: KeyboardEvent): void {
  const enter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter'
  if (!enter || !event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  const input = event.currentTarget
  if (input instanceof HTMLTextAreaElement) prompt.value = input.value
  sendSteer()
}

function outputLabel(block: ProgressOutputBlock): string {
  if (block.kind === 'agent') return 'Agent'
  if (block.kind === 'user') return 'You'
  if (block.kind === 'system') return 'system'
  if (block.kind === 'stderr') return 'stderr'
  if (block.kind === 'plain') return 'stdout'
  return 'output'
}

function hasMoreOutput(block: ProgressOutputBlock): boolean {
  return block.body.includes('\n') || block.body.length > 110
}

async function copyOutput(): Promise<void> {
  try {
    await navigator.clipboard.writeText(output.value)
    emit('toast', '输出已复制')
  } catch {
    emit('toast', '复制失败', true)
  }
}

interface OutputPageResponse {
  output?: string
  nextBefore?: number
  hasMore?: boolean
  error?: string
}

async function fetchOutputPage(jobId: string, before?: number): Promise<OutputPageResponse> {
  const cursor = before === undefined ? '' : `&before=${before}`
  const response = await fetch(`/api/jobs/output?jobId=${encodeURIComponent(jobId)}${cursor}`)
  const value = await response.json() as OutputPageResponse
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
  return value
}

async function loadPersistedOutput(): Promise<void> {
  const jobId = props.job.id
  persistedOutput.value = ''
  outputBefore.value = undefined
  hasOlderOutput.value = false
  outputLoading.value = false
  if (props.job.dshWorker === undefined) return
  outputLoading.value = true
  try {
    const value = await fetchOutputPage(jobId)
    if (props.job.id === jobId) {
      persistedOutput.value = value.output ?? ''
      outputBefore.value = value.nextBefore
      hasOlderOutput.value = value.hasMore === true
    }
  } catch {
    // The final result already carried by the Job remains a useful fallback.
  } finally {
    if (props.job.id === jobId) outputLoading.value = false
  }
}

async function loadOlderOutput(): Promise<void> {
  const element = outputElement.value
  const before = outputBefore.value
  const jobId = props.job.id
  if (!hasOlderOutput.value || loadingOlderOutput.value || before === undefined || element === undefined) return
  loadingOlderOutput.value = true
  const previousHeight = element.scrollHeight
  const previousTop = element.scrollTop
  try {
    const value = await fetchOutputPage(jobId, before)
    if (props.job.id !== jobId || outputBefore.value !== before) return
    const older = value.output ?? ''
    persistedOutput.value = older === ''
      ? persistedOutput.value
      : `${older}${older.endsWith('\n') ? '' : '\n'}${persistedOutput.value}`
    outputBefore.value = value.nextBefore
    hasOlderOutput.value = value.hasMore === true
    await nextTick()
    element.scrollTop = previousTop + element.scrollHeight - previousHeight
  } catch {
    // Keep the currently loaded pages available; another scroll can retry.
  } finally {
    loadingOlderOutput.value = false
  }
}

async function refreshPersistedOutput(): Promise<void> {
  const jobId = props.job.id
  try {
    const value = await fetchOutputPage(jobId)
    if (props.job.id === jobId) persistedOutput.value = mergeProgressOutput(persistedOutput.value, value.output ?? '')
  } catch {
    // The live tail remains available while a durable-page refresh retries later.
  }
}

onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now() }, 1_000)
  window.addEventListener('keydown', onKeydown)
  void loadPersistedOutput().then(async () => {
    await nextTick()
    scrollToEnd()
    scrollTimelineToEnd()
    focusPrompt()
  })
})
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay max-[720px]:p-0" role="presentation" @click.self="emit('close')">
    <section
      class="w-[min(1080px,100%)] h-[min(760px,100%)] grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop max-[720px]:w-full max-[720px]:h-full max-[720px]:b-0 max-[720px]:rounded-0"
      role="dialog"
      aria-modal="true"
    >
      <header class="flex items-center justify-between gap-16px min-h-56px py-8px pl-16px pr-12px b-b b-b-solid b-b-line">
        <div class="min-w-0">
          <h2 class="m-0 text-13.5px font-600 leading-[1.35] truncate">{{ dialogTitle }}</h2>
          <div class="flex items-center gap-6px mt-3px text-muted text-11.5px">
            <span class="inline-flex items-center gap-6px whitespace-nowrap" :class="`st-${tone}`">
              <StatusDot :tone="tone" :pulse="running" />
              {{ phase }}
            </span>
            <span class="text-faint">·</span>
            <span>{{ kindLabel(job.type) }}</span>
            <template v-if="workerLabel">
              <span class="text-faint">·</span>
              <span class="font-mono text-secondary">{{ workerLabel }}</span>
            </template>
            <span class="text-faint">·</span>
            <span class="font-mono">{{ elapsed }}</span>
          </div>
        </div>
        <button class="icon-btn flex-none" aria-label="关闭" @click="emit('close')"><Icon name="close" :size="16" /></button>
      </header>

      <div class="min-h-0 grid grid-cols-[minmax(0,1fr)_280px] max-[720px]:grid-cols-1">
        <section class="min-h-0 overflow-hidden flex flex-col">
          <div ref="outputElement" class="flex-1 min-h-0 overflow-auto px-16px py-14px bg-code-bg text-12px leading-[1.6]" @scroll="onOutputScroll">
            <template v-if="output">
              <div class="output-feed">
                <template v-for="(item, index) in outputItems" :key="index">
                  <details v-if="item.kind === 'tool'" class="stream-row tool-disclosure">
                    <summary class="stream-summary">
                      <span
                        class="tool-status-dot"
                        :class="item.result === undefined ? 'tool-status-running' : item.result.failed ? 'tool-status-failed' : 'tool-status-complete'"
                        :title="item.result === undefined ? '运行中' : item.result.failed ? '失败' : '完成'"
                      />
                      <strong class="tool-title">{{ item.call?.title ?? '未知' }}</strong>
                      <span v-if="item.call?.preview" class="stream-preview">{{ item.call.preview }}</span>
                    </summary>
                    <div class="tool-details">
                      <div v-if="item.call?.body" class="tool-detail-row">
                        <span class="tool-detail-label">参数</span>
                        <pre>{{ item.call.body }}</pre>
                      </div>
                      <div v-if="item.result?.body" class="tool-detail-row">
                        <span class="tool-detail-label">结果</span>
                        <pre>{{ item.result.body }}</pre>
                      </div>
                    </div>
                  </details>
                  <article v-else-if="item.block.kind === 'agent' || item.block.kind === 'user' || item.block.kind === 'stderr' || item.block.kind === 'plain'" class="primary-message" :class="`primary-${item.block.kind}`">
                    <div class="primary-label">{{ outputLabel(item.block) }}</div>
                    <pre class="primary-body">{{ item.block.body }}</pre>
                  </article>
                  <details v-else-if="item.block.kind === 'thinking'" class="stream-row thinking-disclosure">
                    <summary class="stream-summary">
                      <span class="tool-status-dot thinking-status-dot" title="思考" />
                      <span class="stream-preview">{{ item.block.preview ?? item.block.body }}</span>
                    </summary>
                    <pre class="thinking-body">{{ item.block.body }}</pre>
                  </details>
                  <details v-else class="stream-row" :class="`stream-${item.block.kind}`">
                    <summary class="stream-summary">
                      <span class="stream-kind">{{ outputLabel(item.block) }}</span>
                      <span class="stream-preview">{{ item.block.preview ?? item.block.body }}</span>
                    </summary>
                    <pre v-if="hasMoreOutput(item.block)" class="stream-body">{{ item.block.body }}</pre>
                  </details>
                </template>
              </div>
            </template>
            <span v-else class="text-muted">{{ placeholder }}</span>
          </div>
        </section>
        <aside class="min-h-0 overflow-hidden b-l b-l-solid b-l-line max-[720px]:hidden">
          <div ref="timelineElement" class="h-full overflow-auto px-14px py-10px">
            <div v-for="event in timeline" :key="event.id" :class="tlItemClass" class="before:bg-line-strong">
              <div class="break-anywhere">{{ compactPrLabel(event.message) }}</div>
              <time class="block mt-3px font-mono text-faint text-11px">{{ shortTime(event.time) }}</time>
            </div>
            <div
              :class="tlItemClass"
              class="before:bg-accent before:shadow-[0_0_0_3px_var(--accent-soft)]"
            >
              <strong class="font-600">{{ activityLabel }}</strong>
              <time class="block mt-3px font-mono text-faint text-11px">{{ shortTime(progress?.updatedAt ?? job.finishedAt ?? job.startedAt) }}</time>
            </div>
          </div>
        </aside>
      </div>

      <footer class="p-10px b-t b-t-solid b-t-line text-muted text-12px">
        <div v-if="controllable" class="control-composer">
          <textarea
            ref="promptElement"
            v-model="prompt"
            class="control-input"
            :placeholder="paused ? '输入指令并继续任务…' : '在下一个 step 前插入指令…'"
            :disabled="steering || job.cancelRequestedAt !== undefined"
            @keydown="onPromptKeydown"
          />
          <div class="control-actions">
            <button
              v-if="!paused"
              class="control-icon-button control-pause"
              :disabled="pausing || progress?.phase === 'cancelling' || job.cancelRequestedAt !== undefined"
              :title="pausing || progress?.phase === 'cancelling' ? '暂停中' : '暂停任务'"
              :aria-label="pausing || progress?.phase === 'cancelling' ? '暂停中' : '暂停任务'"
              @click="emit('pause', job.id)"
            ><Icon name="pause" :size="13" /></button>
            <button
              v-else
              class="control-icon-button control-stop"
              :disabled="job.cancelRequestedAt !== undefined || cancelling"
              :title="job.cancelRequestedAt || cancelling ? '终止中' : '终止任务'"
              :aria-label="job.cancelRequestedAt || cancelling ? '终止中' : '终止任务'"
              @click="emit('cancel', job.id)"
            ><Icon name="stop" :size="12" /></button>
            <button
              class="control-icon-button control-send"
              :disabled="prompt.trim() === '' || steering"
              :title="steering ? '发送中' : paused ? '继续任务' : '发送（⌘+Enter）'"
              :aria-label="steering ? '发送中' : paused ? '继续任务' : '发送'"
              @click="sendSteer"
            ><Icon name="send" :size="13" /></button>
          </div>
        </div>
        <div v-else class="h-28px flex items-center gap-8px">
          <span v-if="!running">{{ job.dshWorker === undefined ? '任务已结束' : outputLoading ? '正在读取完整输出…' : '任务已结束 · 显示完整输出' }}</span>
          <span v-else>这个任务由旧版 worker 启动，不支持 steer 和暂停。</span>
          <button v-if="output" class="btn btn-ghost ml-auto" @click="copyOutput">复制输出</button>
          <button v-if="running" class="btn btn-danger" :disabled="job.cancelRequestedAt !== undefined || cancelling" @click="emit('cancel', job.id)">{{ job.cancelRequestedAt || cancelling ? '终止中' : '终止任务' }}</button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.output-feed { display: flex; flex-direction: column; }
.stream-row { color: var(--text-muted); }
.stream-summary { display: flex; align-items: center; gap: 7px; min-height: 24px; padding: 1px 4px; border-radius: 3px; cursor: pointer; user-select: none; }
.tool-disclosure { padding-left: 3px; }
.tool-disclosure .stream-summary { padding-left: 0; }
.stream-summary:hover { background: var(--hover); color: var(--text-secondary); }
.stream-kind { width: 31px; flex: none; color: var(--text-faint); font-size: 10.5px; }
.stream-system .stream-kind { color: var(--text-muted); }
.stream-stderr .stream-kind, .stream-stderr .stream-preview { color: var(--warning); }
.tool-status-dot { width: 5px; height: 5px; flex: none; border-radius: 50%; }
.tool-status-complete { background: var(--success); }
.tool-status-failed { background: var(--danger); }
.tool-status-running { background: var(--accent); animation: tool-status-pulse 1.2s ease-in-out infinite; }
@keyframes tool-status-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--accent-soft); }
  50% { opacity: .45; box-shadow: 0 0 0 3px var(--accent-soft); }
}
.tool-title { flex: none; color: var(--text-secondary); font: 500 11px/1.5 var(--font-mono); }
.stream-preview { min-width: 0; overflow: hidden; color: var(--text-secondary); font: 11.5px/1.5 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.stream-agent .stream-preview, .stream-user .stream-preview, .stream-system .stream-preview { font-family: var(--font-sans); font-size: 12px; }
.tool-details { margin: 1px 5px 5px 15px; padding: 4px 0 4px 10px; border-left: 1px solid var(--border); }
.tool-detail-row { display: grid; grid-template-columns: 27px minmax(0, 1fr); gap: 8px; padding: 3px 0; }
.tool-detail-row pre { color: var(--code-text); font: 11px/1.55 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-detail-label { color: var(--text-faint); font-size: 10px; line-height: 1.7; }
.thinking-disclosure { padding-left: 3px; }
.thinking-disclosure .stream-summary { padding-left: 0; }
.thinking-status-dot { background: var(--text-faint); }
.thinking-disclosure .stream-preview { color: var(--text-muted); font-family: var(--font-sans); font-size: 11.5px; font-style: italic; }
.thinking-body { margin: 1px 5px 5px 12px; padding: 3px 0 4px 9px; border-left: 1px solid var(--border); color: var(--text-muted); font: 11.5px/1.6 var(--font-sans); white-space: pre-wrap; overflow-wrap: anywhere; }
.stream-body { margin: 1px 5px 5px 52px; padding: 3px 0 4px 9px; border-left: 1px solid var(--border); color: var(--code-text); font: 11.5px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.primary-message { margin: 9px 4px 10px 0; padding-left: 10px; border-left: 2px solid var(--accent); }
.primary-user { margin-left: 0; border-left-color: color-mix(in srgb, var(--accent) 60%, var(--border-strong)); }
.primary-stderr { border-left-color: var(--warning); }
.primary-plain { border-left-color: var(--success); }
.primary-label { margin-bottom: 3px; color: var(--accent); font-size: 11px; font-weight: 600; }
.primary-user .primary-label { color: var(--text-secondary); }
.primary-stderr .primary-label { color: var(--warning); }
.primary-plain .primary-label { color: var(--success); }
.primary-body { color: var(--code-text); font: 13px/1.7 var(--font-sans); white-space: pre-wrap; overflow-wrap: anywhere; }
.primary-stderr .primary-body, .primary-plain .primary-body { font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; }
.control-composer { height: 48px; display: flex; align-items: stretch; gap: 5px; }
.control-input { min-width: 0; height: 48px; flex: 1; resize: none; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); padding: 7px 9px; color: var(--text); font-size: 12.5px; line-height: 1.45; outline: none; transition: border-color 100ms, box-shadow 100ms; }
.control-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-soft); }
.control-input:disabled { opacity: .55; }
.control-actions { width: 30px; flex: none; display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 2px; }
.control-icon-button { min-height: 0; display: grid; place-items: center; border-radius: 3px; color: var(--text-muted); cursor: pointer; transition: background-color 100ms, color 100ms, opacity 100ms; }
.control-icon-button:disabled { opacity: .35; pointer-events: none; }
.control-send { background: var(--accent); color: white; }
.control-send:hover { background: var(--accent-hover); }
.control-pause:hover { background: var(--hover); color: var(--text); }
.control-stop { color: var(--danger); }
.control-stop:hover { background: var(--danger-soft); }
</style>
