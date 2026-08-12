import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_ROOT, HOST, LOG_ROOT, PORT, SERVICE_LABEL, WORKER_ROOT } from './config.ts'
import { loadWorkerPrompt } from './dsh.ts'
import type { SyncRecord, WorkerExecutionConfig, WorkerHandle, WorkerRunRecord } from './types.ts'
import { escapeXml, id, now, run, runOrThrow, writeJsonAtomic } from './util.ts'

export interface CodexWorkerRequest {
  runId: string
  resultPath: string
  progressUrl: string
  controlSocketPath: string
  eventLogPath: string
  outputLogPath: string
  codexExecutable: string
  sync: SyncRecord
  kind: WorkerRunRecord['kind']
  prompt: string
  worker: { model?: string; reasoningEffort?: string }
}

export async function startCodexWorker(
  sync: SyncRecord,
  kind: WorkerRunRecord['kind'],
  worker: WorkerExecutionConfig,
  codexExecutable: string,
  additionalInstruction?: string,
): Promise<WorkerHandle> {
  const runId = id('codex')
  const directory = join(WORKER_ROOT, runId)
  const requestPath = join(directory, 'request.json')
  const resultPath = join(directory, 'result.json')
  const plistPath = join(directory, 'worker.plist')
  const installationKey = createHash('sha256').update(DATA_ROOT).digest('hex').slice(0, 10)
  const controlRoot = join(process.platform === 'darwin' ? '/tmp' : tmpdir(), `dshw-${installationKey}`)
  const controlSocketPath = join(controlRoot, `${runId}.sock`)
  const eventLogPath = join(directory, 'session-events.ndjson')
  const outputLogPath = join(LOG_ROOT, `${runId}.log`)
  await mkdir(directory, { recursive: true })
  await mkdir(controlRoot, { recursive: true, mode: 0o700 })
  await chmod(controlRoot, 0o700)
  const request: CodexWorkerRequest = {
    runId,
    resultPath,
    progressUrl: `http://${HOST}:${PORT}/api/worker-progress`,
    controlSocketPath,
    eventLogPath,
    outputLogPath,
    codexExecutable,
    sync: structuredClone(sync),
    kind,
    prompt: await loadWorkerPrompt(sync, kind, additionalInstruction),
    worker: { model: worker.model, reasoningEffort: worker.reasoningEffort },
  }
  await writeJsonAtomic(requestPath, request)
  const label = `${SERVICE_LABEL}.worker.${runId}`
  const domain = `gui/${uid()}/${label}`
  const workerScript = fileURLToPath(new URL('./codex-session-worker.ts', import.meta.url))
  const path = process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${escapeXml(label)}</string>
  <key>ProgramArguments</key><array><string>${escapeXml(process.execPath)}</string><string>${escapeXml(workerScript)}</string><string>${escapeXml(requestPath)}</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(sync.clonePath)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${escapeXml(path)}</string>
    <key>HOME</key><string>${escapeXml(process.env.HOME ?? homedir())}</string>
    ${process.env.CODEX_HOME === undefined ? '' : `<key>CODEX_HOME</key><string>${escapeXml(process.env.CODEX_HOME)}</string>`}
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(join(directory, 'worker.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(directory, 'worker.stderr.log'))}</string>
</dict></plist>
`
  await writeFile(plistPath, plist, { mode: 0o600 })
  await runOrThrow('launchctl', ['bootstrap', `gui/${uid()}`, plistPath])
  try {
    await runOrThrow('launchctl', ['kickstart', domain])
  } catch (error) {
    await run('launchctl', ['bootout', domain])
    throw error
  }
  return {
    runId,
    label,
    domain,
    plistPath,
    requestPath,
    resultPath,
    controlSocketPath,
    eventLogPath,
    workerType: 'codex',
    progressProtocol: 'session-control-v1',
    startedAt: now(),
  }
}

function uid(): number {
  if (process.getuid === undefined) throw new Error('Codex worker 目前只支持 macOS/Unix')
  return process.getuid()
}
