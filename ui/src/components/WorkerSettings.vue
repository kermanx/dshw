<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { WorkerConfig, WorkerConfigInput } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ workers: WorkerConfig[] }>()
const emit = defineEmits<{ changed: [], toast: [message: string, bad?: boolean] }>()
const editing = ref<WorkerConfig>()
const dialogOpen = ref(false)
const saving = ref(false)
const removing = ref<string>()
const settingDefault = ref(false)
const form = reactive<WorkerConfigInput>({
  name: '', type: 'dsh', enabled: true,
  provider: 'deepseek-official', model: 'deepseek-v4-flash', baseUrl: '', searchBaseUrl: '', apiKeyMode: 'value', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '',
})

const title = computed(() => editing.value === undefined ? '添加 Worker' : '编辑 Worker')
const supported = computed(() => form.type === 'dsh')
const availableWorkers = computed(() => props.workers.filter(worker => worker.enabled))
const defaultWorkerId = computed(() => props.workers.find(worker => worker.enabled && worker.isDefault)?.id ?? '')
const hasSavedApiKey = computed(() => editing.value?.apiKeyMode === 'value' && editing.value.credentialSource === 'saved')
const formValid = computed(() => {
  if (form.name.trim() === '') return false
  if (form.apiKeyMode === 'environment') return (form.apiKeyEnv?.trim() ?? '') !== ''
  return (form.apiKey?.trim() ?? '') !== '' || hasSavedApiKey.value
})
const modelPlaceholder = computed(() => form.type === 'dsh' ? 'deepseek-v4-flash' : '模型 ID')
const thClass = 'h-30px px-12px b-b b-b-solid b-b-line bg-surface text-secondary text-11px font-500 uppercase tracking-[0.05em] text-left whitespace-nowrap sticky top-0 z-1'
const tdClass = 'h-44px px-12px align-middle'
const fieldClass = 'w-full h-28px rounded b b-solid b-line bg-surface px-8px text-12.5px outline-none focus:b-accent disabled:bg-widget disabled:text-muted'

watch(() => form.type, (type, previous) => {
  if (type === 'dsh') {
    form.enabled = true
    form.provider ||= 'deepseek-official'
    form.model ||= 'deepseek-v4-flash'
    form.apiKeyEnv ||= 'DEEPSEEK_API_KEY'
  } else {
    form.enabled = false
    form.provider = undefined
    if (previous === 'dsh') form.model = undefined
    if (previous === 'dsh') {
      form.baseUrl = undefined
      form.searchBaseUrl = undefined
    }
    form.apiKeyEnv = type === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
  }
})

function openCreate(): void {
  editing.value = undefined
  Object.assign(form, {
    name: '', type: 'dsh', enabled: true,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', baseUrl: '', searchBaseUrl: '', apiKeyMode: 'value', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '',
  })
  dialogOpen.value = true
}

function openEdit(worker: WorkerConfig): void {
  editing.value = worker
  Object.assign(form, {
    name: worker.name, type: worker.type, enabled: worker.enabled,
    provider: worker.provider, model: worker.model, baseUrl: worker.baseUrl, searchBaseUrl: worker.searchBaseUrl, apiKeyMode: worker.apiKeyMode, apiKeyEnv: worker.apiKeyEnv, apiKey: '',
  })
  dialogOpen.value = true
}

async function save(): Promise<void> {
  if (saving.value || !formValid.value) return
  saving.value = true
  try {
    const path = editing.value === undefined ? '/api/workers' : `/api/workers/${encodeURIComponent(editing.value.id)}`
    const response = await fetch(path, {
      method: editing.value === undefined ? 'POST' : 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    })
    const value = await response.json() as { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    dialogOpen.value = false
    emit('toast', editing.value === undefined ? 'Worker 已添加' : 'Worker 已更新')
    emit('changed')
  } catch (error) {
    emit('toast', `保存失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    saving.value = false
  }
}

async function setDefault(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const configId = select.value
  if (settingDefault.value || configId === '' || configId === defaultWorkerId.value) return
  settingDefault.value = true
  try {
    const response = await fetch(`/api/workers/${encodeURIComponent(configId)}/default`, { method: 'PUT' })
    const value = await response.json() as { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    emit('toast', '默认 Worker 已切换')
    emit('changed')
  } catch (error) {
    select.value = defaultWorkerId.value
    emit('toast', `切换失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    settingDefault.value = false
  }
}

async function remove(worker: WorkerConfig): Promise<void> {
  if (removing.value !== undefined || !window.confirm(`删除 Worker「${worker.name}」？`)) return
  removing.value = worker.id
  try {
    const response = await fetch(`/api/workers/${encodeURIComponent(worker.id)}`, { method: 'DELETE' })
    const value = await response.json() as { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    emit('toast', 'Worker 已删除')
    emit('changed')
  } catch (error) {
    emit('toast', `删除失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    removing.value = undefined
  }
}

function typeLabel(type: WorkerConfig['type']): string {
  return type === 'dsh' ? 'dsh' : type === 'codex' ? 'Codex' : 'Claude Code'
}

function credentialLabel(worker: WorkerConfig): string {
  if (worker.credentialSource === 'saved') return '已保存'
  if (worker.credentialSource === 'environment') return '环境变量'
  return '未配置'
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="h-40px flex-none flex items-center px-14px b-b b-b-solid b-b-line text-13px font-600 text-fg">
      设置
    </div>
    <div class="flex-1 min-h-0 grid grid-cols-[144px_minmax(0,1fr)]">
      <aside class="min-h-0 b-r b-r-solid b-r-line p-6px">
        <button class="w-full h-30px flex items-center gap-7px rounded px-8px bg-alt text-12px font-500 text-fg text-left">
          <Icon name="settings" :size="12" />Workers
        </button>
      </aside>

      <section class="min-w-0 min-h-0 flex flex-col">
        <div class="h-40px flex-none flex items-center justify-between gap-12px px-12px b-b b-b-solid b-b-line">
          <span class="text-12.5px font-600 text-fg">Workers</span>
          <div class="flex items-center gap-10px">
            <label class="inline-flex items-center gap-6px text-11.5px text-secondary">
              <span>默认 Worker</span>
              <select class="w-160px h-28px rounded b b-solid b-line bg-surface px-7px text-12px text-fg outline-none focus:b-accent disabled:text-muted" :value="defaultWorkerId" :disabled="settingDefault || availableWorkers.length === 0" @change="setDefault">
                <option v-if="availableWorkers.length === 0" value="">无可用 Worker</option>
                <option v-for="worker in availableWorkers" :key="worker.id" :value="worker.id">{{ worker.name }}</option>
              </select>
            </label>
            <button class="btn btn-primary" @click="openCreate"><Icon name="plus" :size="12" />添加</button>
          </div>
        </div>

        <div v-if="workers.length === 0" class="empty-state">
          <span>暂无 Worker</span>
          <button class="text-link cursor-pointer hover:underline" @click="openCreate">添加配置</button>
        </div>
        <div v-else class="flex-1 min-h-0 overflow-auto">
          <table class="w-full min-w-900px border-collapse table-fixed">
            <thead><tr>
              <th class="w-110px" :class="thClass">状态</th>
              <th class="w-220px" :class="thClass">名称</th>
              <th class="w-140px" :class="thClass">类型</th>
              <th :class="thClass">模型</th>
              <th :class="thClass">Base URL</th>
              <th class="w-130px" :class="thClass">凭据</th>
              <th class="w-90px" :class="thClass"></th>
            </tr></thead>
            <tbody>
              <tr v-for="worker in workers" :key="worker.id" class="transition-colors duration-100 hover:bg-alt">
                <td :class="tdClass">
                  <span class="inline-flex items-center gap-6px text-11.5px" :class="worker.enabled ? 'st-ok' : 'st-neutral'">
                    <StatusDot :tone="worker.enabled ? 'ok' : 'neutral'" />{{ worker.enabled ? '已启用' : '未启用' }}
                  </span>
                </td>
                <td :class="tdClass">
                  <div class="flex items-center gap-6px min-w-0"><span class="truncate text-12.5px font-500 text-fg">{{ worker.name }}</span><span v-if="worker.isDefault" class="badge">默认</span></div>
                </td>
                <td :class="tdClass"><span class="text-12px text-secondary">{{ typeLabel(worker.type) }}</span><span v-if="worker.type !== 'dsh'" class="ml-6px text-10.5px text-muted">未支持</span></td>
                <td :class="tdClass"><span class="block truncate font-mono text-11.5px text-secondary" :title="worker.model">{{ worker.model || '—' }}</span></td>
                <td :class="tdClass"><span class="block truncate font-mono text-11.5px text-secondary" :title="worker.baseUrl">{{ worker.baseUrl || '默认' }}</span></td>
                <td :class="tdClass"><span class="inline-flex items-center gap-5px text-11.5px" :class="worker.hasApiKey ? 'text-secondary' : 'text-warn'"><Icon name="key" :size="11" />{{ credentialLabel(worker) }}</span></td>
                <td :class="tdClass"><div class="flex justify-end gap-2px"><button class="icon-btn" aria-label="编辑" @click="openEdit(worker)"><Icon name="edit" :size="12" /></button><button class="icon-btn hover:!text-danger" aria-label="删除" :disabled="removing === worker.id" @click="remove(worker)"><Icon name="trash" :size="12" /></button></div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>

  <div v-if="dialogOpen" class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay" role="presentation" @click.self="dialogOpen = false">
    <section class="w-[min(560px,100%)] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop" role="dialog" aria-modal="true">
      <header class="h-48px flex items-center justify-between px-14px b-b b-b-solid b-b-line"><h2 class="m-0 text-13.5px font-600">{{ title }}</h2><button class="icon-btn" aria-label="关闭" @click="dialogOpen = false"><Icon name="close" :size="15" /></button></header>
      <div class="grid grid-cols-2 gap-x-12px gap-y-11px p-14px">
        <div class="col-span-2 text-10.5px font-600 uppercase tracking-[0.05em] text-muted">基本</div>
        <label class="col-span-2 text-11.5px text-secondary"><span class="block mb-4px">名称</span><input v-model="form.name" :class="fieldClass" placeholder="例如：日常 dsh" autofocus></label>
        <label class="text-11.5px text-secondary"><span class="block mb-4px">类型</span><select v-model="form.type" :class="fieldClass"><option value="dsh">dsh</option><option value="codex">Codex（未支持）</option><option value="claude-code">Claude Code（未支持）</option></select></label>
        <label class="flex items-end pb-6px gap-6px text-11.5px text-secondary"><input v-model="form.enabled" type="checkbox" :disabled="!supported">启用</label>
        <div class="col-span-2 mt-2px text-10.5px font-600 uppercase tracking-[0.05em] text-muted">模型</div>
        <label class="text-11.5px text-secondary"><span class="block mb-4px">Provider</span><input v-model="form.provider" :class="fieldClass" :disabled="!supported" placeholder="deepseek-official"></label>
        <label class="text-11.5px text-secondary"><span class="block mb-4px">模型</span><input v-model="form.model" :class="fieldClass" :placeholder="modelPlaceholder"></label>
        <div class="col-span-2 mt-2px text-10.5px font-600 uppercase tracking-[0.05em] text-muted">连接</div>
        <label class="col-span-2 text-11.5px text-secondary"><span class="block mb-4px">Base URL</span><input v-model="form.baseUrl" type="url" :class="fieldClass" placeholder="留空则使用 DEEPSEEK_BASE_URL"></label>
        <label v-if="supported" class="col-span-2 text-11.5px text-secondary"><span class="block mb-4px">Search Base URL</span><input v-model="form.searchBaseUrl" type="url" :class="fieldClass" placeholder="留空则使用 DEEPSEEK_SEARCH_BASE_URL"></label>
        <label class="text-11.5px text-secondary"><span class="block mb-4px">API Key 来源</span><select v-model="form.apiKeyMode" :class="fieldClass"><option value="value">直接输入</option><option value="environment">环境变量</option></select></label>
        <label v-if="form.apiKeyMode === 'value'" class="text-11.5px text-secondary"><span class="block mb-4px">API Key</span><input v-model="form.apiKey" type="password" autocomplete="new-password" :class="fieldClass" :placeholder="hasSavedApiKey ? '已保存；留空不变' : '输入 API Key'"></label>
        <label v-else class="text-11.5px text-secondary"><span class="block mb-4px">环境变量</span><input v-model="form.apiKeyEnv" :class="fieldClass" placeholder="DEEPSEEK_API_KEY"></label>
        <div v-if="!supported" class="col-span-2 px-9px py-7px rounded bg-warn-soft text-11.5px text-secondary">暂未支持运行，将保存为未启用。</div>
      </div>
      <footer class="h-48px flex items-center justify-end gap-6px px-12px b-t b-t-solid b-t-line"><button class="btn btn-ghost" @click="dialogOpen = false">取消</button><button class="btn btn-primary" :disabled="saving || !formValid" @click="save">{{ saving ? '保存中' : '保存' }}</button></footer>
    </section>
  </div>
</template>
