<script setup lang="ts">
import { computed } from 'vue'
import type { Tone } from '../types.ts'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ tone?: Tone, size?: number }>(), { tone: 'neutral', size: 13 })

const icon = computed(() => {
  switch (props.tone) {
    case 'ok': return 'ok'
    case 'bad': return 'bad'
    case 'warn': return 'pending'
    default: return 'neutral'
  }
})
const color = computed(() => {
  switch (props.tone) {
    case 'ok': return 'text-success'
    case 'bad': return 'text-danger'
    case 'warn': return 'text-warn'
    default: return 'text-faint'
  }
})
</script>

<template>
  <span class="inline-flex flex-none" :class="color" aria-hidden="true"><Icon :name="icon" :size="size" /></span>
</template>
