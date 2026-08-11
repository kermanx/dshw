<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { reviewLabel, reviewTone } from '../format.ts'
import type { PrDashboardRecord, PullRequestReview } from '../types.ts'
import StatusIcon from './StatusIcon.vue'

const props = defineProps<{ pr: PrDashboardRecord }>()
const open = ref(false)
const trigger = ref<HTMLElement>()
const position = ref({ top: 0, left: 0 })

const requested = computed(() => [...new Set(props.pr.reviewRequests ?? [])])
const reviewed = computed(() => {
  const byLogin = new Map<string, PullRequestReview>()
  for (const review of props.pr.reviews ?? []) {
    const login = review.author?.login
    if (login !== undefined) byLogin.set(login, review)
  }
  return [...byLogin.entries()].map(([login, review]) => ({ login, review }))
})
const people = computed(() => [...new Set([...requested.value, ...reviewed.value.map(item => item.login)])])
const summary = computed(() => {
  const parts: string[] = []
  if (requested.value.length > 0) parts.push(`${requested.value.length} 人等待`)
  if (reviewed.value.length > 0) parts.push(`${reviewed.value.length} 人已 review`)
  return parts.join(' · ') || '尚未 request review'
})

function avatar(login: string): string { return `https://github.com/${encodeURIComponent(login)}.png?size=64` }
function reviewState(review: PullRequestReview): string {
  const progress = review.author?.login === undefined ? undefined : props.pr.reviewerComments?.[review.author.login]
  if (progress !== undefined && progress.total > 0) return `${progress.resolved}/${progress.total}`
  return review.state === 'APPROVED' ? '已批准' : review.state === 'CHANGES_REQUESTED' ? '要求修改' : '已 review'
}
function reviewStateTone(review: PullRequestReview): 'ok' | 'warn' | 'bad' | 'neutral' {
  const progress = review.author?.login === undefined ? undefined : props.pr.reviewerComments?.[review.author.login]
  if (progress !== undefined && progress.total > 0) return progress.resolved === progress.total ? 'ok' : 'warn'
  return review.state === 'APPROVED' ? 'ok' : review.state === 'CHANGES_REQUESTED' ? 'bad' : 'neutral'
}
async function toggle(): Promise<void> { open.value = !open.value; if (open.value) await nextTick(updatePosition) }
function updatePosition(): void {
  const rect = trigger.value?.getBoundingClientRect()
  if (rect === undefined) return
  const width = Math.min(380, window.innerWidth - 16)
  position.value = {
    top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 360)),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
  }
}
function closeOutside(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target
  if (target instanceof Element && (trigger.value?.contains(target) || target.closest('[data-review-popover]'))) return
  open.value = false
}
onMounted(() => {
  window.addEventListener('pointerdown', closeOutside, true)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', closeOutside, true)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
})
</script>

<template>
  <div class="h-46px flex flex-col justify-center gap-2px min-w-0">
    <button ref="trigger" class="inline-flex items-center gap-6px w-fit max-w-full cursor-pointer text-secondary text-12.5px hover:underline hover:text-fg" @click="toggle">
      <StatusIcon :tone="reviewTone(pr.reviewDecision)" />
      <span class="whitespace-nowrap">{{ reviewLabel(pr.reviewDecision) }}</span>
      <span v-if="people.length" class="inline-flex flex-none items-center pl-3px" aria-hidden="true">
        <img
          v-for="login in people.slice(0, 3)"
          :key="login"
          class="w-16px h-16px -ml-3px rounded-full b b-solid b-surface bg-widget object-cover"
          :src="avatar(login)"
          :alt="login"
        >
        <span v-if="people.length > 3" class="ml-3px text-faint text-10.5px">+{{ people.length - 3 }}</span>
      </span>
    </button>
    <slot :summary="summary">
      <span class="truncate text-muted text-11.5px">{{ summary }}</span>
    </slot>
  </div>

  <Teleport to="body">
    <div
      v-if="open"
      data-review-popover
      class="fixed z-40 w-[min(380px,calc(100vw-16px))] max-h-340px overflow-auto p-5px b b-solid b-line rounded bg-surface shadow-pop"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      <div v-if="requested.length === 0 && reviewed.length === 0" class="px-8px py-10px text-muted text-12px">尚未 request review</div>

      <section v-if="requested.length > 0" class="pb-4px">
        <div class="px-7px py-4px text-faint text-10.5px font-600 uppercase tracking-[0.06em]">等待 Review</div>
        <a
          v-for="login in requested"
          :key="`requested-${login}`"
          class="flex items-center gap-8px min-h-32px px-7px rounded text-secondary text-12px hover:bg-alt hover:no-underline"
          :href="`https://github.com/${login}`"
          target="_blank"
        >
          <img class="w-20px h-20px rounded-full bg-widget object-cover" :src="avatar(login)" :alt="login">
          <span class="min-w-0 flex-1 truncate">@{{ login }}</span>
          <span class="inline-flex flex-none items-center justify-start gap-5px w-82px text-left text-warn text-11.5px"><StatusIcon tone="warn" :size="11" />等待 review</span>
        </a>
      </section>

      <section v-if="reviewed.length > 0" :class="{ 'mt-3px pt-4px b-t b-t-solid b-t-line': requested.length > 0 }">
        <div class="px-7px py-4px text-faint text-10.5px font-600 uppercase tracking-[0.06em]">已 Review</div>
        <a
          v-for="item in reviewed"
          :key="`reviewed-${item.login}`"
          class="flex items-center gap-8px min-h-32px px-7px rounded text-secondary text-12px hover:bg-alt hover:no-underline"
          :href="`${pr.url}/files`"
          target="_blank"
        >
          <img class="w-20px h-20px rounded-full bg-widget object-cover" :src="avatar(item.login)" :alt="item.login">
          <span class="min-w-0 flex-1 truncate">@{{ item.login }}</span>
          <span class="inline-flex flex-none items-center justify-start gap-5px w-82px text-left text-11.5px" :class="`st-${reviewStateTone(item.review)}`">
            <StatusIcon :tone="reviewStateTone(item.review)" :size="11" />
            {{ reviewState(item.review) }}
          </span>
        </a>
      </section>
    </div>
  </Teleport>
</template>
