import type {Plugin} from 'rolldown'

import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {defineConfig} from 'tsdown'

const dirname = path.dirname(fileURLToPath(import.meta.url))

/** Known gateway symbol that must be present in the produced bundle. */
const REQUIRED_SYMBOL = 'dispatchArgv'

/**
 * Post-build guard: reads the produced `dist/main.mjs` and asserts it contains
 * the known gateway symbol. Fails the build loudly if absent, catching any
 * future entry-resolution regression regardless of root cause.
 *
 * The check is inlined here (rather than imported) because tsdown's native config
 * loader resolves imports as compiled JS and cannot follow .js → .ts source
 * mappings at config-load time, before the TypeScript compilation step.
 */
function bundleSymbolGuardPlugin(): Plugin {
  return {
    name: 'bundle-symbol-guard',
    async writeBundle(options) {
      const dir = options.dir ?? 'dist'
      const bundlePath = path.join(dir, 'main.mjs')
      const content = await readFile(bundlePath, 'utf8')
      // Fail-closed on empty content.
      const symbolPresent = content.length > 0 && content.includes(REQUIRED_SYMBOL)
      if (symbolPresent === false) {
        throw new Error(
          `[bundle-symbol-guard] Expected symbol "${REQUIRED_SYMBOL}" not found in ${bundlePath}. ` +
            `The bundle may have resolved the wrong entry point (e.g. the repo-root action harness instead of packages/gateway/src/main.ts). ` +
            `Check tsdown.config.ts entry resolution and tsconfig.json rootDir.`,
        )
      }
    },
  }
}

export default defineConfig({
  entry: [path.join(dirname, 'src/main.ts')],
  format: 'esm',
  outDir: 'dist',
  noExternal: id => {
    if (id === '@fro-bot/runtime' || id.startsWith('@fro-bot/runtime/')) return true
    return false
  },
  plugins: [bundleSymbolGuardPlugin()],
})
