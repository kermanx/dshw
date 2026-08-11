import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DSHW_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const UI_DIST_ROOT = join(DSHW_ROOT, 'ui', 'dist')
export const WORKFLOW_ROOT = dirname(DSHW_ROOT)
export const CLONES_ROOT = join(WORKFLOW_ROOT, 'clones')
export const CODE_WORKSPACE_FILE = join(WORKFLOW_ROOT, 'dsh-workflow.code-workspace')
export const HARNESS_ROOT = join(WORKFLOW_ROOT, 'deepseek-harness')
const DEFAULT_DATA_ROOT = join(WORKFLOW_ROOT, '.dshw')
export const DATA_ROOT = resolve(process.env.DSHW_DATA_ROOT ?? DEFAULT_DATA_ROOT)
export const CLONE_METADATA_ROOT = resolve(process.env.DSHW_CLONE_METADATA_ROOT ?? join(DEFAULT_DATA_ROOT, 'clones'))
export const STATE_FILE = join(DATA_ROOT, 'state.json')
export const LOG_ROOT = join(DATA_ROOT, 'logs')
export const WORKER_ROOT = join(DATA_ROOT, 'workers')
export const SERVICE_LABEL = 'com.deepseek-harness.dshw'
export const SERVICE_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
export const PORT = parsePort(process.env.DSHW_PORT)
export const HOST = '127.0.0.1'
export const DEV_MODE = process.env.DSHW_DEV_MODE === '1'
export const WORKSPACE_ROOT = resolve(homedir(), 'workspace')
export const REF_WATCH_INTERVAL_MS = 60 * 1000
export const PR_WATCH_INTERVAL_MS = 60 * 1000
export const PR_DISCOVERY_INTERVAL_MS = 60 * 1000
export const PR_DASHBOARD_INTERVAL_MS = 60 * 1000
export const WORKSPACE_REFRESH_INTERVAL_MS = 5 * 60 * 1000
export const CI_WATCH_INTERVAL_MS = 30 * 1000
export const BASE_DEBOUNCE_MS = 10 * 60 * 1000
export const BASE_DEBOUNCE_MAX_MS = 30 * 60 * 1000

function parsePort(value: string | undefined): number {
  if (value === undefined) return 7849
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DSHW_PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}`)
  }
  return port
}
