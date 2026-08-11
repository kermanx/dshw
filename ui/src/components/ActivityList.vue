<script setup lang="ts">
import { computed } from 'vue'
import { shortTime } from '../format.ts'
import type { EventRecord } from '../types.ts'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ events: EventRecord[] }>()
const visible = computed(() => [...props.events].reverse().slice(0, 60))

function levelTone(level: EventRecord['level']): 'bad' | 'warn' | 'neutral' {
  return level === 'error' ? 'bad' : level === 'warning' ? 'warn' : 'neutral'
}
</script>

<template>
  <div v-if="visible.length === 0" class="empty-state">暂无事件</div>
  <ul v-else class="m-0 p-0 py-4px list-none h-full overflow-auto">
    <li v-for="event in visible" :key="event.id" class="flex items-center gap-10px h-32px px-12px transition-colors duration-100 hover:bg-alt">
      <StatusDot :tone="levelTone(event.level)" />
      <span class="flex-none w-104px truncate font-mono text-muted text-11px">{{ event.kind }}</span>
      <span class="flex-1 min-w-0 truncate text-secondary text-12.5px" :title="event.message">{{ event.message }}</span>
      <time class="flex-none w-74px text-right font-mono text-faint text-11px">{{ shortTime(event.time) }}</time>
    </li>
  </ul>
</template>
