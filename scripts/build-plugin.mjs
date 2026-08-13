/**
 * Build the dshw kanban client bundle (plugin/lib/client.js).
 *
 * The harness web shell loads client plugins as lazy module-loader bundles:
 * the file only REGISTERS a factory via `window.__ModuleLoader__.load({ id,
 * factory })`, and every module side effect runs at materialization inside
 * the factory. Externals (react, react-dom, the @deepseek-ai ui-primitives
 * platform module) are resolved through the injected `require` — the shell's
 * module table — so they are never bundled here.
 *
 * Pipeline: vite lib build (rolldown) in CJS format with the externals kept,
 * then the output is wrapped in the loader contract, mirroring the harness's
 * own tsdown client preset output shape.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const pluginDir = resolve(root, 'plugin')
const distDir = resolve(root, 'node_modules/.cache/dshw-plugin')
const outFile = resolve(pluginDir, 'lib/client.js')

/** Bundle id == the package name (the roster row's `name`). */
const BUNDLE_ID = 'dshw'

/** Platform modules the shell's module table provides at runtime. */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/dsh-client-ui-primitives',
]

await build({
  configFile: false,
  root: pluginDir,
  logLevel: 'warn',
  build: {
    lib: {
      entry: resolve(pluginDir, 'src/index.tsx'),
      formats: ['cjs'],
      fileName: () => 'client.js',
    },
    outDir: distDir,
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      external: EXTERNAL,
      output: { exports: 'named' },
    },
  },
})

const body = (await readFile(resolve(distDir, 'client.js'), 'utf8')).trimEnd()
const wrapped = [
  'window.__ModuleLoader__.load({',
  '\tid: ' + JSON.stringify(BUNDLE_ID) + ',',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')
await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, wrapped)
console.log(`dshw kanban client bundle written to ${outFile}`)
