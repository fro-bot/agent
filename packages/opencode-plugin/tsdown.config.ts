import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {defineConfig} from 'tsdown'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// The entry is absolute: with `rootDir: ../../` a relative `src/index.ts` would bundle the Action's entry instead.
// `effect` and `@opencode/plugin` come from the host at load time and stay external; `@fro-bot/runtime` is inlined.
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
