/**
 * Render the Pi review extension for one run.
 *
 * `extension-pi.ts` is authored as TypeScript for the repository's own
 * tooling but Pi loads plain JavaScript, so both it and the validation module
 * are stripped with Node's built-in type stripper and combined into a single
 * self-contained `.mjs` file. Keeping one file avoids relying on how Pi's
 * extension loader resolves relative imports.
 */
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

/** Placeholder inside `extension-pi.ts` where the validation source is inlined. */
const VALIDATION_MARKER = '/*__VALIDATION_SOURCE__*/'

/** Strip erasable TypeScript; `inline` also removes module exports so the code can be nested. */
function strip(source: string, filename: string, inline: boolean): string {
  const javascript = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: filename })
  return inline ? javascript.replace(/^export /gmu, '') : javascript
}

/** Build the JavaScript for the Pi extension of one review run. */
export async function reviewExtensionSource(): Promise<string> {
  const [extension, validation] = await Promise.all([
    readFile(new URL('./extension-pi.ts', import.meta.url), 'utf8'),
    readFile(new URL('./validation.ts', import.meta.url), 'utf8'),
  ])
  const stripped = strip(extension, 'extension-pi.ts', false)
  if (!stripped.includes(VALIDATION_MARKER)) throw new Error('review extension is missing the validation marker')
  return stripped.replace(VALIDATION_MARKER, strip(validation, 'validation.ts', true).trim())
}
