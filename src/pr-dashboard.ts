import type { PrDashboardRecord, SyncRecord } from './types.ts'

/** Overlay mutable sync fields onto the slower GitHub dashboard cache. */
export function mergePrDashboardSyncState(
  records: readonly PrDashboardRecord[],
  syncs: readonly SyncRecord[],
): PrDashboardRecord[] {
  const syncByPr = new Map(syncs.map(sync => [`${sync.repoSlug}\n${sync.prNumber}`, sync]))
  return records.map(record => {
    const {
      syncId: _syncId,
      syncEnabled: _syncEnabled,
      pendingBaseCheckAt: _pendingBaseCheckAt,
      agentPausedReason: _agentPausedReason,
      ...stable
    } = record
    const sync = syncByPr.get(`${record.repoSlug}\n${record.number}`)
    if (sync === undefined) return stable
    return {
      ...stable,
      syncId: sync.id,
      syncEnabled: sync.enabled !== false,
      ...(sync.pendingBaseCheckAt === undefined ? {} : { pendingBaseCheckAt: sync.pendingBaseCheckAt }),
      ...(sync.agentPausedReason === undefined ? {} : { agentPausedReason: sync.agentPausedReason }),
    }
  })
}
