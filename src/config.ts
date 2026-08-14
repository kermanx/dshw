import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DSHW_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_DATA_ROOT = join(DSHW_ROOT, '.dshw')
export const DATA_ROOT = resolve(process.env.DSHW_DATA_ROOT ?? DEFAULT_DATA_ROOT)
export const HARNESS_ROOT = resolve(process.env.DSHW_HARNESS_ROOT ?? join(DATA_ROOT, 'managed', 'deepseek-harness'))
/** dshw's tested Harness control-plane ABI. Upgrading it is an explicit source change. */
export const HARNESS_RUNTIME_COMMIT = process.env.DSHW_HARNESS_RUNTIME_COMMIT ?? '694dd8d08725f10d31db56486f7f7477a7bd8b6a'
export const HARNESS_RUNTIME_ROOT = resolve(
  process.env.DSHW_HARNESS_RUNTIME_ROOT ?? join(DATA_ROOT, 'runtime', 'deepseek-harness', HARNESS_RUNTIME_COMMIT),
)
export const HARNESS_RUNTIME_FILE = join(DATA_ROOT, 'runtime', `${HARNESS_RUNTIME_COMMIT}.json`)
export const CLONES_ROOT = resolve(process.env.DSHW_CLONES_ROOT ?? join(DATA_ROOT, 'worktrees'))
export const CLONE_METADATA_ROOT = resolve(process.env.DSHW_CLONE_METADATA_ROOT ?? join(DATA_ROOT, 'clones'))
export const CODE_WORKSPACE_FILE = resolve(process.env.DSHW_CODE_WORKSPACE_FILE ?? join(DATA_ROOT, 'dshw.code-workspace'))
export const STATE_FILE = join(DATA_ROOT, 'state.json')
export const LOG_ROOT = join(DATA_ROOT, 'logs')
export const EVENT_LOG_FILE = join(LOG_ROOT, 'events.ndjson')
export const WORKER_CONFIG_FILE = join(DATA_ROOT, 'workers.json')
export const WORKER_SECRET_FILE = join(DATA_ROOT, 'worker-secrets.env')
export const WORKER_ROOT = join(DATA_ROOT, 'workers')
export const INSTALLATION_FILE = join(DATA_ROOT, 'installation.json')
export const MANAGED_HARNESS_FILE = join(DATA_ROOT, 'managed-harness.json')
export const HARNESS_REMOTE_URL = process.env.DSHW_HARNESS_REMOTE_URL ?? 'https://github.com/deepseek-harness/deepseek-harness.git'
export const SERVICE_LABEL = process.env.DSHW_SERVICE_LABEL ?? 'com.deepseek-harness.dshw'
export const SERVICE_PLIST = resolve(process.env.DSHW_SERVICE_PLIST ?? join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`))
export const PORT = parsePort(process.env.DSHW_PORT)
export const HOST = '127.0.0.1'
export const DEV_MODE = process.env.DSHW_DEV_MODE === '1'
export const WORKSPACE_ROOT = resolve(homedir(), 'workspace')
export const REF_WATCH_INTERVAL_MS = 60 * 1000
export const PR_WATCH_INTERVAL_MS = 60 * 1000
export const PR_DISCOVERY_INTERVAL_MS = 5 * 60 * 1000
export const PR_DASHBOARD_INTERVAL_MS = 2 * 60 * 1000
export const PR_REVIEW_INTERVAL_MS = 5 * 60 * 1000
export const DSHW_UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000
export const WORKSPACE_REFRESH_INTERVAL_MS = 5 * 60 * 1000
export const CI_WATCH_INTERVAL_MS = 30 * 1000
export const AGENT_STEER_INTERVAL_MS = 20 * 60 * 1000
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
