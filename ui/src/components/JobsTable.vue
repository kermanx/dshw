<script setup lang="ts">
import { computed } from 'vue'
import { jobLabel, jobTone, kindLabel, shortTime } from '../format.ts'
import type { JobRecord } from '../types.ts'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ jobs: JobRecord[], pending: ReadonlySet<string> }>()
const emit = defineEmits<{ open: [jobId: string], cancel: [jobId: string] }>()
const visible = computed(() => [...props.jobs].filter(job => job.type !== 'sync-check').reverse().slice(0, 20))
</script>

<template>
  <div v-if="visible.length === 0" class="empty-state">暂无任务</div>
  <ul v-else class="m-0 p-0 py-4px list-none h-full overflow-auto">
    <li
      v-for="job in visible"
      :key="job.id"
      class="flex items-center gap-10px h-32px px-12px cursor-pointer transition-colors duration-100 hover:bg-alt"
      role="button"
      tabindex="0"
      :title="job.summary"
      @click="emit('open', job.id)"
      @keydown.enter="emit('open', job.id)"
    >
      <StatusDot :tone="jobTone(job.status)" :pulse="job.status === 'running'" />
      <span class="flex-1 min-w-0 truncate text-fg text-12.5px">{{ job.summary }}</span>
      <span class="flex-none text-muted text-11.5px">{{ kindLabel(job.type) }}</span>
      <time class="flex-none w-74px text-right font-mono text-faint text-11px">{{ shortTime(job.finishedAt ?? job.startedAt ?? job.createdAt) }}</time>
      <button
        v-if="job.status === 'running'"
        class="btn btn-danger btn-sm flex-none"
        :disabled="job.cancelRequestedAt !== undefined || pending.has(`cancel:${job.id}`)"
        @click.stop="emit('cancel', job.id)"
      >{{ job.cancelRequestedAt !== undefined ? '终止中' : '终止' }}</button>
      <span v-else class="flex-none text-11.5px" :class="`st-${jobTone(job.status)}`">{{ jobLabel(job.status) }}</span>
    </li>
  </ul>
</template>
