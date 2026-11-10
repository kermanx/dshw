/**
 * dshw kanban plugin — node half.
 *
 * The dashboard itself is served by the local dshw daemon and rendered by the
 * browser half (this package's ./client bundle). This module adds one thing:
 * a same-origin proxy at `/api/dshw/*` so the panel can reach the daemon
 * without exposing its loopback port to the browser.
 *
 * That matters when the GUI is opened from another machine: a browser that
 * reaches the Harness through an SSH tunnel or a forwarded container port can
 * only see the forwarded web port, so a direct `http://127.0.0.1:7849` fetch
 * would hit the viewer's own machine. With the proxy the panel talks to the
 * origin it was loaded from, while the daemon stays behind the Harness
 * authentication and Host/Origin checks. The client still falls back to the
 * loopback URL when this route is not mounted (an older Harness, or a plugin
 * loaded without the node half).
 */
const http = require('node:http')

/** Path prefix owned by this proxy on the harness web server. */
const PROXY_PATH = '/api/dshw'

/** Headers the daemon must not receive, or the browser must not see back. */
const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'keep-alive', 'proxy-connection', 'te', 'trailer',
])
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'transfer-encoding', 'keep-alive', 'proxy-connection',
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-max-age',
])

/** Daemon origin: `DSHW_URL` wins, then `DSHW_PORT`, then the dshw default. */
function daemonOrigin() {
  const explicit = process.env.DSHW_URL
  if (explicit !== undefined && explicit !== '') return new URL(explicit)
  const port = Number(process.env.DSHW_PORT ?? 7849)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DSHW_PORT must be a port number; received ${JSON.stringify(process.env.DSHW_PORT)}`)
  }
  return new URL(`http://127.0.0.1:${String(port)}`)
}

/**
 * Forward one request to the daemon and stream the answer back.
 *
 * Both directions are piped, so long-lived answers (the `/api/events` server
 * sent events stream) stay open, and a cancelled page fetch tears the upstream
 * request down with it.
 */
function forward(req, res, origin) {
  const upstreamPath = req.url.replace(new RegExp(`^${PROXY_PATH}(?=/|$)`), '') || '/'
  const headers = { ...req.headers }
  for (const name of DROP_REQUEST_HEADERS) delete headers[name]
  headers.host = origin.host
  // The daemon renders absolute links/redirects for the browser, so it needs
  // to know the prefix this proxy stripped.
  headers['x-dshw-prefix'] = PROXY_PATH
  const upstream = http.request({
    protocol: origin.protocol,
    hostname: origin.hostname,
    port: origin.port,
    method: req.method,
    path: upstreamPath,
    headers,
  }, (answer) => {
    const responseHeaders = { ...answer.headers }
    for (const name of DROP_RESPONSE_HEADERS) delete responseHeaders[name]
    // Server-sent events must not be buffered or cached by an intermediary.
    if (answer.headers['content-type']?.startsWith('text/event-stream') === true) {
      responseHeaders['cache-control'] = 'no-cache'
      responseHeaders.connection = 'keep-alive'
    }
    res.writeHead(answer.statusCode ?? 502, responseHeaders)
    answer.pipe(res)
    answer.on('close', () => { if (!res.writableEnded) res.end() })
  })
  upstream.setTimeout(0)
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: `dshw daemon 不可达（${origin.origin}）：${error.message}` }))
  })
  req.on('aborted', () => { upstream.destroy() })
  res.on('close', () => { upstream.destroy() })
  req.pipe(upstream)
}

exports.name = 'dshw-kanban'

/** The proxy needs the web server and the Harness trust rules. */
exports.inject = ['webServer', 'connection']

exports.apply = (ctx) => {
  const origin = daemonOrigin()
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PROXY_PATH,
    handler: (req, res) => {
      // The same Host/Origin/authentication policy as every other /api
      // request: the proxy must never be an unauthenticated door to the daemon.
      const rejection = ctx.connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      forward(req, res, origin)
    },
  }), 'dshw: daemon proxy')
}
