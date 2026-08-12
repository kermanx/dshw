<script setup lang="ts">
import { computed } from 'vue'
import { relativeTime } from '../format.ts'
import type { PrDashboardStatus, ReviewRequestRecord } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{
  requests: ReviewRequestRecord[]
  status: PrDashboardStatus
  pending: ReadonlySet<string>
}>()
const emit = defineEmits<{ refresh: [], openLogs: [] }>()
const ordered = computed(() => [...props.requests].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)))

const thClass = 'h-30px px-12px b-b b-b-solid b-b-line bg-surface text-secondary text-11px font-500 uppercase tracking-[0.05em] text-left whitespace-nowrap sticky top-0 z-1'
const tdClass = 'h-46px px-12px py-6px align-middle'
const actionClass = 'inline-flex items-center gap-5px w-fit text-link text-11.5px cursor-pointer whitespace-nowrap hover:underline disabled:opacity-45 disabled:pointer-events-none'
</script>

<template>
  <div v-if="status.state === 'loading' && requests.length === 0" class="empty-state">
    <span class="inline-flex items-center gap-7px text-secondary text-13px">
      <StatusDot tone="accent" pulse />
      正在加载待 review 的 PR
    </span>
    <p class="m-0 text-muted">正在从 GitHub 获取 review requests…</p>
  </div>
  <div v-else-if="status.state === 'error' && requests.length === 0" class="empty-state">
    <p class="m-0 text-danger text-13px">Reviews 加载失败</p>
    <p class="m-0 max-w-720px text-muted break-anywhere" :title="status.error">{{ status.error ?? '未知错误' }}</p>
    <span class="inline-flex items-center gap-8px">
      <button :class="actionClass" :disabled="pending.has('prs-refresh')" @click="emit('refresh')">重试</button>
      <span class="text-faint">·</span>
      <button :class="actionClass" @click="emit('openLogs')">查看日志</button>
    </span>
  </div>
  <div v-else-if="requests.length === 0" class="empty-state">
    <p class="m-0 text-secondary text-13px">没有待你 review 的 PR</p>
    <p class="m-0 text-muted">GitHub 上 request 你 review 的 open PR 会显示在这里</p>
  </div>
  <div v-else class="h-full min-h-0 flex flex-col">
    <div v-if="status.state === 'error'" class="flex items-center gap-7px px-12px min-h-32px b-b b-b-solid b-b-line bg-warn-soft text-12px">
      <Icon class="flex-none text-warn" name="alert" :size="13" />
      <span class="flex-none text-secondary">Reviews 刷新失败，正在显示上次可用数据</span>
      <span class="min-w-0 truncate text-muted" :title="status.error">{{ status.error }}</span>
      <button class="ml-auto flex-none text-link cursor-pointer hover:underline" @click="emit('openLogs')">详细原因</button>
    </div>
    <div v-else-if="status.state === 'loading'" class="flex items-center gap-7px px-12px min-h-32px b-b b-b-solid b-b-line bg-alt text-12px">
      <StatusDot tone="accent" pulse />
      <span class="text-secondary">正在刷新上次保存的 Reviews</span>
    </div>
    <div class="flex-1 min-h-0 overflow-auto">
      <table class="w-full min-w-600px border-collapse table-fixed">
      <thead>
        <tr>
          <th :class="thClass">Pull request</th>
          <th class="w-160px" :class="thClass">作者</th>
          <th class="w-110px" :class="thClass">更新于</th>
        </tr>
      </thead>
      <tbody class="[&>tr]:transition-colors [&>tr]:duration-100 [&>tr:hover]:bg-alt">
        <tr v-for="pr in ordered" :key="pr.number">
          <td :class="tdClass">
            <div class="cell-main">
              <a class="flex items-center gap-6px min-w-0 truncate" :href="pr.url" :title="pr.title" target="_blank">
                <span class="flex-none font-mono text-12px text-muted">#{{ pr.number }}</span>
                <span class="truncate font-500" :class="pr.isDraft ? 'text-secondary' : 'text-fg'">{{ pr.title }}</span>
              </a>
              <span v-if="pr.isDraft" class="badge">草稿</span>
            </div>
            <div class="cell-sub font-mono" :title="pr.headRefName">{{ pr.headRefName }} → {{ pr.baseRefName }}</div>
          </td>
          <td :class="tdClass"><span class="text-secondary text-12.5px">@{{ pr.author }}</span></td>
          <td :class="tdClass"><span class="text-muted text-12px whitespace-nowrap">{{ relativeTime(pr.updatedAt) }}</span></td>
        </tr>
      </tbody>
      </table>
    </div>
  </div>
</template>
