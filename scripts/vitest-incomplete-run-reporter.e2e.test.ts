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
    const reportStart = output.indexOf('Vitest run incomplete')
    expect(reportStart).toBeGreaterThanOrEqual(0)
    expect(output.slice(reportStart)).not.toContain('healthy')
  })

  it('passes with no incomplete-run report when only the healthy file is run', () => {
    // #given a real run restricted to the healthy fixture (pass + skipped suite + todo)
    // #when Vitest runs it with the reporter registered
    const {status, output} = runFixtureVitest(['healthy.fixture.ts'])

    // #then the run succeeds and the safety net stays silent
    expect(status).toBe(0)
    expect(output).not.toContain('Vitest run incomplete')
  })

  it('passes with no report when a -t name filter excludes a runnable test in the same file', () => {
    // #given the healthy file has two runnable passing tests and the filter selects only one of them
    // #when Vitest runs it with a test-name filter (the crash fixtures are not targeted)
    const {status, output} = runFixtureVitest(['healthy.fixture.ts', '-t', 'healthy-second-test'])

    // #then filtered-out tests are skipped work, not lost work: exit 0 and no report
    expect(status).toBe(0)
    expect(output).toContain('1 passed')
    expect(output).not.toContain('Vitest run incomplete')
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
