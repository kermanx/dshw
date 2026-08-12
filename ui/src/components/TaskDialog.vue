<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { elapsedTime, jobLabel, jobTone, kindLabel, phaseLabel, shortTime, stripAnsi } from '../format.ts'
import { parseProgressOutput, type ProgressOutputBlock } from '../progress-output.ts'
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
const persistedOutput = ref('')
const outputLoading = ref(false)
const prompt = ref('')
let timer: number | undefined

const phase = computed(() => props.job.status === 'running'
  ? props.progress !== undefined ? phaseLabel(props.progress.phase) : props.job.dshWorker !== undefined ? 'Agent 运行中' : '后台检查中'
  : jobLabel(props.job.status))
const output = computed(() => stripAnsi(props.progress?.outputTail || persistedOutput.value || props.job.output || props.run?.finalOutput || ''))
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
const activityLabel = computed(() => props.progress?.message.startsWith('步骤 ') === true
  ? phase.value
  : props.progress?.message ?? phase.value)
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
  void loadPersistedOutput()
  await nextTick()
  scrollToEnd()
})
watch(() => props.job.status, () => void loadPersistedOutput())

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

function sendSteer(): void {
  const value = prompt.value.trim()
  if (value === '' || props.steering) return
  emit('steer', props.job.id, value)
  prompt.value = ''
}

function outputLabel(block: ProgressOutputBlock): string {
  if (block.kind === 'agent') return 'Agent'
  if (block.kind === 'user') return '你'
  if (block.kind === 'system') return '系统'
  if (block.kind === 'stderr') return '警告'
  return '输出'
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

async function loadPersistedOutput(): Promise<void> {
  const jobId = props.job.id
  persistedOutput.value = ''
  outputLoading.value = false
  if (props.job.status === 'running' || props.job.dshWorker === undefined) return
  outputLoading.value = true
  try {
    const response = await fetch(`/api/jobs/output?jobId=${encodeURIComponent(jobId)}`)
    const value = await response.json() as { output?: string, error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    if (props.job.id === jobId) persistedOutput.value = value.output ?? ''
  } catch {
    // The final result already carried by the Job remains a useful fallback.
  } finally {
    if (props.job.id === jobId) outputLoading.value = false
  }
}

onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now() }, 1_000)
  window.addEventListener('keydown', onKeydown)
  void nextTick(scrollToEnd)
  void loadPersistedOutput()
})
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay max-[720px]:p-0" role="presentation" @click.self="emit('close')">
    <section
      class="w-[min(960px,100%)] h-[min(680px,100%)] grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop max-[720px]:w-full max-[720px]:h-full max-[720px]:b-0 max-[720px]:rounded-0"
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
          <div ref="outputElement" class="flex-1 min-h-0 overflow-auto px-16px py-14px bg-code-bg text-12px leading-[1.6]">
            <template v-if="output">
              <div class="output-feed">
                <template v-for="(item, index) in outputItems" :key="index">
                  <details v-if="item.kind === 'tool'" class="stream-row tool-disclosure">
                    <summary class="stream-summary">
                      <span class="stream-chevron">▸</span>
                      <span class="stream-kind">工具</span>
                      <strong class="tool-title">{{ item.call?.title ?? '未知' }}</strong>
                      <span v-if="item.call?.preview" class="stream-preview">{{ item.call.preview }}</span>
                      <span v-if="item.result" class="tool-result" :class="item.result.failed ? 'tool-result-failed' : ''">
                        {{ item.result.title }}
                      </span>
                      <span v-else class="tool-result tool-result-running">运行中</span>
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
                  <details v-else class="stream-row" :class="`stream-${item.block.kind}`">
                    <summary class="stream-summary">
                      <span class="stream-chevron">▸</span>
                      <span class="stream-kind">{{ outputLabel(item.block) }}</span>
                      <span class="stream-preview">{{ item.block.preview ?? item.block.body }}</span>
                    </summary>
                    <pre v-if="hasMoreOutput(item.block)" class="stream-body">{{ item.block.body }}</pre>
                  </details>
                </template>
                <div v-if="running" class="stream-cursor"><span /></div>
              </div>
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
              <strong class="font-600">{{ activityLabel }}</strong>
              <time class="block mt-3px font-mono text-faint text-11px">{{ shortTime(progress?.updatedAt ?? job.finishedAt ?? job.startedAt) }}</time>
            </div>
            <div v-for="event in timeline" :key="event.id" :class="tlItemClass" class="before:bg-line-strong">
              <div class="break-anywhere">{{ event.message }}</div>
              <time class="block mt-3px font-mono text-faint text-11px">{{ shortTime(event.time) }}</time>
            </div>
          </div>
        </aside>
      </div>

      <footer class="p-10px b-t b-t-solid b-t-line text-muted text-12px">
        <div v-if="controllable" class="control-composer">
          <textarea
            v-model="prompt"
            class="control-input"
            :placeholder="paused ? '输入指令并继续任务…' : '在下一个 step 前插入指令…'"
            :disabled="steering || job.cancelRequestedAt !== undefined"
            @keydown.enter.exact.prevent="sendSteer"
          />
          <div class="control-toolbar">
            <div class="task-actions">
              <button
                v-if="!paused"
                class="task-action"
                :disabled="pausing || progress?.phase === 'cancelling' || job.cancelRequestedAt !== undefined"
                @click="emit('pause', job.id)"
              >
                <Icon name="pause" :size="12" />
                {{ pausing || progress?.phase === 'cancelling' ? '暂停中' : '暂停任务' }}
              </button>
              <button class="task-action task-action-danger" :disabled="job.cancelRequestedAt !== undefined || cancelling" @click="emit('cancel', job.id)">
                <Icon name="stop" :size="11" />
                {{ job.cancelRequestedAt || cancelling ? '终止中' : '终止任务' }}
              </button>
            </div>
            <div class="send-actions">
              <span class="send-hint">Enter 发送 · Shift+Enter 换行</span>
              <button class="control-send" :disabled="prompt.trim() === '' || steering" @click="sendSteer">
                <Icon name="send" :size="13" />
                {{ steering ? '发送中' : paused ? '继续任务' : '发送' }}
              </button>
            </div>
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
.stream-summary:hover { background: var(--hover); color: var(--text-secondary); }
.stream-chevron { width: 9px; flex: none; color: var(--text-faint); font-size: 9px; transition: transform 100ms; }
.stream-row[open] .stream-chevron { transform: rotate(90deg); }
.stream-kind { width: 31px; flex: none; color: var(--text-faint); font-size: 10.5px; }
.stream-agent .stream-kind { color: var(--accent); }
.stream-user .stream-kind { color: var(--accent); font-weight: 600; }
.stream-system .stream-kind { color: var(--text-muted); }
.stream-stderr .stream-kind, .stream-stderr .stream-preview { color: var(--warning); }
.tool-title { flex: none; color: var(--text-secondary); font: 500 11px/1.5 var(--font-mono); }
.stream-preview { min-width: 0; overflow: hidden; color: var(--text-secondary); font: 11.5px/1.5 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.stream-agent .stream-preview, .stream-user .stream-preview, .stream-system .stream-preview { font-family: var(--font-sans); font-size: 12px; }
.tool-result { margin-left: auto; flex: none; color: var(--success); font-size: 10.5px; }
.tool-result-failed { color: var(--danger); }
.tool-result-running { color: var(--text-faint); }
.tool-details { margin: 1px 5px 5px 15px; padding: 4px 0 4px 10px; border-left: 1px solid var(--border); }
.tool-detail-row { display: grid; grid-template-columns: 27px minmax(0, 1fr); gap: 8px; padding: 3px 0; }
.tool-detail-row pre { color: var(--code-text); font: 11px/1.55 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-detail-label { color: var(--text-faint); font-size: 10px; line-height: 1.7; }
.stream-body { margin: 1px 5px 5px 52px; padding: 3px 0 4px 9px; border-left: 1px solid var(--border); color: var(--code-text); font: 11.5px/1.6 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.stream-agent .stream-body, .stream-user .stream-body { font-family: var(--font-sans); font-size: 12px; }
.stream-cursor { height: 17px; padding: 2px 4px; }
.stream-cursor span { display: inline-block; width: 7px; height: 13px; background: var(--code-text); opacity: .65; animation: dot-pulse 1.2s ease-in-out infinite; }
.control-composer { display: flex; flex-direction: column; gap: 6px; }
.control-input { width: 100%; height: 44px; resize: none; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--surface); padding: 7px 9px; color: var(--text); font-size: 12.5px; line-height: 1.45; outline: none; transition: border-color 100ms, box-shadow 100ms; }
.control-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-soft); }
.control-input:disabled { opacity: .55; }
.control-toolbar { height: 28px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.task-actions, .send-actions { display: flex; align-items: center; gap: 4px; }
.task-action { height: 25px; display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; border-radius: 4px; color: var(--text-muted); font-size: 11.5px; cursor: pointer; }
.task-action:hover { background: var(--hover); color: var(--text); }
.task-action-danger { color: var(--danger); }
.task-action-danger:hover { background: var(--danger-soft); color: var(--danger); }
.task-action:disabled, .control-send:disabled { opacity: .45; pointer-events: none; }
.send-hint { margin-right: 4px; color: var(--text-faint); font-size: 10.5px; white-space: nowrap; }
.control-send { height: 28px; min-width: 64px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; border-radius: 5px; background: var(--accent); color: white; font-size: 11.5px; white-space: nowrap; cursor: pointer; transition: background-color 100ms; }
.control-send:hover { background: var(--accent-hover); }
@media (max-width: 560px) {
  .send-hint { display: none; }
}
</style>
