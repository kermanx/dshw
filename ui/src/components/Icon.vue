<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ name: string, size?: number }>(), { size: 15 })

const icons: Record<string, string> = {
  branch: 'i-lucide:git-pull-request',
  'git-graph': 'i-lucide:git-graph',
  repository: 'i-lucide:folder-git-2',
  worktree: 'i-lucide:git-fork',
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
  download: 'i-lucide:download',
  reset: 'i-lucide:rotate-ccw',
  ok: 'i-lucide:circle-check',
  bad: 'i-lucide:circle-x',
  pending: 'i-lucide:circle-dashed',
  neutral: 'i-lucide:circle-dot',
  alert: 'i-lucide:circle-alert',
  settings: 'i-lucide:settings',
  plus: 'i-lucide:plus',
  edit: 'i-lucide:pencil',
  trash: 'i-lucide:trash-2',
  key: 'i-lucide:key-round',
  send: 'i-lucide:send-horizontal',
  pause: 'i-lucide:pause',
  stop: 'i-lucide:square',
  grip: 'i-lucide:grip-vertical',
}

const cls = computed(() => icons[props.name] ?? '')
const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
</script>

<template>
  <span class="inline-block flex-none" :class="cls" :style="style" aria-hidden="true" />
</template>
