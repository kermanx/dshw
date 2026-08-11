<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ciLabel, ciTone } from '../format.ts'
import type { CiCheck, PrDashboardRecord } from '../types.ts'
import StatusIcon from './StatusIcon.vue'

const props = defineProps<{ pr: PrDashboardRecord }>()
const open = ref(false)
const trigger = ref<HTMLElement>()
const position = ref({ top: 0, left: 0 })
const ordered = computed(() => [...props.pr.checks].sort((a, b) => rank(a) - rank(b)))
const passed = computed(() => props.pr.checks.filter(check => check.bucket === 'pass').length)
const failed = computed(() => props.pr.checks.filter(check => check.bucket === 'fail' || check.bucket === 'cancel').length)
const pending = computed(() => props.pr.checks.filter(check => check.bucket === 'pending').length)
const note = computed(() => failed.value ? `${failed.value} 个失败` : pending.value ? `${pending.value} 个运行中` : props.pr.checks.length ? '' : '尚无 checks')

function rank(check: CiCheck): number { return check.bucket === 'fail' || check.bucket === 'cancel' ? 0 : check.bucket === 'pending' ? 1 : 2 }
function label(check: CiCheck): string { return check.bucket === 'pass' ? '通过' : check.bucket === 'pending' ? '运行中' : '失败' }
function tone(check: CiCheck): 'ok' | 'warn' | 'bad' { return check.bucket === 'pass' ? 'ok' : check.bucket === 'pending' ? 'warn' : 'bad' }
async function toggle(): Promise<void> { open.value = !open.value; if (open.value) await nextTick(updatePosition) }
function updatePosition(): void {
  const rect = trigger.value?.getBoundingClientRect(); if (!rect) return
  const width = Math.min(360, window.innerWidth - 32)
  position.value = { top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 320)), left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) }
}
function closeOutside(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target
  if (target instanceof Element && (trigger.value?.contains(target) || target.closest('[data-ci-popover]'))) return
  open.value = false
}
onMounted(() => { window.addEventListener('pointerdown', closeOutside, true); window.addEventListener('resize', updatePosition); window.addEventListener('scroll', updatePosition, true) })
onBeforeUnmount(() => { window.removeEventListener('pointerdown', closeOutside, true); window.removeEventListener('resize', updatePosition); window.removeEventListener('scroll', updatePosition, true) })
</script>

<template>
  <div class="h-46px flex flex-col justify-center gap-2px min-w-0">
    <button ref="trigger" class="inline-flex items-center gap-6px w-fit cursor-pointer text-secondary text-12.5px hover:underline hover:text-fg" @click="toggle">
      <StatusIcon :tone="ciTone(pr.ciStatus)" />
      <span class="whitespace-nowrap">{{ ciLabel(pr.ciStatus) }}</span>
      <span v-if="pr.checks.length" class="font-mono text-faint text-11px">{{ passed }}/{{ pr.checks.length }}</span>
    </button>
    <slot :note="note">
      <span v-if="note" class="truncate text-muted text-11.5px">{{ note }}</span>
    </slot>
  </div>
  <Teleport to="body">
    <div
      v-if="open"
      data-ci-popover
      class="fixed z-40 w-[min(360px,calc(100vw-16px))] max-h-300px overflow-auto p-4px b b-solid b-line rounded bg-surface shadow-pop"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      <div v-if="ordered.length === 0" class="px-8px py-10px text-muted text-12px">尚无 checks</div>
      <a
        v-for="check in ordered"
        :key="`${check.name}-${check.link}`"
        class="flex items-center gap-8px min-h-26px px-8px rounded text-secondary text-12px hover:bg-alt hover:no-underline"
        :href="check.link || pr.url"
        target="_blank"
        :title="check.workflow"
      >
        <StatusIcon :tone="tone(check)" :size="12" />
        <span class="min-w-0 flex-1 truncate">{{ check.name }}</span>
        <span class="flex-none text-11.5px" :class="`st-${tone(check)}`">{{ label(check) }}</span>
      </a>
    </div>
  </Teleport>
</template>
