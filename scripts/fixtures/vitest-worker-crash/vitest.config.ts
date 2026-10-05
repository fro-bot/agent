import {defineConfig} from 'vitest/config'

import {incompleteRunReporterPlugin} from '../../vitest-incomplete-run-reporter.ts'

// Config for the worker-crash fixture. `*.fixture.ts` never matches Vitest's default test globs, so the
// normal suite cannot pick these files up; only `vitest-incomplete-run-reporter.e2e.test.ts` runs them.
export default defineConfig({
  plugins: [incompleteRunReporterPlugin()],
  test: {
    include: ['**/*.fixture.ts'],
  },
})
