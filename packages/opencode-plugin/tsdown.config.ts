import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {defineConfig} from 'tsdown'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// The entry is absolute on purpose: with `rootDir: ../../` in tsconfig.json a relative `src/index.ts` resolves against
// the repo root and silently bundles the Action's `src/index.ts` instead (the same trap packages/gateway guards
// against).
//
// `effect` and `@opencode/plugin` are provided by the OpenCode host at load time (packages/plugin/README.md,
// "Packaging And Runtime effect"): the host swaps every import of either for its own module instance, so a bundled copy
// would be a second, unshared one. Keep both external. Everything else, including the private `@fro-bot/runtime`
// session code, is inlined, because that package is not published.
export default defineConfig({
  entry: [path.join(dirname, 'src/index.ts')],
  format: 'esm',
  dts: true,
  outDir: 'dist',
  deps: {
    neverBundle: [/^effect(\/.*)?$/, /^@opencode\/plugin(\/.*)?$/],
    alwaysBundle: [/^@fro-bot\/runtime(\/.*)?$/],
    // The only third-party code that may be inlined. Anything else is a new runtime dependency that must be declared.
    onlyBundle: ['@bfra.me/es'],
  },
})
