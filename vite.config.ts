import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig, type Plugin } from 'vite'

function readonlyApiInDev(): Plugin {
  return {
    name: 'dshw-readonly-api',
    configureServer(server) {
      server.middlewares.use('/api', (request, response, next) => {
        if (request.method === 'GET') return next()
        response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        response.end(`${JSON.stringify({ error: 'UI dev server 是只读的；生产操作请使用正式服务' })}\n`)
      })
    },
  }
}

export default defineConfig({
  root: 'ui',
  plugins: [readonlyApiInDev(), vue(), UnoCSS()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 7850,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7849',
      },
    },
  },
})
