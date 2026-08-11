<script setup lang="ts">
import { computed } from 'vue'
import type { Tone } from '../types.ts'

const props = withDefaults(defineProps<{ tone?: Tone, pulse?: boolean }>(), { tone: 'neutral' })

const colors: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warn',
  bad: 'bg-danger',
  accent: 'bg-accent',
  neutral: 'bg-faint',
}

const cls = computed(() => [colors[props.tone], { 'dot-pulse': props.pulse }])
</script>

<template>
  <span class="inline-block flex-none w-8px h-8px rounded-full" :class="cls" aria-hidden="true" />
</template>
