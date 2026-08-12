import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'ui',
  plugins: [vue(), UnoCSS()],
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
