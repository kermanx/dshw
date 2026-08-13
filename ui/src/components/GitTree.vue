<script setup lang="ts">
import { CommitGraph } from '@dreamcatcher-tech/commit-graph/dist/esm/index.js'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { shortTime } from '../format.ts'
import type { GitGraphBranch, GitGraphSnapshot } from '../types.ts'
import Icon from './Icon.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ refreshKey: number }>()

const ROW_HEIGHT = 32
const PAGE_SIZE = 100
const GRAPH_NODE_RADIUS = 2
const GRAPH_TOP = ROW_HEIGHT / 2 - GRAPH_NODE_RADIUS * 4
const GRAPH_LEFT_PADDING = 12
const GRAPH_TEXT_GAP = 8
const palette = ['#007acc', '#388a34', '#bf8803', '#a1260d', '#7b61a8', '#00838f', '#ad4e00', '#5b7c19', '#6c5ce7', '#c44569']

const graph = ref<GitGraphSnapshot>()
const reactGraphHost = ref<HTMLElement>()
const graphScroll = ref<HTMLElement>()
const graphWidth = ref(72)
const graphCanvasWidth = ref(72)
const renderedColors = ref<Record<string, string>>({})
const visibleCommitCount = ref(PAGE_SIZE)
const loading = ref(false)
const error = ref('')
const focusedBranchOid = ref<string>()
let controller: AbortController | undefined
let reactRoot: Root | undefined
let widthFrame: number | undefined

const focusedBranch = computed(() => graph.value?.branches.find(branch => branch.oid === focusedBranchOid.value))
const visibleBranches = computed(() => {
  const branches = graph.value?.branches ?? []
  const branch = focusedBranch.value
  if (branch === undefined) return branches
  const master = branches.find(item => item.kind === 'master')
  return branch.kind === 'master' || master === undefined ? [branch] : [master, branch]
})
const focusedCommits = computed(() => {
  const commits = graph.value?.commits ?? []
  const branch = focusedBranch.value
  if (branch === undefined) return commits

  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  function ancestorsOf(tip: string): Set<string> {
    const ancestors = new Set<string>()
    const pending = [tip]
    while (pending.length > 0) {
      const hash = pending.pop()!
      if (ancestors.has(hash)) continue
      const commit = byHash.get(hash)
      if (commit === undefined) continue
      ancestors.add(hash)
      pending.push(...commit.parents)
    }
    return ancestors
  }

  const branchAncestors = ancestorsOf(branch.oid)
  if (branch.kind === 'master') return commits.filter(commit => branchAncestors.has(commit.hash))
  const master = graph.value?.branches.find(item => item.kind === 'master')
  const masterAncestors = master === undefined ? new Set<string>() : ancestorsOf(master.oid)
  const visible = new Set([...branchAncestors, ...masterAncestors])
  return commits.filter(commit => visible.has(commit.hash))
})
const masterOid = computed(() => graph.value?.branches.find(branch => branch.kind === 'master')?.oid)

// Mirrors CommitGraph's public parent/children ordering so pagination always
// cuts between graph rows instead of asking the renderer to reshuffle a page.
const allOrderedCommits = computed(() => {
  const commits = focusedCommits.value
  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const children = new Map(commits.map(commit => [commit.hash, [] as string[]]))
  for (const commit of commits) {
    for (const parent of commit.parents) children.get(parent)?.push(commit.hash)
  }
  const readyOrder = [...commits].sort((left, right) => {
    if (left.hash === masterOid.value) return -1
    if (right.hash === masterOid.value) return 1
    return right.author.timestamp - left.author.timestamp || left.hash.localeCompare(right.hash)
  })
  const seen = new Set<string>()
  const result = [] as typeof commits
  function visit(hash: string): void {
    if (seen.has(hash)) return
    const commit = byHash.get(hash)
    if (commit === undefined) return
    seen.add(hash)
    for (const child of children.get(hash) ?? []) visit(child)
    result.push(commit)
  }
  for (const commit of readyOrder) visit(commit.hash)
  return result
})
const orderedCommits = computed(() => allOrderedCommits.value.slice(0, visibleCommitCount.value))
const hasMoreCommits = computed(() => orderedCommits.value.length < allOrderedCommits.value.length)
const graphHeight = computed(() => orderedCommits.value.length * ROW_HEIGHT)
const graphContentHeight = computed(() => graphHeight.value + (hasMoreCommits.value ? ROW_HEIGHT : 0))
const branchesByOid = computed(() => {
  const result = new Map<string, GitGraphBranch[]>()
  for (const branch of visibleBranches.value) {
    const branches = result.get(branch.oid) ?? []
    branches.push(branch)
    result.set(branch.oid, branches)
  }
  return result
})

function renderCommitGraph(): void {
  const host = reactGraphHost.value
  if (host === undefined || graph.value === undefined) return
  const sourceCommits = orderedCommits.value
  const visible = new Set(sourceCommits.map(commit => commit.hash))
  const commits = sourceCommits.map(commit => ({
    sha: commit.hash,
    commit: {
      author: {
        name: commit.author.name,
        email: commit.author.email,
        // CommitGraph assigns its first column from the newest root. Give the
        // master tip layout priority without changing the displayed timestamp.
        date: commit.hash === masterOid.value
          ? new Date(8_639_999_999_999_999)
          : new Date(commit.author.timestamp),
      },
      message: commit.subject,
    },
    parents: commit.parents.filter(parent => visible.has(parent)).map(sha => ({ sha })),
  }))
  const branchHeads = visibleBranches.value.filter(branch => visible.has(branch.oid)).map(branch => ({
    name: branch.label,
    commit: { sha: branch.oid },
    link: branch.url,
  }))
  reactRoot ??= createRoot(host)
  reactRoot.render(createElement(CommitGraph, {
    commits,
    branchHeads,
    graphStyle: {
      commitSpacing: ROW_HEIGHT,
      branchSpacing: 13,
      branchColors: palette,
      nodeRadius: GRAPH_NODE_RADIUS,
    },
    currentBranch: 'master',
  }))
  if (widthFrame !== undefined) cancelAnimationFrame(widthFrame)
  widthFrame = requestAnimationFrame(() => {
    widthFrame = requestAnimationFrame(() => {
      const svg = host.querySelector('svg')
      const width = svg?.width.baseVal.value
      if (width !== undefined && Number.isFinite(width)) graphCanvasWidth.value = Math.max(44, Math.min(220, width))
      const commitNodes = [...host.querySelectorAll<SVGGElement>('svg g[filter^="url(#filter_"]')]
      const colors: Record<string, string> = {}
      let rightmostNode = 0
      for (const node of commitNodes) {
        const match = node.getAttribute('filter')?.match(/^url\(#filter_(.+)_node\)$/u)
        if (match?.[1] === undefined) continue
        const circle = node.querySelector('circle')
        const color = node.getAttribute('fill') ?? circle?.getAttribute('fill')
        if (color !== null && color !== undefined) colors[match[1]] = color
        const x = Number(circle?.getAttribute('cx'))
        if (Number.isFinite(x)) rightmostNode = Math.max(rightmostNode, x)
      }
      renderedColors.value = colors
      graphWidth.value = Math.max(44, Math.min(
        220,
        GRAPH_LEFT_PADDING + rightmostNode + GRAPH_NODE_RADIUS + GRAPH_TEXT_GAP,
      ))
    })
  })
}

function branchColor(oid: string, fallbackIndex: number): string {
  return renderedColors.value[oid] ?? palette[fallbackIndex % palette.length]!
}

function refStyle(oid: string): Record<string, string> {
  return { '--ref-color': renderedColors.value[oid] ?? palette[0]! }
}

function commitUrl(hash: string): string {
  return `https://github.com/${graph.value?.repoSlug ?? 'deepseek-harness/deepseek-harness'}/commit/${hash}`
}

function commitTime(timestamp: number): string {
  return shortTime(new Date(timestamp).toISOString())
}

function focusBranch(branch: GitGraphBranch): void {
  renderedColors.value = {}
  visibleCommitCount.value = PAGE_SIZE
  focusedBranchOid.value = focusedBranchOid.value === branch.oid ? undefined : branch.oid
  void nextTick(renderCommitGraph)
}

async function load(): Promise<void> {
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/api/git-graph', { cache: 'no-store', signal: controller.signal })
    const value = await response.json() as GitGraphSnapshot & { error?: string }
    if (!response.ok) throw new Error(value.error ?? 'Git tree 加载失败')
    renderedColors.value = {}
    visibleCommitCount.value = PAGE_SIZE
    graph.value = value
    if (focusedBranchOid.value !== undefined && !value.branches.some(branch => branch.oid === focusedBranchOid.value)) {
      focusedBranchOid.value = undefined
    }
    await nextTick()
    renderCommitGraph()
  } catch (cause) {
    if (controller.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}

function loadMoreCommits(): void {
  if (!hasMoreCommits.value) return
  visibleCommitCount.value = Math.min(visibleCommitCount.value + PAGE_SIZE, allOrderedCommits.value.length)
  void nextTick(renderCommitGraph)
}

function onGraphScroll(): void {
  const element = graphScroll.value
  if (element === undefined || !hasMoreCommits.value) return
  if (element.scrollHeight - element.scrollTop - element.clientHeight <= ROW_HEIGHT * 12) loadMoreCommits()
}

watch(reactGraphHost, () => renderCommitGraph())
watch(() => props.refreshKey, () => void load(), { immediate: true })
onBeforeUnmount(() => {
  controller?.abort()
  if (widthFrame !== undefined) cancelAnimationFrame(widthFrame)
  reactRoot?.unmount()
})
</script>

<template>
  <div class="h-full min-h-0 grid grid-cols-[270px_minmax(0,1fr)] bg-surface">
    <aside class="min-h-0 overflow-y-auto b-r b-r-solid b-r-line bg-widget">
      <div class="px-12px py-10px b-b b-b-solid b-b-line">
        <div class="flex items-center gap-6px text-12.5px font-600 text-fg">
          <Icon name="git-graph" :size="14" class="text-accent" />
          <span class="truncate">{{ graph?.repoSlug ?? 'Git tree' }}</span>
        </div>
        <div class="mt-3px text-11.5px text-muted">
          <template v-if="graph">{{ graph.commits.length }} 个提交 · {{ graph.branches.length }} 个分支</template>
          <template v-else>正在读取 Git 历史…</template>
        </div>
      </div>

      <div v-if="graph" class="py-5px">
        <div
          v-for="(branch, index) in graph.branches"
          :key="`${branch.kind}:${branch.name}:${branch.number ?? ''}`"
          role="button"
          tabindex="0"
          class="branch-item group flex gap-8px px-12px py-7px cursor-pointer"
          :class="{ 'branch-item-active': focusedBranchOid === branch.oid }"
          :aria-pressed="focusedBranchOid === branch.oid"
          @click="focusBranch(branch)"
          @keydown.enter.prevent="focusBranch(branch)"
          @keydown.space.prevent="focusBranch(branch)"
        >
          <span class="mt-6px w-7px h-7px rounded-full flex-none" :style="{ background: branchColor(branch.oid, index) }" />
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-5px min-w-0 text-12px font-500 text-fg">
              <template v-if="branch.kind === 'pr' && branch.url">
                <a
                  :href="branch.url"
                  target="_blank"
                  rel="noreferrer"
                  class="branch-pr-link flex-none"
                  @click.stop
                >PR #{{ branch.number }}</a>
                <span class="text-faint">·</span>
                <span class="truncate">{{ branch.name }}</span>
              </template>
              <span v-else class="truncate">{{ branch.name }}</span>
              <span v-if="branch.isDraft" class="badge flex-none">draft</span>
            </span>
            <span v-if="branch.title" class="block mt-1px truncate text-11px text-muted" :title="branch.title">{{ branch.title }}</span>
            <span class="block mt-1px font-mono text-10.5px text-faint">{{ branch.oid.slice(0, 8) }}</span>
          </span>
        </div>
      </div>
    </aside>

    <section class="relative min-h-0 flex flex-col bg-surface">
      <div class="h-36px flex-none flex items-center gap-8px px-12px b-b b-b-solid b-b-line bg-widget text-11.5px text-muted">
        <span class="font-600 text-fg">Commit history</span>
        <template v-if="graph">
          <span class="ml-auto">{{ shortTime(graph.generatedAt) }} 更新</span>
          <span v-if="graph.truncated" class="text-warn">仅显示相关历史</span>
          <span v-if="loading" class="inline-flex items-center gap-5px"><StatusDot tone="accent" pulse />刷新中</span>
        </template>
      </div>

      <div v-if="loading && !graph" class="empty-state">
        <StatusDot tone="accent" pulse />
        <span>正在读取 Git 历史…</span>
      </div>
      <div v-else-if="error" class="empty-state">
        <Icon name="alert" :size="18" class="text-danger" />
        <span class="text-danger">Git tree 加载失败</span>
        <span class="max-w-560px text-center text-11.5px">{{ error }}</span>
        <button class="btn btn-default mt-6px" @click="load">重试</button>
      </div>
      <div
        v-else-if="graph"
        ref="graphScroll"
        class="graph-scroll min-h-0 flex-1 overflow-auto"
        @scroll.passive="onGraphScroll"
      >
        <div class="relative min-w-760px" :style="{ height: `${graphContentHeight}px` }">
          <div
            ref="reactGraphHost"
            class="react-graph pointer-events-none absolute z-2 overflow-hidden"
            :style="{ left: `${GRAPH_LEFT_PADDING}px`, top: `${GRAPH_TOP}px`, width: `${graphCanvasWidth}px`, height: `${Math.max(0, graphHeight - GRAPH_TOP)}px` }"
            aria-hidden="true"
          />

          <div
            v-for="commit in orderedCommits"
            :key="commit.hash"
            class="commit-row group relative z-1 h-32px flex items-center gap-8px pr-12px b-b b-b-solid b-b-line/55"
            :style="{ paddingLeft: `${graphWidth}px` }"
            :title="`${commit.hash}\n${commit.subject}\n${commit.author.name} <${commit.author.email}>`"
          >
            <a
              :href="commitUrl(commit.hash)"
              target="_blank"
              rel="noreferrer"
              class="commit-hash w-58px flex-none font-mono text-10.5px text-faint group-hover:text-muted"
              :title="`在 GitHub 查看 ${commit.hash}`"
            >{{ commit.hash.slice(0, 7) }}</a>
            <template v-for="branch in branchesByOid.get(commit.hash) ?? []" :key="`${branch.kind}:${branch.name}`">
              <a
                v-if="branch.url"
                :href="branch.url"
                target="_blank"
                rel="noreferrer"
                class="ref-chip max-w-240px"
                :style="refStyle(commit.hash)"
                :title="branch.title"
              >
                <span class="font-600">#{{ branch.number }}</span>
                <span class="truncate">{{ branch.name }}</span>
                <span v-if="branch.isDraft" class="opacity-70">draft</span>
              </a>
              <span v-else class="ref-chip" :style="refStyle(commit.hash)">
                {{ branch.name }}
              </span>
            </template>
            <span class="min-w-0 flex-1 truncate text-12px text-fg">{{ commit.subject }}</span>
            <span class="max-w-130px flex-none truncate text-11px text-faint">{{ commit.author.name }}</span>
            <time class="w-70px flex-none text-right text-10.5px text-faint">{{ commitTime(commit.author.timestamp) }}</time>
          </div>
          <button
            v-if="hasMoreCommits"
            class="load-more-row absolute left-0 right-0 h-32px text-11.5px text-muted hover:bg-alt"
            :style="{ top: `${graphHeight}px` }"
            @click="loadMoreCommits"
          >
            加载更多（剩余 {{ allOrderedCommits.length - orderedCommits.length }} 条）
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.graph-scroll { scrollbar-gutter: stable; }
.react-graph :deep(> div) { position: relative; }
.react-graph :deep(> div > div:first-child) { overflow: visible; }
.react-graph :deep(> div > div:nth-child(n + 2)) { display: none !important; }
.react-graph :deep(svg) { position: absolute; inset: 0 auto auto 0; }
/* The library's drop-shadow filter clips curves that travel left to an earlier lane. */
.react-graph :deep(g[filter*="_curved_path_"]) { filter: none; }
.commit-row { transition: background-color 100ms; }
.commit-row:hover { background: var(--hover); }
.commit-hash:hover { color: var(--link); text-decoration: underline; }
.branch-item:hover { background: var(--hover); text-decoration: none; }
.branch-item-active { background: var(--accent-soft); }
.branch-item-active:hover { background: var(--accent-soft); }
.branch-pr-link { color: var(--text); text-decoration: none; }
.branch-pr-link:hover { color: var(--link); text-decoration: underline; }
.ref-chip {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  height: 20px;
  border: 1px solid;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10.5px;
  line-height: 18px;
  text-decoration: none;
  border-color: color-mix(in srgb, var(--ref-color) 38%, white);
  background: color-mix(in srgb, var(--ref-color) 10%, white);
  color: color-mix(in srgb, var(--ref-color) 82%, black);
}
.ref-chip:hover {
  border-color: color-mix(in srgb, var(--ref-color) 60%, white);
  color: color-mix(in srgb, var(--ref-color) 88%, black);
  text-decoration: none;
}
</style>
