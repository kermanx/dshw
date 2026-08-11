<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import type { PrDashboardRecord } from '../types.ts'
import StatusIcon from './StatusIcon.vue'

const props = defineProps<{ pr: PrDashboardRecord }>()
const open = ref(false)
const trigger = ref<HTMLElement>()
const position = ref({ top: 0, left: 0 })
let closeTimer: number | undefined

async function show(): Promise<void> {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  open.value = true
  await nextTick(updatePosition)
}
function hideSoon(): void {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => { open.value = false }, 80)
}
function updatePosition(): void {
  const rect = trigger.value?.getBoundingClientRect()
  if (rect === undefined) return
  const width = Math.min(420, window.innerWidth - 16)
  position.value = {
    top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - 300)),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
  }
}
onBeforeUnmount(() => {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
})
</script>

<template>
  <button
    type="button"
    ref="trigger"
    class="inline-flex items-center gap-6px w-fit min-w-0 h-20px cursor-pointer text-secondary text-12.5px whitespace-nowrap hover:underline hover:text-fg"
    @mouseenter="show"
    @mouseleave="hideSoon"
    @focus="show"
    @blur="hideSoon"
  >
    <StatusIcon tone="bad" />
    冲突
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed z-40 w-[min(420px,calc(100vw-16px))] max-h-280px overflow-auto px-10px py-8px b b-solid b-line rounded bg-surface shadow-pop"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      @mouseenter="show"
      @mouseleave="hideSoon"
    >
      <div class="mb-5px text-faint text-10.5px font-600 uppercase tracking-[0.05em]">冲突文件</div>
      <div v-if="pr.conflictPaths === undefined" class="py-3px text-muted text-12px">暂时无法读取冲突文件</div>
      <div v-else-if="pr.conflictPaths.length === 0" class="py-3px text-muted text-12px">本地未检测到冲突文件</div>
      <template v-else>
        <div
          v-for="path in pr.conflictPaths"
          :key="path"
          class="py-2px font-mono text-code-text text-11.5px leading-[1.45] break-anywhere"
        >{{ path }}</div>
      </template>
    </div>
  </Teleport>
</template>
