<script setup lang="ts">
import { computed } from 'vue'
import { relativeTime } from '../format.ts'
import type { ReviewRequestRecord } from '../types.ts'

const props = defineProps<{ requests: ReviewRequestRecord[] }>()
const ordered = computed(() => [...props.requests].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)))

const thClass = 'h-30px px-12px b-b b-b-solid b-b-line bg-surface text-secondary text-11px font-500 uppercase tracking-[0.05em] text-left whitespace-nowrap sticky top-0 z-1'
const tdClass = 'h-46px px-12px py-6px align-middle'
</script>

<template>
  <div v-if="requests.length === 0" class="empty-state">
    <p class="m-0 text-secondary text-13px">没有待你 review 的 PR</p>
    <p class="m-0 text-muted">GitHub 上 request 你 review 的 open PR 会显示在这里</p>
  </div>
  <div v-else class="h-full overflow-auto">
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
</template>
