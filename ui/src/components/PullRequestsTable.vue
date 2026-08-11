<script setup lang="ts">
import { computed } from 'vue'
import { mergeLabel, mergeTone } from '../format.ts'
import type { JobRecord, PrDashboardRecord } from '../types.ts'
import CiChecks from './CiChecks.vue'
import ReviewDetails from './ReviewDetails.vue'
import StatusDot from './StatusDot.vue'
import StatusIcon from './StatusIcon.vue'
import Icon from './Icon.vue'

const props = defineProps<{ prs: PrDashboardRecord[], jobs: JobRecord[], pending: ReadonlySet<string> }>()
const emit = defineEmits<{
  action: [cloneName: string, action: 'merge-base' | 'merge-base-direct' | 'fix-ci' | 'resolve-comments']
  openJob: [jobId: string]
  openActivity: []
  toggleSync: [cloneName: string, enabled: boolean]
}>()

const busyByPr = computed(() => new Map(props.prs.map(pr => [pr.number, findBusyJob(pr)])))

function findBusyJob(pr: PrDashboardRecord): JobRecord | undefined {
  const running = props.jobs.filter(job => job.status === 'running' && (
    job.syncId === pr.syncId || job.summary.startsWith(`${pr.cloneName} / PR #${pr.number}`)
  ))
  return running.find(job => job.type === 'fix-ci' || job.type === 'merge-base') ?? running[0]
}

function busyLabel(job?: JobRecord): string {
  return job?.type === 'fix-ci' ? '修复 CI' : job?.type === 'merge-base' ? '合并 base' : job?.type === 'resolve-comments' ? '解决评论' : '检查状态'
}

/** 冲突走 dsh agent；可合并但落后 base 走无模型的直接 merge+push。 */
function mergeAction(pr: PrDashboardRecord): 'merge-base' | 'merge-base-direct' | undefined {
  if (pr.mergeable === 'CONFLICTING') return 'merge-base'
  if (pr.mergeable === 'MERGEABLE' && pr.baseBehind === true) return 'merge-base-direct'
  return undefined
}

/** 最近一次自动/手动合并任务失败（且当前可重试）时返回该任务，用于在 Merge 列提示。 */
function lastFailedMerge(pr: PrDashboardRecord): JobRecord | undefined {
  const failed = props.jobs.filter(job => (
    job.syncId === pr.syncId
    && job.type === 'merge-base'
    && (job.status === 'failed' || job.status === 'blocked')
  ))
  return failed.at(-1)
}

/** 冲突但处于 base push 后的静默期：到点会自动开始合并。 */
function autoMergeAt(pr: PrDashboardRecord): string | undefined {
  if (pr.mergeable !== 'CONFLICTING' || pr.syncEnabled !== true || pr.pendingBaseCheckAt === undefined) return undefined
  return Date.parse(pr.pendingBaseCheckAt) > Date.now() ? pr.pendingBaseCheckAt : undefined
}

function autoMergeMinutes(pr: PrDashboardRecord): number {
  const at = autoMergeAt(pr)
  return at === undefined ? 0 : Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 60_000))
}

const thClass = 'h-30px px-12px b-b b-b-solid b-b-line bg-surface text-secondary text-11px font-500 uppercase tracking-[0.05em] text-left whitespace-nowrap sticky top-0 z-1'
const tdClass = 'h-46px px-12px py-6px align-middle'
const actionClass = 'inline-flex items-center gap-5px w-fit text-link text-11.5px cursor-pointer whitespace-nowrap hover:underline disabled:opacity-45 disabled:pointer-events-none'
</script>

<template>
  <div v-if="prs.length === 0" class="empty-state">
    <p class="m-0 text-secondary text-13px">暂无追踪中的 PR</p>
    <p class="m-0 text-muted">GitHub 上你创建的 open PR 会被自动克隆并显示在这里</p>
  </div>
  <div v-else class="h-full overflow-auto">
    <table class="w-full min-w-900px border-collapse table-fixed">
      <thead>
        <tr>
          <th :class="thClass">Pull request</th>
          <th class="w-170px" :class="thClass">CI</th>
          <th class="w-210px" :class="thClass">Review</th>
          <th class="w-150px" :class="thClass">Merge</th>
          <th class="w-110px" :class="thClass">Sync</th>
        </tr>
      </thead>
      <tbody class="[&>tr]:transition-colors [&>tr]:duration-100 [&>tr:hover]:bg-alt">
        <tr v-for="pr in prs" :key="`${pr.repoSlug}-${pr.number}-${pr.cloneName}`" class="group">
          <td :class="tdClass">
            <div class="cell-main">
              <a class="flex items-center gap-6px min-w-0 truncate" :href="pr.url" :title="pr.title" target="_blank">
                <span class="flex-none font-mono text-12px text-muted">#{{ pr.number }}</span>
                <span class="truncate font-500" :class="pr.isDraft ? 'text-secondary' : 'text-fg'">{{ pr.title }}</span>
              </a>
              <span v-if="pr.isDraft" class="badge">草稿</span>
              <Icon class="flex-none text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100" name="external" :size="11" />
            </div>
            <div class="cell-sub font-mono" :title="pr.branch">{{ pr.branch }} → {{ pr.baseRefName }}</div>
          </td>
          <td :class="tdClass">
            <CiChecks :pr="pr">
              <template #default="{ note }">
                <button v-if="busyByPr.get(pr.number)?.type === 'fix-ci'" :class="actionClass" @click="emit('openJob', busyByPr.get(pr.number)!.id)">
                  <StatusDot tone="accent" pulse />
                  修复中 · 查看
                </button>
                <div v-else class="flex items-center gap-5px min-w-0">
                  <span v-if="note" class="truncate text-muted text-11.5px">{{ note }}</span>
                  <template v-if="pr.ciStatus === 'failed' || pr.checks.some(check => check.bucket === 'fail' || check.bucket === 'cancel')">
                    <span v-if="note" class="flex-none text-faint text-11.5px">·</span>
                    <button
                      :class="actionClass"
                      :disabled="pending.has(`fix-ci:${pr.cloneName}`)"
                      @click="emit('action', pr.cloneName, 'fix-ci')"
                    >修 CI</button>
                  </template>
                </div>
              </template>
            </CiChecks>
          </td>
          <td :class="tdClass">
            <ReviewDetails :pr="pr">
              <template #default="{ summary }">
                <button v-if="busyByPr.get(pr.number)?.type === 'resolve-comments'" :class="actionClass" @click="emit('openJob', busyByPr.get(pr.number)!.id)">
                  <StatusDot tone="accent" pulse />
                  解决评论中 · 查看
                </button>
                <div v-else class="flex items-center gap-5px min-w-0">
                  <span class="truncate text-muted text-11.5px" :title="summary">{{ summary }}</span>
                  <template v-if="pr.unresolvedComments !== undefined && pr.unresolvedComments > 0">
                    <span class="flex-none text-faint text-11.5px">·</span>
                    <button
                      :class="actionClass"
                      :disabled="pending.has(`resolve-comments:${pr.cloneName}`)"
                      @click="emit('action', pr.cloneName, 'resolve-comments')"
                    >解决 {{ pr.unresolvedComments }} 条评论</button>
                  </template>
                </div>
              </template>
            </ReviewDetails>
          </td>
          <td :class="tdClass">
            <div class="flex flex-col gap-1px min-w-0">
              <span class="inline-flex items-center gap-6px min-w-0 h-20px text-12.5px whitespace-nowrap" :class="`st-${mergeTone(pr.mergeable)}`">
                <StatusIcon :tone="mergeTone(pr.mergeable)" />
                {{ mergeLabel(pr.mergeable) }}
              </span>
              <button v-if="busyByPr.get(pr.number) && busyByPr.get(pr.number)!.type !== 'fix-ci' && busyByPr.get(pr.number)!.type !== 'resolve-comments'" :class="actionClass" @click="emit('openJob', busyByPr.get(pr.number)!.id)">
                <StatusDot tone="accent" pulse />
                {{ busyLabel(busyByPr.get(pr.number)) }} · 查看
              </button>
              <div v-else-if="autoMergeAt(pr) !== undefined" class="flex items-center gap-5px min-w-0 text-11.5px">
                <span class="flex-none text-muted whitespace-nowrap">约 {{ autoMergeMinutes(pr) }} 分钟</span>
                <span class="flex-none text-faint">·</span>
                <button
                  :class="actionClass"
                  :disabled="pending.has(`merge-base:${pr.cloneName}`)"
                  @click="emit('action', pr.cloneName, 'merge-base')"
                >立即合并</button>
              </div>
              <div v-else-if="mergeAction(pr) !== undefined" class="flex items-center gap-5px min-w-0">
                <template v-if="lastFailedMerge(pr) !== undefined">
                  <span class="flex-none text-warn text-11.5px whitespace-nowrap" :title="lastFailedMerge(pr)!.summary">上次合并失败</span>
                  <span class="flex-none text-faint text-11.5px">·</span>
                </template>
                <button
                  :class="actionClass"
                  :disabled="pending.has(`merge-base:${pr.cloneName}`) || pending.has(`merge-base-direct:${pr.cloneName}`)"
                  @click="emit('action', pr.cloneName, mergeAction(pr)!)"
                >合并 {{ pr.baseRefName }}</button>
              </div>
            </div>
          </td>
          <td :class="tdClass">
            <div class="flex flex-col gap-1px min-w-0">
              <span class="inline-flex items-center gap-8px h-20px">
                <button
                  role="switch"
                  :aria-checked="pr.syncEnabled === true"
                  :aria-label="`PR #${pr.number} 自动 sync`"
                  class="relative inline-flex flex-none w-26px h-14px rounded-full cursor-pointer transition-colors duration-150 disabled:opacity-45 disabled:pointer-events-none"
                  :class="pr.syncEnabled === true ? 'bg-accent' : 'bg-badge'"
                  :disabled="pending.has(`sync-toggle:${pr.cloneName}`)"
                  @click="emit('toggleSync', pr.cloneName, pr.syncEnabled !== true)"
                >
                  <span
                    class="absolute top-2px left-2px w-10px h-10px rounded-full bg-white shadow-sm transition-transform duration-150"
                    :class="{ 'translate-x-12px': pr.syncEnabled === true }"
                  />
                </button>
                <span class="text-12.5px whitespace-nowrap" :class="pr.syncEnabled === true ? 'text-success' : 'text-muted'">{{ pr.syncEnabled === true ? '已开启' : '已关闭' }}</span>
              </span>
              <button
                v-if="pr.agentPausedReason"
                class="inline-flex items-center gap-5px w-fit text-warn text-11.5px cursor-pointer whitespace-nowrap hover:underline"
                :title="pr.agentPausedReason"
                @click="emit('openActivity')"
              >自动任务已暂停 · 查看原因</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
