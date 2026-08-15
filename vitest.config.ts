import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
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
