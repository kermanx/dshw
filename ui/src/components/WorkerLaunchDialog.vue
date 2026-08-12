<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorkerConfig, WorkerTypeAvailability } from '../types.ts'
import Icon from './Icon.vue'

const props = defineProps<{
  action: 'merge-base' | 'fix-ci' | 'resolve-comments'
  workers: WorkerConfig[]
  workerTypes: WorkerTypeAvailability[]
}>()
const emit = defineEmits<{ close: [], start: [workerConfigId: string, additionalInstruction: string] }>()
const available = computed(() => props.workers.filter(worker => worker.enabled && props.workerTypes.find(status => status.type === worker.type)?.available === true))
const selectedId = ref('')
const additionalInstruction = ref('')

watch(available, workers => {
  if (!workers.some(worker => worker.id === selectedId.value)) selectedId.value = workers[0]?.id ?? ''
}, { immediate: true })

const title = computed(() => props.action === 'merge-base' ? '合并 base' : props.action === 'fix-ci' ? '修复 CI' : '解决评论')

function subtitle(worker: WorkerConfig): string {
  const type = worker.type === 'dsh' ? 'dsh' : worker.type === 'codex' ? 'Codex' : 'Claude Code'
  return `${type} · ${worker.model || '默认模型'} · ${worker.reasoningEffort || '默认推理'}`
}
</script>

<template>
  <div class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay" role="presentation" @click.self="emit('close')">
    <section class="w-[min(440px,100%)] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop" role="dialog" aria-modal="true" aria-labelledby="worker-launch-title">
      <header class="min-h-58px flex items-center justify-between px-14px py-10px b-b b-b-solid b-b-line">
        <div class="min-w-0"><h2 id="worker-launch-title" class="m-0 text-13.5px font-600">启动任务</h2><div class="mt-1px text-11px text-muted">{{ title }}</div></div>
        <button class="icon-btn" aria-label="关闭" @click="emit('close')"><Icon name="close" :size="15" /></button>
      </header>
      <div class="max-h-[min(480px,calc(100vh-180px))] overflow-auto p-12px">
        <fieldset class="m-0 p-0 b-0">
          <legend class="mb-5px text-11.5px font-500 text-secondary">Worker</legend>
          <label
            v-for="worker in available"
            :key="worker.id"
            class="flex items-center gap-10px min-h-48px px-9px rounded cursor-pointer hover:bg-alt"
            :class="{ 'bg-alt': selectedId === worker.id }"
          >
            <input v-model="selectedId" type="radio" name="worker" :value="worker.id">
            <span class="min-w-0 flex-1"><span class="flex items-center gap-6px text-12.5px font-500 text-fg"><span class="truncate">{{ worker.name }}</span><span v-if="worker.isDefault" class="badge">默认</span></span><span class="block mt-2px truncate font-mono text-10.5px text-muted">{{ subtitle(worker) }}</span></span>
          </label>
          <div v-if="available.length === 0" class="py-26px text-center text-12px text-muted">没有可用的 Worker</div>
        </fieldset>
        <label class="block mt-12px text-11.5px font-500 text-secondary">
          <span class="block mb-5px">额外指令 <span class="font-400 text-muted">（可选）</span></span>
          <textarea
            v-model="additionalInstruction"
            class="block w-full min-h-76px resize-y rounded b b-solid b-line bg-surface px-9px py-7px text-12.5px leading-18px text-fg outline-none placeholder:text-faint focus:b-accent"
            maxlength="4000"
            placeholder="例如：只修改相关文件，不要调整现有 API"
          />
        </label>
      </div>
      <footer class="h-48px flex items-center justify-end gap-6px px-12px b-t b-t-solid b-t-line">
        <button class="btn btn-ghost" @click="emit('close')">取消</button>
        <button class="btn btn-primary" :disabled="selectedId === ''" @click="emit('start', selectedId, additionalInstruction)">启动任务</button>
      </footer>
    </section>
  </div>
</template>
