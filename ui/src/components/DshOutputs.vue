<script setup lang="ts">
import { computed } from 'vue'
import { cloneNameOf, jobLabel, jobTone, kindLabel, shortTime, stripAnsi } from '../format.ts'
import type { DshRunRecord } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ runs: DshRunRecord[] }>()
const emit = defineEmits<{ toast: [message: string, bad?: boolean] }>()
const visible = computed(() => [...props.runs].reverse().slice(0, 30))

async function copy(run: DshRunRecord): Promise<void> {
  try {
    await navigator.clipboard.writeText(run.finalOutput)
    emit('toast', '输出已复制')
  } catch {
    emit('toast', '复制失败', true)
  }
}
</script>

<template>
  <div v-if="visible.length === 0" class="empty-state">尚未调用 dsh</div>
  <div v-else class="h-full overflow-auto py-4px">
    <details v-for="run in visible" :key="run.id" class="group">
      <summary class="flex items-center gap-10px h-32px px-12px cursor-pointer transition-colors duration-100 hover:bg-alt">
        <StatusDot :tone="jobTone(run.status)" />
        <span class="flex-none w-76px text-fg text-12.5px font-500 whitespace-nowrap">{{ kindLabel(run.kind) }}</span>
        <span class="flex-none w-64px truncate font-mono text-muted text-11.5px" :title="run.clonePath">{{ cloneNameOf(run.clonePath) }}</span>
        <span class="flex-none w-56px text-11.5px whitespace-nowrap" :class="`st-${jobTone(run.status)}`">{{ jobLabel(run.status) }}</span>
        <time class="flex-none w-74px ml-auto text-right font-mono text-faint text-11px">{{ shortTime(run.finishedAt) }}</time>
        <button class="btn btn-ghost btn-sm flex-none w-40px justify-center opacity-0 transition-opacity duration-100 group-hover:opacity-100" @click.prevent="copy(run)">复制</button>
        <Icon class="flex-none text-faint transition-transform duration-150 group-open:rotate-180" name="chevron" :size="13" />
      </summary>
      <pre class="m-0 px-14px py-10px b-t b-t-solid b-t-line bg-code-bg text-code-text font-mono text-12px leading-[1.6] whitespace-pre-wrap break-anywhere">{{ stripAnsi(run.finalOutput) }}</pre>
    </details>
  </div>
</template>
