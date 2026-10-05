/**
 * Vitest reporter that fails the run when test results were silently lost.
 *
 * When a worker dies mid-file (heap exhaustion, SIGKILL, ...), Vitest leaves that file's module and
 * tests in a non-terminal state: they are not counted as failed and not named, and `TestModule.ok()`
 * returns `true` for unfinished work. The only thing that fails the run today is the unhandled-error
 * path, a single fragile mechanism. This reporter acts on the collected-vs-reported mismatch directly:
 * it names every module/test with no result and forces a non-zero exit code.
 *
 * Reporter API relied on (vitest 4.1.x): `onTestRunEnd(testModules, unhandledErrors, reason)`,
 * `TestModule.state()` / `.relativeModuleId` / `.children.allTests()`, `TestCase.result().state` /
 * `.fullName`. Reporters run after Vitest sets its own exit code and nothing resets it afterward.
 */

import type {Plugin} from 'vite'
import type {Reporter, TestModule, TestModuleState, TestState, Vitest} from 'vitest/node'

import process from 'node:process'

export interface ReportedTest {
  readonly name: string
  readonly state: TestState
}

/** Minimal, framework-independent view of a Vitest `TestModule`. */
export interface ReportedModule {
  readonly path: string
  readonly state: TestModuleState
  readonly tests: readonly ReportedTest[]
}

export interface IncompleteModule {
  readonly path: string
  readonly state: TestModuleState
  readonly unresolvedTests: readonly string[]
}

const MAX_LISTED_TESTS_PER_MODULE = 50

/**
 * A module is incomplete when it never reached a terminal state (`queued`/`pending`) or still holds
 * a collected test with no result (`pending`). Skipped/todo/filtered work is `skipped`, which is terminal.
 */
export function findIncompleteModules(modules: readonly ReportedModule[]): readonly IncompleteModule[] {
  const incomplete: IncompleteModule[] = []
  for (const module of modules) {
    const unresolvedTests = module.tests.filter(test => test.state === 'pending').map(test => test.name)
    const unfinished = module.state === 'queued' || module.state === 'pending'
    if (unfinished || unresolvedTests.length > 0) {
      incomplete.push({path: module.path, state: module.state, unresolvedTests})
    }
  }
  return incomplete
}

export function formatIncompleteRunReport(incomplete: readonly IncompleteModule[]): string {
  const lines = [
    '',
    `Vitest run incomplete: ${incomplete.length} test file(s) did not finish and left tests with no result`,
    '(a worker likely crashed, e.g. heap exhaustion). Forcing exit code 1.',
  ]
  for (const module of incomplete) {
    lines.push(`  ✗ ${module.path} (module state: ${module.state})`)
    const listed = module.unresolvedTests.slice(0, MAX_LISTED_TESTS_PER_MODULE)
    for (const name of listed) lines.push(`      - ${name}`)
    const omitted = module.unresolvedTests.length - listed.length
    if (omitted > 0) lines.push(`      ... and ${omitted} more`)
  }
  lines.push('')
  return lines.join('\n')
}

function toReportedModule(module: TestModule): ReportedModule {
  return {
    path: module.relativeModuleId,
    state: module.state(),
    tests: Array.from(module.children.allTests(), test => ({name: test.fullName, state: test.result().state})),
  }
}

export interface IncompleteRunReporterOptions {
  readonly write?: (text: string) => void
}

export function createIncompleteRunReporter(options: IncompleteRunReporterOptions = {}): Reporter {
  const write = options.write ?? ((text: string): boolean => process.stderr.write(text))
  return {
    onTestRunEnd(testModules, _unhandledErrors, reason) {
      // An interrupted run (SIGINT/cancel) legitimately leaves work unfinished and already exits non-zero.
      if (reason === 'interrupted') return
      const incomplete = findIncompleteModules(testModules.map(toReportedModule))
      if (incomplete.length === 0) return
      write(formatIncompleteRunReport(incomplete))
      process.exitCode = 1
    },
  }
}

/**
 * Vite plugin that appends the reporter to Vitest's already-resolved reporter list.
 *
 * Setting `test.reporters` in the config would replace Vitest's environment-derived defaults (the compact
 * `agent` reporter, `github-actions` annotations) and any `--reporter` CLI override. `configureVitest` runs
 * after the reporter list is resolved and before the reporters are instantiated, so appending here keeps
 * every existing reporter and still applies to every suite that resolves the root config.
 */
export function incompleteRunReporterPlugin(options: IncompleteRunReporterOptions = {}): Plugin {
  const registered = new WeakSet<Vitest>()
  return {
    name: 'fro-bot:incomplete-run-reporter',
    configureVitest({vitest}) {
      // Called once per project; the reporter must be registered once per Vitest instance.
      if (registered.has(vitest)) return
      registered.add(vitest)
      vitest.config.reporters.push(createIncompleteRunReporter(options))
    },
  }
}
