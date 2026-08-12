<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { shortTime } from '../format.ts'
import type { DshwRepositoryStatus, HarnessRepositoryStatus, UpdateState, WorkerConfig, WorkerConfigInput, WorkerModelCatalog, WorkerTypeAvailability, WorktreeCleanupCandidate, WorktreeCleanupPreview } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{
  workers: WorkerConfig[]
  workerTypes: WorkerTypeAvailability[]
  dshwRepository: DshwRepositoryStatus
  repository: HarnessRepositoryStatus
  update: UpdateState
  updating: boolean
  reconfiguring: boolean
  updatingDshw: boolean
  devMode: boolean
  worktreeCount: number
  worktreeCleanupCount?: number
}>()
const emit = defineEmits<{
  changed: []
  toast: [message: string, bad?: boolean]
  updateDshw: []
  updateHarness: []
  reconfigureHarness: []
}>()
const section = ref<'repository' | 'workers'>('repository')
const editing = ref<WorkerConfig>()
const dialogOpen = ref(false)
const cleanupDialogOpen = ref(false)
const cleanupLoading = ref(false)
const cleanupPreview = ref<WorktreeCleanupPreview>()
const cleanupDecisions = reactive<Record<string, 'keep' | 'delete'>>({})
const saving = ref(false)
const removing = ref<string>()
const reordering = ref(false)
const draggedId = ref<string>()
const dragOverId = ref<string>()
const displayedWorkers = ref<WorkerConfig[]>([])
const modelCatalog = ref<WorkerModelCatalog>()
const modelLoading = ref(false)
const modelError = ref('')
let modelRequest = 0
const form = reactive<WorkerConfigInput>({
  name: '', type: 'dsh', enabled: true,
  provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: '', baseUrl: '', searchBaseUrl: '', apiKeyMode: 'value', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '',
})

const title = computed(() => editing.value === undefined ? '添加 Worker' : '编辑 Worker')
const selectedType = computed(() => props.workerTypes.find(status => status.type === form.type))
const typeAvailable = computed(() => selectedType.value?.available === true)
const codexStatus = computed(() => props.workerTypes.find(status => status.type === 'codex'))
const hasSavedApiKey = computed(() => editing.value?.apiKeyMode === 'value' && editing.value.credentialSource === 'saved')
const formValid = computed(() => {
  if (form.name.trim() === '') return false
  if (!typeAvailable.value) return false
  if (form.type === 'codex') return true
  if (form.apiKeyMode === 'environment') return (form.apiKeyEnv?.trim() ?? '') !== ''
  return (form.apiKey?.trim() ?? '') !== '' || hasSavedApiKey.value
})
const selectedModel = computed(() => modelCatalog.value?.models.find(model => model.id === (form.model || modelCatalog.value?.defaultModel)))
const reasoningEfforts = computed(() => selectedModel.value?.reasoningEfforts ?? (form.type === 'dsh' ? modelCatalog.value?.models[0]?.reasoningEfforts ?? [] : []))
const reasoningEffortOptions = computed(() => {
  const options = [...reasoningEfforts.value]
  const current = form.reasoningEffort?.trim()
  if (current && !options.some(option => option.id === current)) options.push({ id: current, name: current })
  return options
})
const effectiveDefaultEffort = computed(() => modelCatalog.value?.defaultReasoningEffort ?? selectedModel.value?.defaultReasoningEffort)
const modelPlaceholder = computed(() => {
  const defaultModel = modelCatalog.value?.defaultModel
  if (form.type === 'codex') return defaultModel === undefined ? '使用本机默认模型' : `本机默认：${defaultModel}`
  return defaultModel ?? '模型名称'
})
const thClass = 'h-30px px-12px b-b b-b-solid b-b-line bg-surface text-secondary text-11px font-500 uppercase tracking-[0.05em] text-left whitespace-nowrap sticky top-0 z-1'
const tdClass = 'h-44px px-12px align-middle'
const fieldClass = 'w-full h-28px rounded b b-solid b-line bg-surface px-8px text-12.5px outline-none focus:b-accent disabled:bg-widget disabled:text-muted'
const repositoryLag = computed(() => {
  if (props.repository.state === 'error') return '暂时无法确认与上游的差异'
  const behind = props.repository.behind ?? 0
  return behind === 0 ? '当前已与上游一致' : `当前落后上游 ${behind} 个提交`
})
const dshwRepositoryLag = computed(() => {
  if (props.dshwRepository.state === 'error') return '暂时无法确认与上游的差异'
  const behind = props.dshwRepository.behind ?? 0
  const lag = behind === 0 ? '当前已与上游一致' : `当前落后上游 ${behind} 个提交`
  return props.dshwRepository.dirty ? `${lag} · 有本地修改` : lag
})
const worktreeSummary = computed(() => props.worktreeCleanupCount === undefined
  ? `当前 ${props.worktreeCount} 个，可清理数量待确认`
  : `当前 ${props.worktreeCount} 个，其中 ${props.worktreeCleanupCount} 个可清理`)
const riskyWorktrees = computed(() => cleanupPreview.value?.candidates.filter(candidate => candidate.needsDecision) ?? [])
const cleanWorktreeCount = computed(() => cleanupPreview.value?.candidates.filter(candidate => !candidate.needsDecision).length ?? 0)
const selectedDirtyCount = computed(() => riskyWorktrees.value.filter(candidate => cleanupDecisions[candidate.name] === 'delete').length)
const cleanupDeleteCount = computed(() => cleanWorktreeCount.value + selectedDirtyCount.value)
const updateResult = computed(() => {
  if (props.update.lastAt === undefined) return '尚未执行维护操作'
  const status = props.update.lastStatus === 'failed' ? '失败' : '完成'
  return `${shortTime(props.update.lastAt)} ${status}${props.update.lastMessage ? ` · ${props.update.lastMessage}` : ''}`
})

function confirmReconfigure(): void {
  const confirmed = window.confirm([
    '从头配置当前 dsh 主仓库？',
    '',
    '这会执行两次 git clean -fdx，删除所有未跟踪和 ignored 文件（包括 .env、node_modules 和构建产物），然后拉取 origin/master、重新安装依赖并运行 typecheck。',
    '',
    '若存在 tracked 或 staged 修改，后台会拒绝执行。',
  ].join('\n'))
  if (confirmed) emit('reconfigureHarness')
}

async function inspectWorktreeCleanup(): Promise<void> {
  if (cleanupLoading.value) return
  cleanupLoading.value = true
  try {
    const response = await fetch('/api/worktrees/cleanup/preview', { method: 'POST' })
    const value = await response.json() as WorktreeCleanupPreview & { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    cleanupPreview.value = value
    if (value.candidates.length === 0) {
      emit('toast', value.busy > 0 ? '没有可清理的 Worktree；有任务正在使用候选项' : '没有非 active PR 的 Worktree')
      return
    }
    const risky = value.candidates.filter(candidate => candidate.needsDecision)
    if (risky.length === 0) {
      if (window.confirm(`清理 ${value.candidates.length} 个不再对应 active PR 的 Worktree？\n\n这些 Worktree 没有本地改动或未推送提交，将被直接删除。`)) {
        cleanupLoading.value = false
        await executeWorktreeCleanup([])
      }
      return
    }
    for (const key of Object.keys(cleanupDecisions)) delete cleanupDecisions[key]
    for (const candidate of risky) cleanupDecisions[candidate.name] = 'keep'
    cleanupDialogOpen.value = true
  } catch (error) {
    emit('toast', `检查失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    cleanupLoading.value = false
  }
}

async function executeWorktreeCleanup(deleteDirty: string[]): Promise<void> {
  if (cleanupLoading.value) return
  cleanupLoading.value = true
  try {
    const response = await fetch('/api/worktrees/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deleteDirty }),
    })
    const value = await response.json() as { deleted?: string[], kept?: string[], failed?: Array<{ name: string, error: string }>, error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    cleanupDialogOpen.value = false
    cleanupPreview.value = undefined
    const deleted = value.deleted?.length ?? 0
    const failed = value.failed?.length ?? 0
    emit('toast', failed > 0 ? `已清理 ${deleted} 个，${failed} 个删除失败` : `已清理 ${deleted} 个 Worktree`, failed > 0)
    emit('changed')
  } catch (error) {
    emit('toast', `清理失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    cleanupLoading.value = false
  }
}

function cleanupDetail(candidate: WorktreeCleanupCandidate): string {
  const details = [
    candidate.staged ? '有暂存改动' : '',
    candidate.unstaged ? '有未提交改动' : '',
    candidate.merging ? '正在合并' : '',
    candidate.ahead > 0 ? `领先上游 ${candidate.ahead} 个提交` : '',
    candidate.inspectionError ? '状态检查失败' : '',
  ].filter(Boolean)
  return details.join(' · ') || '需要人工确认'
}

watch(() => props.workers, workers => {
  if (draggedId.value === undefined) displayedWorkers.value = [...workers]
}, { immediate: true })

watch(() => form.type, (type, previous) => {
  if (type === 'dsh') {
    form.enabled = true
    form.provider ||= 'deepseek-official'
    form.model ||= 'deepseek-v4-flash'
    form.reasoningEffort = ''
    form.apiKeyEnv ||= 'DEEPSEEK_API_KEY'
  } else if (type === 'codex') {
    form.enabled = typeAvailable.value
    form.provider = undefined
    if (previous === 'dsh') form.model = undefined
    form.reasoningEffort = ''
    if (previous === 'dsh') {
      form.baseUrl = undefined
      form.searchBaseUrl = undefined
    }
    form.apiKeyEnv = undefined
  } else {
    form.enabled = false
    form.provider = undefined
    form.model = undefined
    form.reasoningEffort = ''
    form.baseUrl = undefined
    form.searchBaseUrl = undefined
    form.apiKeyEnv = 'ANTHROPIC_API_KEY'
  }
})

watch([dialogOpen, () => form.type, () => form.provider], ([open]) => {
  if (open) void loadModelCatalog()
})

async function loadModelCatalog(): Promise<void> {
  const requestId = ++modelRequest
  modelLoading.value = true
  modelError.value = ''
  try {
    const query = new URLSearchParams({ type: form.type })
    if (form.provider?.trim()) query.set('provider', form.provider.trim())
    const response = await fetch(`/api/worker-models?${query}`)
    const value = await response.json() as { catalog?: WorkerModelCatalog; error?: string }
    if (!response.ok || value.catalog === undefined) throw new Error(value.error ?? `HTTP ${response.status}`)
    if (requestId === modelRequest) modelCatalog.value = value.catalog
  } catch (error) {
    if (requestId === modelRequest) {
      modelCatalog.value = undefined
      modelError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (requestId === modelRequest) modelLoading.value = false
  }
}

function openCreate(): void {
  editing.value = undefined
  Object.assign(form, {
    name: '', type: 'dsh', enabled: true,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: '', baseUrl: '', searchBaseUrl: '', apiKeyMode: 'value', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '',
  })
  dialogOpen.value = true
}

function openEdit(worker: WorkerConfig): void {
  editing.value = worker
  Object.assign(form, {
    name: worker.name, type: worker.type, enabled: worker.enabled,
    provider: worker.provider, model: worker.model, reasoningEffort: worker.reasoningEffort ?? '', baseUrl: worker.baseUrl, searchBaseUrl: worker.searchBaseUrl, apiKeyMode: worker.apiKeyMode, apiKeyEnv: worker.apiKeyEnv, apiKey: '',
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

function startDrag(event: DragEvent, worker: WorkerConfig): void {
  if (!worker.enabled || reordering.value) return
  draggedId.value = worker.id
  dragOverId.value = worker.id
  event.dataTransfer?.setData('text/plain', worker.id)
  if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move'
}

function dragOver(event: DragEvent, worker: WorkerConfig): void {
  if (draggedId.value === undefined || !worker.enabled) return
  event.preventDefault()
  if (worker.id === dragOverId.value) return
  const from = displayedWorkers.value.findIndex(candidate => candidate.id === draggedId.value)
  const to = displayedWorkers.value.findIndex(candidate => candidate.id === worker.id)
  if (from < 0 || to < 0) return
  const reordered = [...displayedWorkers.value]
  const [dragged] = reordered.splice(from, 1)
  reordered.splice(to, 0, dragged!)
  displayedWorkers.value = reordered
  dragOverId.value = worker.id
}

function cancelDrag(): void {
  draggedId.value = undefined
  dragOverId.value = undefined
  displayedWorkers.value = [...props.workers]
}

function dropOrder(event: DragEvent): void {
  event.preventDefault()
  const ids = displayedWorkers.value.map(worker => worker.id)
  draggedId.value = undefined
  dragOverId.value = undefined
  void saveOrder(ids)
}

async function saveOrder(ids: string[]): Promise<void> {
  if (reordering.value || ids.every((id, index) => props.workers[index]?.id === id)) return
  reordering.value = true
  try {
    const response = await fetch('/api/workers/order', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    const value = await response.json() as { error?: string }
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
    emit('toast', 'Worker 顺序已保存')
    emit('changed')
  } catch (error) {
    displayedWorkers.value = [...props.workers]
    emit('toast', `排序失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    reordering.value = false
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
  if (worker.type === 'codex') return '本机配置'
  if (worker.credentialSource === 'saved') return '已保存'
  if (worker.credentialSource === 'environment') return '环境变量'
  return '未配置'
}

function workerAvailable(worker: WorkerConfig): boolean {
  return worker.enabled && props.workerTypes.find(status => status.type === worker.type)?.available === true
}

function workerStatus(worker: WorkerConfig): string {
  if (!worker.enabled) return '未启用'
  return workerAvailable(worker) ? '可用' : '不可用'
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col">
    <div class="h-40px flex-none flex items-center px-14px b-b b-b-solid b-b-line text-13px font-600 text-fg">
      设置
    </div>
    <div class="flex-1 min-h-0 grid grid-cols-[144px_minmax(0,1fr)]">
      <aside class="min-h-0 b-r b-r-solid b-r-line p-6px">
        <button class="w-full h-30px flex items-center gap-7px rounded px-8px text-12px font-500 text-left hover:bg-alt" :class="section === 'repository' ? 'bg-alt text-fg' : 'text-secondary'" @click="section = 'repository'">
          <Icon name="repository" :size="12" />仓库管理
        </button>
        <button class="mt-1px w-full h-30px flex items-center gap-7px rounded px-8px text-12px font-500 text-left hover:bg-alt" :class="section === 'workers' ? 'bg-alt text-fg' : 'text-secondary'" @click="section = 'workers'">
          <Icon name="settings" :size="12" />Workers
        </button>
      </aside>

      <section v-if="section === 'repository'" class="min-w-0 min-h-0 flex flex-col">
        <div class="h-40px flex-none flex items-center gap-8px px-12px b-b b-b-solid b-b-line">
          <span class="text-12.5px font-600 text-fg">仓库管理</span><span class="text-11px text-muted">dshw、主仓库与 Worktree</span>
        </div>

        <div class="flex-1 min-h-0 overflow-auto">
          <div class="mx-auto w-full max-w-760px p-20px">
            <div class="b b-solid b-line rounded overflow-hidden">
              <div class="min-h-64px flex items-center gap-12px px-14px">
                <div class="h-28px w-28px grid place-items-center rounded bg-widget text-secondary"><Icon name="download" :size="14" :class="{ 'animate-pulse': updatingDshw }" /></div>
                <div class="flex-1 min-w-0"><div class="flex items-center gap-7px text-12.5px font-500 text-fg"><span>更新 dshw</span><span class="text-10.5px font-400" :class="(dshwRepository.behind ?? 0) > 0 || dshwRepository.dirty ? 'text-warn' : 'text-muted'">{{ dshwRepositoryLag }}</span></div><div class="mt-1px text-11px text-muted">拉取最新代码、安装依赖并重新构建，然后安全重启服务</div></div>
                <button class="btn btn-default" :disabled="devMode || dshwRepository.state !== 'ready' || dshwRepository.dirty || updatingDshw || updating || reconfiguring || cleanupLoading" :title="devMode ? '开发模式下不可用' : dshwRepository.dirty ? '请先处理 dshw 仓库中的本地修改' : ''" @click="emit('updateDshw')">{{ updatingDshw ? '更新并重启中' : '更新并重启' }}</button>
              </div>
              <div class="min-h-64px flex items-center gap-12px px-14px b-t b-t-solid b-t-line">
                <div class="h-28px w-28px grid place-items-center rounded bg-widget text-secondary"><Icon name="sync" :size="14" :class="{ 'animate-spin': updating }" /></div>
                <div class="flex-1 min-w-0"><div class="flex items-center gap-7px text-12.5px font-500 text-fg"><span>同步主仓库</span><span class="text-10.5px font-400" :class="(repository.behind ?? 0) > 0 ? 'text-warn' : 'text-muted'">{{ repositoryLag }}</span></div><div class="mt-1px text-11px text-muted">更新 deepseek-harness 仓库到最新上游</div></div>
                <button class="btn btn-default" :disabled="updatingDshw || updating || reconfiguring || cleanupLoading" @click="emit('updateHarness')">{{ updating ? '同步中' : '立即同步' }}</button>
              </div>
              <div class="min-h-64px flex items-center gap-12px px-14px b-t b-t-solid b-t-line">
                <div class="h-28px w-28px grid place-items-center rounded bg-widget text-secondary"><Icon name="worktree" :size="14" /></div>
                <div class="flex-1 min-w-0"><div class="flex items-center gap-7px text-12.5px font-500 text-fg"><span>清理 Worktree</span><span class="text-10.5px font-400 text-muted">{{ worktreeSummary }}</span></div><div class="mt-1px text-11px text-muted">删除不再对应 active PR 的 Worktree；本地内容会逐项确认</div></div>
                <button class="btn btn-default" :disabled="updatingDshw || updating || reconfiguring || cleanupLoading" @click="inspectWorktreeCleanup">{{ cleanupLoading ? '检查中' : '检查并清理' }}</button>
              </div>
              <div class="min-h-64px flex items-center gap-12px px-14px b-t b-t-solid b-t-line">
                <div class="h-28px w-28px grid place-items-center rounded bg-widget text-secondary"><Icon name="reset" :size="14" :class="{ 'animate-spin': reconfiguring }" /></div>
                <div class="flex-1 min-w-0"><div class="text-12.5px font-500 text-fg">重新初始化工作环境</div><div class="mt-1px text-11px text-muted">清理生成文件，更新 master，重新安装依赖并运行 typecheck</div></div>
                <button class="btn btn-default" :disabled="updatingDshw || updating || reconfiguring || cleanupLoading" @click="confirmReconfigure">{{ reconfiguring ? '配置中' : '从头配置' }}</button>
              </div>
              <div v-if="update.lastStatus !== 'failed'" class="min-h-32px flex items-center gap-6px px-14px b-t b-t-solid b-t-line bg-widget text-muted text-10.5px">
                <Icon name="history" :size="11" /><span class="truncate" :title="updateResult">{{ updateResult }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-else class="min-w-0 min-h-0 flex flex-col">
        <div class="h-40px flex-none flex items-center justify-between gap-12px px-12px b-b b-b-solid b-b-line">
          <div class="flex items-center gap-8px"><span class="text-12.5px font-600 text-fg">Workers</span><span class="text-11px text-muted">拖动排序 · 第一项为默认</span></div>
          <button class="btn btn-primary" @click="openCreate"><Icon name="plus" :size="12" />添加</button>
        </div>

        <div v-if="workers.length === 0" class="empty-state">
          <span>暂无 Worker</span>
          <button class="text-link cursor-pointer hover:underline" @click="openCreate">添加配置</button>
        </div>
        <div v-else class="flex-1 min-h-0 overflow-auto">
          <table class="w-full min-w-900px border-collapse table-fixed">
            <thead><tr>
              <th class="w-34px" :class="thClass"></th>
              <th class="w-110px" :class="thClass">状态</th>
              <th class="w-220px" :class="thClass">名称</th>
              <th class="w-140px" :class="thClass">类型</th>
              <th :class="thClass">模型</th>
              <th class="w-110px" :class="thClass">推理</th>
              <th :class="thClass">Base URL</th>
              <th class="w-130px" :class="thClass">凭据</th>
              <th class="w-90px" :class="thClass"></th>
            </tr></thead>
            <tbody>
              <tr
                v-for="(worker, index) in displayedWorkers"
                :key="worker.id"
                :draggable="worker.enabled && !reordering"
                class="transition-[background-color,opacity] duration-100 hover:bg-alt"
                :class="{ 'opacity-45': draggedId === worker.id, 'cursor-grabbing': draggedId === worker.id }"
                @dragstart="startDrag($event, worker)"
                @dragover="dragOver($event, worker)"
                @drop="dropOrder"
                @dragend="draggedId !== undefined && cancelDrag()"
              >
                <td :class="tdClass"><Icon name="grip" :size="13" :class="worker.enabled ? 'text-muted cursor-grab' : 'text-faint'" /></td>
                <td :class="tdClass">
                  <span class="inline-flex items-center gap-6px text-11.5px" :class="workerAvailable(worker) ? 'st-ok' : 'st-neutral'">
                    <StatusDot :tone="workerAvailable(worker) ? 'ok' : 'neutral'" />{{ workerStatus(worker) }}
                  </span>
                </td>
                <td :class="tdClass">
                  <div class="flex items-center gap-6px min-w-0"><span class="truncate text-12.5px font-500 text-fg">{{ worker.name }}</span><span v-if="index === 0 && worker.enabled" class="badge">默认</span></div>
                </td>
                <td :class="tdClass"><span class="text-12px text-secondary">{{ typeLabel(worker.type) }}</span><span v-if="worker.type === 'claude-code'" class="ml-6px text-10.5px text-muted">未支持</span></td>
                <td :class="tdClass"><span class="block truncate font-mono text-11.5px text-secondary" :title="worker.model">{{ worker.model || '—' }}</span></td>
                <td :class="tdClass"><span class="font-mono text-11.5px text-secondary">{{ worker.reasoningEffort || '默认' }}</span></td>
                <td :class="tdClass"><span class="block truncate font-mono text-11.5px text-secondary" :title="worker.baseUrl">{{ worker.type === 'dsh' ? worker.baseUrl || '默认' : '—' }}</span></td>
                <td :class="tdClass"><span class="inline-flex items-center gap-5px text-11.5px" :class="worker.hasApiKey ? 'text-secondary' : 'text-warn'"><Icon name="key" :size="11" />{{ credentialLabel(worker) }}</span></td>
                <td :class="tdClass"><div class="flex justify-end gap-2px"><button class="icon-btn" aria-label="编辑" @click="openEdit(worker)"><Icon name="edit" :size="12" /></button><button class="icon-btn hover:!text-danger" aria-label="删除" :disabled="removing === worker.id" @click="remove(worker)"><Icon name="trash" :size="12" /></button></div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>

  <div v-if="cleanupDialogOpen && cleanupPreview" class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay" role="presentation" @click.self="cleanupDialogOpen = false">
    <section class="w-[min(620px,100%)] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop" role="dialog" aria-modal="true">
      <header class="h-48px flex items-center justify-between px-14px b-b b-b-solid b-b-line"><div><h2 class="m-0 text-13.5px font-600">清理 Worktree</h2></div><button class="icon-btn" aria-label="关闭" @click="cleanupDialogOpen = false"><Icon name="close" :size="15" /></button></header>
      <div class="p-14px">
        <p class="m-0 text-11.5px text-muted">只处理不再对应 active PR、且没有运行中任务占用的 Worktree。{{ cleanWorktreeCount > 0 ? `${cleanWorktreeCount} 个无本地内容的 Worktree 将直接删除。` : '' }}</p>
        <div class="mt-12px mb-5px text-10.5px font-600 text-secondary">需要确认的本地内容</div>
        <div class="max-h-320px overflow-auto b b-solid b-line rounded">
          <div v-for="candidate in riskyWorktrees" :key="candidate.name" class="min-h-52px flex items-center gap-10px px-10px b-b b-b-solid b-b-line last:b-b-0">
            <Icon name="worktree" :size="13" class="text-secondary" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-7px"><span class="font-mono text-11.5px font-500 text-fg">{{ candidate.name }}</span><span class="truncate text-10.5px text-muted">{{ candidate.branch }}</span></div>
              <div class="mt-1px truncate text-10.5px text-warn" :title="candidate.inspectionError">{{ cleanupDetail(candidate) }}</div>
            </div>
            <select v-model="cleanupDecisions[candidate.name]" class="h-28px w-148px rounded b b-solid b-line bg-surface px-7px text-11.5px outline-none focus:b-accent">
              <option value="keep">保留</option>
              <option value="delete">删除并丢弃</option>
            </select>
          </div>
        </div>
      </div>
      <footer class="h-48px flex items-center justify-between gap-6px px-12px b-t b-t-solid b-t-line"><span class="text-10.5px text-muted">选择删除后不会保留 stash 或本地分支</span><div class="flex gap-6px"><button class="btn btn-ghost" :disabled="cleanupLoading" @click="cleanupDialogOpen = false">取消</button><button class="btn btn-primary" :disabled="cleanupLoading || cleanupDeleteCount === 0" @click="executeWorktreeCleanup(riskyWorktrees.filter(candidate => cleanupDecisions[candidate.name] === 'delete').map(candidate => candidate.name))">{{ cleanupLoading ? '清理中' : `清理 ${cleanupDeleteCount} 个` }}</button></div></footer>
    </section>
  </div>

  <div v-if="dialogOpen" class="fixed inset-0 z-60 grid place-items-center p-24px bg-overlay" role="presentation" @click.self="dialogOpen = false">
    <section class="w-[min(560px,100%)] overflow-hidden b b-solid b-line rounded bg-surface shadow-pop" role="dialog" aria-modal="true">
      <header class="h-48px flex items-center justify-between px-14px b-b b-b-solid b-b-line"><h2 class="m-0 text-13.5px font-600">{{ title }}</h2><button class="icon-btn" aria-label="关闭" @click="dialogOpen = false"><Icon name="close" :size="15" /></button></header>
      <div class="grid grid-cols-2 gap-x-12px gap-y-11px p-14px">
        <div class="col-span-2 text-10.5px font-600 uppercase tracking-[0.05em] text-muted">基本</div>
        <label class="col-span-2 text-11.5px text-secondary"><span class="block mb-4px">名称</span><input v-model="form.name" :class="fieldClass" placeholder="例如：日常 dsh" autofocus></label>
        <label class="text-11.5px text-secondary"><span class="block mb-4px">类型</span><select v-model="form.type" :class="fieldClass"><option value="dsh">dsh</option><option value="codex" :disabled="codexStatus?.available !== true">Codex{{ codexStatus?.available === true ? '' : '（不可用）' }}</option><option value="claude-code" disabled>Claude Code（未支持）</option></select></label>
        <label class="flex items-end pb-6px gap-6px text-11.5px text-secondary"><input v-model="form.enabled" type="checkbox" :disabled="!typeAvailable">启用</label>
        <div v-if="codexStatus?.available !== true" class="col-span-2 text-11px text-muted">{{ codexStatus?.reason ?? '未检测到本机 Codex CLI' }}</div>
        <div class="col-span-2 mt-2px text-10.5px font-600 uppercase tracking-[0.05em] text-muted">模型</div>
        <label v-if="form.type === 'dsh'" class="text-11.5px text-secondary"><span class="block mb-4px">Provider</span><input v-model="form.provider" :class="fieldClass" placeholder="deepseek-official"></label>
        <label class="text-11.5px text-secondary" :class="form.type === 'codex' ? 'col-span-2' : ''"><span class="block mb-4px">模型{{ form.type === 'codex' ? '（可选）' : '' }}</span><input v-model="form.model" list="worker-model-options" :class="fieldClass" :placeholder="modelPlaceholder"><datalist id="worker-model-options"><option v-for="model in modelCatalog?.models" :key="model.id" :value="model.id">{{ model.name }}</option></datalist></label>
        <label class="col-span-2 text-11.5px text-secondary"><span class="block mb-4px">推理强度</span><select v-model="form.reasoningEffort" :class="fieldClass"><option value="">{{ effectiveDefaultEffort === undefined ? '使用默认值' : `默认（${effectiveDefaultEffort}）` }}</option><option v-for="effort in reasoningEffortOptions" :key="effort.id" :value="effort.id">{{ effort.name }}</option></select></label>
        <div v-if="modelLoading" class="col-span-2 text-11px text-muted">正在读取可用模型…</div>
        <div v-else-if="modelError" class="col-span-2 text-11px text-warn">模型列表读取失败：{{ modelError }}</div>
        <template v-if="form.type === 'dsh'">
          <div class="col-span-2 mt-2px text-10.5px font-600 uppercase tracking-[0.05em] text-muted">连接</div>
          <label class="col-span-2 text-11.5px text-secondary"><span class="block mb-4px">Base URL</span><input v-model="form.baseUrl" type="url" :class="fieldClass" placeholder="留空则使用 DEEPSEEK_BASE_URL"></label>
          <label class="col-span-2 text-11.5px text-secondary"><span class="block mb-4px">Search Base URL</span><input v-model="form.searchBaseUrl" type="url" :class="fieldClass" placeholder="留空则使用 DEEPSEEK_SEARCH_BASE_URL"></label>
          <label class="text-11.5px text-secondary"><span class="block mb-4px">API Key 来源</span><select v-model="form.apiKeyMode" :class="fieldClass"><option value="value">直接输入</option><option value="environment">环境变量</option></select></label>
          <label v-if="form.apiKeyMode === 'value'" class="text-11.5px text-secondary"><span class="block mb-4px">API Key</span><input v-model="form.apiKey" type="password" autocomplete="new-password" :class="fieldClass" :placeholder="hasSavedApiKey ? '已保存；留空不变' : '输入 API Key'"></label>
          <label v-else class="text-11.5px text-secondary"><span class="block mb-4px">环境变量</span><input v-model="form.apiKeyEnv" :class="fieldClass" placeholder="DEEPSEEK_API_KEY"></label>
        </template>
      </div>
      <footer class="h-48px flex items-center justify-end gap-6px px-12px b-t b-t-solid b-t-line"><button class="btn btn-ghost" @click="dialogOpen = false">取消</button><button class="btn btn-primary" :disabled="saving || !formValid" @click="save">{{ saving ? '保存中' : '保存' }}</button></footer>
    </section>
  </div>
</template>
