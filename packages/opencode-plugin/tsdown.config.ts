import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {defineConfig} from 'tsdown'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// The entry is absolute: with `rootDir: ../../` a relative `src/index.ts` would bundle the Action's entry instead.
// `effect` and `@opencode/plugin` come from the host at load time and stay external; `@fro-bot/runtime` is inlined. The
// plugin imports the runtime only through dedicated subpaths (`@fro-bot/runtime/tracing/scrub`, `.../tracing/exporter`,
// `.../session-v2`), never its index, so the bundle holds only the modules those subpaths reach.
export default defineConfig({
  entry: [path.join(dirname, 'src/index.ts')],
  format: 'esm',
  dts: true,
  outDir: 'dist',
  // Node built-ins are written with the `node:` prefix, which is what the release import check allows.
  nodeProtocol: true,
  // The OpenTelemetry packages ship a CommonJS build (`main`) and an ES module build (`module`). Prefer the ES build: the
  // CommonJS one is inlined through `__require`, which the host's module loader may not provide.
  inputOptions: {resolve: {mainFields: ['module', 'main']}},
  deps: {
    neverBundle: [/^effect(\/.*)?$/, /^@opencode\/plugin(\/.*)?$/],
    alwaysBundle: [/^@fro-bot\/runtime(\/.*)?$/],
    // The only third-party code that may be inlined. Anything else is a new runtime dependency that must be declared.
    onlyBundle: [
      '@bfra.me/es',
      // The OpenTelemetry SDK, inlined into the lazily loaded tracing chunk and never imported at runtime. The first
      // five are declared dependencies of `@fro-bot/runtime` (whose exporter imports them); the rest are their
      // transitive dependencies, pinned by the lockfile.
      '@opentelemetry/api',
      '@opentelemetry/resources',
      '@opentelemetry/sdk-trace-base',
      '@opentelemetry/otlp-exporter-base',
      '@opentelemetry/otlp-transformer',
      '@opentelemetry/core',
      '@opentelemetry/semantic-conventions',
    ],
  },
})
