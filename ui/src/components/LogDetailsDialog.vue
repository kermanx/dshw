<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { EventRecord } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ record: EventRecord }>()
const emit = defineEmits<{ close: [] }>()
const copied = ref(false)
let copiedTimer: number | undefined

const level = computed(() => props.record.level === 'error'
  ? { label: '错误', tone: 'bad' as const }
  : props.record.level === 'warning'
    ? { label: '警告', tone: 'warn' as const }
    : { label: '信息', tone: 'neutral' as const })
const fullTime = computed(() => new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hour12: false,
}).format(new Date(props.record.time)))

async function copyMessage(): Promise<void> {
  await navigator.clipboard.writeText(props.record.message)
  copied.value = true
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => { copied.value = false }, 1_500)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer)
})
</script>

<template>
  <div class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay max-[640px]:p-0" role="presentation" @click.self="emit('close')">
    <section
      class="w-[min(760px,100%)] h-[min(620px,calc(100vh-48px))] grid grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop max-[640px]:w-full max-[640px]:h-full max-[640px]:b-0 max-[640px]:rounded-0"
      role="dialog"
      aria-modal="true"
      aria-labelledby="log-details-title"
    >
      <header class="h-48px flex items-center justify-between gap-12px px-14px b-b b-b-solid b-b-line">
        <div class="min-w-0 flex items-center gap-8px">
          <h2 id="log-details-title" class="m-0 text-13.5px font-600">日志详情</h2>
          <span class="truncate font-mono text-faint text-10.5px" :title="record.id">{{ record.id }}</span>
        </div>
        <button class="icon-btn flex-none" aria-label="关闭" title="关闭 (Esc)" @click="emit('close')"><Icon name="close" :size="15" /></button>
      </header>

      <div class="min-h-42px flex flex-wrap items-center gap-x-18px gap-y-5px px-14px py-8px b-b b-b-solid b-b-line bg-widget text-11.5px">
        <span class="inline-flex items-center gap-6px" :class="`st-${level.tone}`"><StatusDot :tone="level.tone" />{{ level.label }}</span>
        <span class="inline-flex items-center gap-6px min-w-0"><span class="text-faint">来源</span><code class="truncate text-secondary" :title="record.kind">{{ record.kind }}</code></span>
        <span class="inline-flex items-center gap-6px"><span class="text-faint">时间</span><time class="font-mono text-secondary whitespace-nowrap">{{ fullTime }}</time></span>
      </div>

      <div class="min-h-0 overflow-auto bg-code-bg">
        <pre class="min-h-full p-16px text-code-text text-12.5px leading-[1.65] whitespace-pre-wrap break-anywhere select-text">{{ record.message }}</pre>
      </div>

      <footer class="h-48px flex items-center justify-end px-12px b-t b-t-solid b-t-line bg-surface">
        <button class="btn btn-default" @click="copyMessage"><Icon :name="copied ? 'ok' : 'copy'" :size="13" />{{ copied ? '已复制' : '复制完整日志' }}</button>
      </footer>
    </section>
  </div>
</template>
