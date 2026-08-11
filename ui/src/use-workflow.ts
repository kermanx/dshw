import { onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { DshWorkerProgress, WorkflowSnapshot } from './types.ts'

export function useWorkflow() {
  const snapshot = shallowRef<WorkflowSnapshot>()
  const connection = ref<'connecting' | 'live' | 'reconnecting'>('connecting')
  let stream: EventSource | undefined
  let refreshTimer: number | undefined

  const setSnapshot = (value: WorkflowSnapshot): void => {
    snapshot.value = value
  }

  const load = async (): Promise<void> => {
    const response = await fetch('/api/state')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    setSnapshot(await response.json() as WorkflowSnapshot)
  }

  onMounted(() => {
    void load().catch(() => { connection.value = 'reconnecting' })
    refreshTimer = window.setInterval(() => void load().catch(() => {}), 30_000)
    stream = new EventSource('/api/events')
    stream.onopen = () => { connection.value = 'live' }
    stream.onmessage = event => setSnapshot(JSON.parse(event.data) as WorkflowSnapshot)
    stream.addEventListener('progress', event => {
      if (snapshot.value === undefined) return
      snapshot.value = {
        ...snapshot.value,
        jobProgress: JSON.parse((event as MessageEvent<string>).data) as Record<string, DshWorkerProgress>,
      }
    })
    stream.onerror = () => { connection.value = 'reconnecting' }
  })

  onUnmounted(() => {
    if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
    stream?.close()
  })

  return { snapshot, connection, load }
}
