import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// End-to-end: spawn a real Vitest run on fixtures whose workers are SIGKILLed mid-file (the same
// observable failure as heap exhaustion) and assert the reporter fails the run and names the lost tests.
// The fixtures are `*.fixture.ts`, so the normal suite's default globs never collect them.

const vitestEntry = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const fixtureDir = fileURLToPath(new URL('./fixtures/vitest-worker-crash/', import.meta.url))
const fixtureConfig = fileURLToPath(new URL('./fixtures/vitest-worker-crash/vitest.config.ts', import.meta.url))

function runFixtureVitest(extraArgs: readonly string[]): {readonly status: number | null; readonly output: string} {
  // Strip the parent run's Vitest markers so the child behaves like a fresh top-level invocation.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')))
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', '--root', fixtureDir, '--config', fixtureConfig, ...extraArgs],
    {encoding: 'utf8', env: {...env, NO_COLOR: '1', FORCE_COLOR: '0'}, timeout: 30_000},
  )
  return {status: result.status, output: `${result.stdout}\n${result.stderr}`}
}

describe('incomplete-run reporter (worker crash end-to-end)', () => {
  it('exits non-zero and names the modules and tests that lost their results', () => {
    // #given fixtures where two workers die mid-file and one healthy file has pass/skip/todo tests
    // #when Vitest runs them with the reporter registered
    const {status, output} = runFixtureVitest([])

    // #then the run fails and every lost test is named, including genuine passes erased by an afterAll crash
    expect(status).toBe(1)
    expect(output).toContain('Vitest run incomplete')
    expect(output).toContain('mid-test-crash.fixture.ts')
    expect(output).toContain('lost-before-crash passes then dies')
    expect(output).toContain('lost-crashing-test kills its worker')
    expect(output).toContain('lost-after-crash never runs')
    expect(output).toContain('after-all-crash.fixture.ts')
    expect(output).toContain('lost-suite > lost-genuine-pass-one')
    expect(output).toContain('lost-suite > lost-genuine-pass-two')
  })

  it('does not name healthy files or legitimately skipped/todo tests', () => {
    // #given the same run
    // #when it finishes
    const {output} = runFixtureVitest([])

    // #then the healthy file (with skipped suite and todo) is not reported as lost work
    const report = output.slice(output.indexOf('Vitest run incomplete'))
    expect(report).not.toContain('healthy')
  })

  it('is additive: a --reporter override still gets the incomplete-run report', () => {
    // #given the user swaps the primary reporter on the command line
    // #when the crashing fixtures run
    const {status, output} = runFixtureVitest(['--reporter=dot'])

    // #then the safety net is not replaced along with the default reporter
    expect(status).toBe(1)
    expect(output).toContain('Vitest run incomplete')
  })

  it('still fails when Vitest ignores unhandled errors, so it does not rely on that mechanism', () => {
    // #given Vitest's unhandled-error exit path is disabled
    // #when the crashing fixtures run
    const {status, output} = runFixtureVitest(['--dangerouslyIgnoreUnhandledErrors'])

    // #then the reporter alone still forces a failing exit and names the lost tests
    expect(status).toBe(1)
    expect(output).toContain('lost-crashing-test kills its worker')
  })
})
