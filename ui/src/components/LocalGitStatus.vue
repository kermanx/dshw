<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { CloneGitStatus } from '../../../src/types.ts'

export type LocalGitAction = 'discard-unstaged' | 'discard-staged' | 'abort-merge' | 'discard-unpushed' | 'pull'

const props = defineProps<{
  status: CloneGitStatus
  pending: boolean
}>()
const emit = defineEmits<{ action: [action: LocalGitAction] }>()

const open = ref(false)
const trigger = ref<HTMLElement>()
const position = ref({ top: 0, left: 0 })
let closeTimer: number | undefined

const dirty = computed(() => props.status.unstaged || props.status.staged || props.status.merging)
const label = computed(() => [
  props.status.unstaged ? '*' : '',
  props.status.staged ? '+' : '',
  props.status.merging ? '!' : '',
  props.status.ahead > 0 ? `↑${props.status.ahead}` : '',
  props.status.behind > 0 ? `↓${props.status.behind}` : '',
].join(''))

async function show(): Promise<void> {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  open.value = true
  await nextTick(updatePosition)
}

function hideSoon(): void {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => { open.value = false }, 100)
}

function updatePosition(): void {
  const rect = trigger.value?.getBoundingClientRect()
  if (rect === undefined) return
  const width = Math.min(240, window.innerWidth - 16)
  position.value = {
    top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 300)),
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
  }
}

function run(action: LocalGitAction): void {
  const confirmed = action === 'discard-unstaged'
    ? window.confirm('撤销所有未暂存更改？\n\n未暂存和未跟踪的内容都将永久删除，已暂存内容会保留。')
    : action === 'discard-staged'
      ? window.confirm('撤销所有未提交更改？\n\n已暂存的内容将永久删除。')
      : action === 'abort-merge'
        ? window.confirm('终止当前 merge？')
    : action === 'discard-unpushed'
      ? window.confirm(`丢弃 ${props.status.ahead} 个未推送提交？\n\n本地分支将重置到远端，无法从此菜单撤销。`)
      : true
  if (!confirmed) return
  open.value = false
  emit('action', action)
}

onBeforeUnmount(() => {
  if (closeTimer !== undefined) window.clearTimeout(closeTimer)
})
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="flex-none text-warn font-sans font-600 cursor-pointer rounded-3px hover:bg-warn-soft focus-visible:bg-warn-soft"
    :aria-expanded="open"
    aria-label="本地 Git 状态与操作"
    @mouseenter="show"
    @mouseleave="hideSoon"
    @focus="show"
    @blur="hideSoon"
  >{{ label }}</button>

  <Teleport to="body">
    <div
      v-if="open"
      data-local-git-popover
      class="fixed z-50 w-[min(240px,calc(100vw-16px))] overflow-hidden b b-solid b-line rounded-md bg-surface shadow-pop p-4px"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
      @mouseenter="show"
      @mouseleave="hideSoon"
      @focusin="show"
      @focusout="hideSoon"
    >
      <button
        v-if="status.unstaged"
        type="button"
        class="w-full flex items-center gap-8px min-h-28px px-7px rounded text-left text-secondary text-12px hover:bg-alt disabled:opacity-45 disabled:pointer-events-none"
        :disabled="pending || status.merging"
        :title="status.merging ? '请先终止 merge' : ''"
        @click="run('discard-unstaged')"
      ><span>撤销未暂存</span><span class="ml-auto flex-none text-warn text-11.5px font-sans font-600">*</span></button>
      <button
        v-if="status.staged"
        type="button"
        class="w-full flex items-center gap-8px min-h-28px px-7px rounded text-left text-secondary text-12px hover:bg-alt disabled:opacity-45 disabled:pointer-events-none"
        :disabled="pending || status.unstaged || status.merging"
        :title="status.merging ? '请先终止 merge' : status.unstaged ? '请先撤销未暂存' : ''"
        @click="run('discard-staged')"
      ><span>撤销未提交</span><span class="ml-auto flex-none text-warn text-11.5px font-sans font-600">+</span></button>
      <button
        v-if="status.merging"
        type="button"
        class="w-full flex items-center gap-8px min-h-28px px-7px rounded text-left text-secondary text-12px hover:bg-alt disabled:opacity-45 disabled:pointer-events-none"
        :disabled="pending"
        @click="run('abort-merge')"
      ><span>终止 merge</span><span class="ml-auto flex-none text-warn text-11.5px font-sans font-600">!</span></button>
      <button
        v-if="status.ahead > 0 && !dirty"
        type="button"
        class="w-full flex items-center gap-8px min-h-28px px-7px rounded text-left text-secondary text-12px hover:bg-alt disabled:opacity-45 disabled:pointer-events-none"
        :disabled="pending"
        @click="run('discard-unpushed')"
      ><span>丢弃未推送提交</span><span class="ml-auto flex-none text-warn text-11.5px font-sans font-600">↑{{ status.ahead }}</span></button>
      <button
        v-if="status.behind > 0"
        type="button"
        class="w-full flex items-center gap-8px min-h-28px px-7px rounded text-left text-secondary text-12px hover:bg-alt disabled:opacity-45 disabled:pointer-events-none"
        :disabled="pending || status.ahead > 0"
        :title="status.ahead > 0 ? '请先处理未推送提交' : ''"
        @click="run('pull')"
      ><span>拉取远端提交</span><span class="ml-auto flex-none text-warn text-11.5px font-sans font-600">↓{{ status.behind }}</span></button>
      <div v-if="pending" class="min-h-28px px-7px flex items-center text-muted text-11.5px">正在更新…</div>
    </div>
  </Teleport>
</template>
