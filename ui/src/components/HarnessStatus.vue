<script setup lang="ts">
import { computed } from 'vue'
import { shortTime } from '../format.ts'
import type { UpdateState } from '../types.ts'
import Icon from './Icon.vue'

const props = defineProps<{ update: UpdateState }>()
const summary = computed(() => props.update.lastMessage?.split('\n')[0] || 'Harness 更新失败')
</script>

<template>
  <details class="group mx-12px mt-10px b b-solid b-[color-mix(in_srgb,var(--danger)_25%,transparent)] rounded bg-danger-soft">
    <summary class="flex items-center gap-8px h-32px px-12px cursor-pointer">
      <Icon class="flex-none text-danger" name="alert" :size="13" />
      <strong class="flex-none text-danger text-12px font-600">Harness 更新失败</strong>
      <span class="flex-1 min-w-0 truncate text-secondary text-12px">{{ summary }}</span>
      <time v-if="update.lastAt" class="flex-none font-mono text-muted text-11px">{{ shortTime(update.lastAt) }}</time>
      <Icon class="flex-none text-muted transition-transform duration-150 group-open:rotate-180" name="chevron" :size="13" />
    </summary>
    <pre class="m-0 px-12px py-10px b-t b-t-solid b-t-[color-mix(in_srgb,var(--danger)_25%,transparent)] rounded-b-md bg-code-bg text-code-text font-mono text-12px leading-[1.6] whitespace-pre-wrap break-anywhere">{{ update.lastMessage }}</pre>
  </details>
</template>
