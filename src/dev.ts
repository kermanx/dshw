import { join } from 'node:path'
import { createServer } from 'vite'
import { DSHW_ROOT, HOST } from './config.ts'
import { run } from './util.ts'

const DEFAULT_DEV_PORT = 7850

export async function runDevPreview(): Promise<void> {
  const port = parseDevPort(process.env.DSHW_DEV_PORT)
  const server = await createServer({
    configFile: join(DSHW_ROOT, 'vite.config.ts'),
    server: { port },
  })
  await server.listen()
  server.printUrls()
  console.log('dshw Vue UI dev server：Vite HMR 已启用；API 只读代理到正式 daemon')
  await run('open', [`http://${HOST}:${port}`])
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await server.close()
}

function parseDevPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DEV_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`DSHW_DEV_PORT 无效：${value}`)
  return port
}
