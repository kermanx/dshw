<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ name: string, size?: number }>(), { size: 15 })

const icons: Record<string, string> = {
  branch: 'i-lucide:git-pull-request',
  review: 'i-lucide:eye',
  list: 'i-lucide:list',
  terminal: 'i-lucide:square-terminal',
  history: 'i-lucide:history',
  copy: 'i-lucide:copy',
  close: 'i-lucide:x',
  chevron: 'i-lucide:chevron-down',
  code: 'i-lucide:code-xml',
  external: 'i-lucide:arrow-up-right',
  sync: 'i-lucide:refresh-cw',
  reset: 'i-lucide:rotate-ccw',
  ok: 'i-lucide:circle-check',
  bad: 'i-lucide:circle-x',
  pending: 'i-lucide:circle-dashed',
  neutral: 'i-lucide:circle-dot',
  alert: 'i-lucide:circle-alert',
}

const cls = computed(() => icons[props.name] ?? '')
const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <span class="inline-block flex-none" :class="cls" :style="style" aria-hidden="true" />
</template>
