import {fileURLToPath} from 'node:url'

import {defineConfig} from 'vitest/config'

import {incompleteRunReporterPlugin} from './scripts/vitest-incomplete-run-reporter.ts'

// Vitest 5 no longer walks up to find a config, so package suites run `vitest` from their own directory with
// `--config ../../vitest.config.ts` (runtime, gateway, harness) to share this file; the Action suite sets `--root`
// to the repo root. The plugin below fails the run when a worker crash left tests with no result (see
// scripts/vitest-incomplete-run-reporter.ts). `apps/workspace-agent` does not pass `--config` because its Docker
// test stage copies only that app, so it runs with Vitest defaults (no home isolation or incomplete-run reporter).
export default defineConfig({
  plugins: [incompleteRunReporterPlugin()],
  test: {
    // Runs before each test file imports app modules: HOME and XDG_* point at a throwaway temp tree so no test can
    // touch the developer's real home. Resolves from this config's root, which every suite shares.
    setupFiles: [fileURLToPath(new URL('./scripts/vitest-home-isolation.setup.ts', import.meta.url))],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      // Cloned dependency source repos and alternate git worktrees are for inspection only.
      '**/.slim/**',
      '**/.worktrees/**',
      // deploy/scripts/*.test.mjs use the node:test runner, not vitest.
      '**/deploy/**',
    ],
  },
})
