import { readFile, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { UI_DIST_ROOT } from './config.ts'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export function resolveUiAssetPath(url: string): string | undefined {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url, 'http://dshw.local').pathname)
  } catch {
    return undefined
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const candidate = resolve(UI_DIST_ROOT, requested)
  const inside = relative(UI_DIST_ROOT, candidate)
  if (inside === '..' || inside.startsWith(`..${sep}`)) return undefined
  return candidate
}

export async function serveUiAsset(url: string, response: ServerResponse): Promise<void> {
  const candidate = resolveUiAssetPath(url)
  if (candidate === undefined) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('invalid UI asset path\n')
    return
  }
  let path = candidate
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file')
  } catch {
    // Vue owns client-side routes; unknown extension-less GETs receive the app shell.
    if (extname(candidate) !== '') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found\n')
      return
    }
    path = resolve(UI_DIST_ROOT, 'index.html')
  }
  try {
    const body = await readFile(path)
    const extension = extname(path)
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'cache-control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    response.end(body)
  } catch {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('dshw UI 尚未构建；请运行 pnpm build:ui\n')
  }
}
