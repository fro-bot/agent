import type {Reporter, TestModule, Vitest, VitestPluginContext} from 'vitest/node'
import type {ReportedModule} from './vitest-incomplete-run-reporter.js'

import process from 'node:process'
import {afterEach, describe, expect, it} from 'vitest'

import {
  createIncompleteRunReporter,
  findIncompleteModules,
  formatIncompleteRunReport,
  incompleteRunReporterPlugin,
} from './vitest-incomplete-run-reporter.js'

function mod(path: string, state: ReportedModule['state'], tests: ReportedModule['tests'] = []): ReportedModule {
  return {path, state, tests}
}

describe('findIncompleteModules', () => {
  it('returns nothing when every module and test reached a terminal state', () => {
    // #given modules that passed, failed, and were skipped, with terminal test results
    const modules = [
      mod('a.test.ts', 'passed', [{name: 'works', state: 'passed'}]),
      mod('b.test.ts', 'failed', [{name: 'breaks', state: 'failed'}]),
      mod('c.test.ts', 'skipped', [{name: 'later', state: 'skipped'}]),
    ]

    // #when the run is inspected
    const incomplete = findIncompleteModules(modules)

    // #then nothing is reported
    expect(incomplete).toEqual([])
  })

  it('treats an empty run (e.g. --passWithNoTests) as complete', () => {
    // #given no modules at all
    // #when the run is inspected
    const incomplete = findIncompleteModules([])

    // #then nothing is reported
    expect(incomplete).toEqual([])
  })

  it('does not flag a module that is skipped as a whole with no collected tests', () => {
    // #given a fully skipped / filtered-out file
    const modules = [
      mod('skipped.test.ts', 'skipped'),
      mod('todo.test.ts', 'skipped', [{name: 'todo', state: 'skipped'}]),
    ]

    // #when the run is inspected
    const incomplete = findIncompleteModules(modules)

    // #then it is not treated as lost work
    expect(incomplete).toEqual([])
  })

  it('flags a module that never finished and names every test without a result', () => {
    // #given a worker died mid-file: the module and its tests are still pending
    const modules = [
      mod('ok.test.ts', 'passed', [{name: 'fine', state: 'passed'}]),
      mod('crash.test.ts', 'pending', [
        {name: 'first', state: 'pending'},
        {name: 'suite > second', state: 'pending'},
      ]),
    ]

    // #when the run is inspected
    const incomplete = findIncompleteModules(modules)

    // #then only the crashed module is reported, with the lost test names
    expect(incomplete).toEqual([
      {path: 'crash.test.ts', state: 'pending', unresolvedTests: ['first', 'suite > second']},
    ])
  })

  it('flags a module that was queued but never started', () => {
    // #given a module whose worker died before it began
    const modules = [mod('never.test.ts', 'queued')]

    // #when the run is inspected
    const incomplete = findIncompleteModules(modules)

    // #then it is reported even though no tests were collected
    expect(incomplete).toEqual([{path: 'never.test.ts', state: 'queued', unresolvedTests: []}])
  })

  it('flags a pending test inside a module that otherwise looks finished', () => {
    // #given a passed module that still holds a test with no result
    const modules = [
      mod('odd.test.ts', 'passed', [
        {name: 'done', state: 'passed'},
        {name: 'lost', state: 'pending'},
      ]),
    ]

    // #when the run is inspected
    const incomplete = findIncompleteModules(modules)

    // #then only the lost test is named
    expect(incomplete).toEqual([{path: 'odd.test.ts', state: 'passed', unresolvedTests: ['lost']}])
  })

  it('names tests lost to a crash in afterAll even though they would have passed', () => {
    // #given an afterAll crash that erased the whole file's results
    const modules = [
      mod('after.test.ts', 'pending', [
        {name: 'one', state: 'pending'},
        {name: 'two', state: 'pending'},
      ]),
    ]

    // #when the run is inspected
    const incomplete = findIncompleteModules(modules)

    // #then every test in the file is named
    expect(incomplete[0]?.unresolvedTests).toEqual(['one', 'two'])
  })
})

describe('formatIncompleteRunReport', () => {
  it('names each incomplete module and test and states the exit code is forced', () => {
    // #given one crashed module
    const report = formatIncompleteRunReport([
      {path: 'crash.test.ts', state: 'pending', unresolvedTests: ['first', 'second']},
    ])

    // #when formatted
    // #then the paths, test names, and consequence are all present
    expect(report).toContain('crash.test.ts')
    expect(report).toContain('first')
    expect(report).toContain('second')
    expect(report).toContain('exit code 1')
  })

  it('reports a module with no collected tests without listing test names', () => {
    // #given a module that never started
    const report = formatIncompleteRunReport([{path: 'never.test.ts', state: 'queued', unresolvedTests: []}])

    // #when formatted
    // #then the module is still named
    expect(report).toContain('never.test.ts')
  })

  it('caps very long test lists and says how many were omitted', () => {
    // #given a module with far more lost tests than fit on screen
    const names = Array.from({length: 120}, (_, index) => `test-${index}`)
    const report = formatIncompleteRunReport([{path: 'big.test.ts', state: 'pending', unresolvedTests: names}])

    // #when formatted
    // #then the list is truncated with an omission count
    expect(report).toContain('test-0')
    expect(report).not.toContain('test-119')
    expect(report).toContain('and 70 more')
  })
})

/** Minimal structural stand-in for a Vitest `TestModule`; only the members the reporter reads. */
function fakeModule(path: string, state: ReportedModule['state'], testStates: readonly string[]): TestModule {
  const fake = {
    relativeModuleId: path,
    state: () => state,
    children: {
      allTests: () => testStates.map((name, index) => ({fullName: `${name}-${index}`, result: () => ({state: name})})),
    },
  }
  return fake as unknown as TestModule
}

describe('createIncompleteRunReporter', () => {
  const originalExitCode = process.exitCode
  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it('writes the report and forces exit code 1 when a module did not finish', () => {
    // #given a run that ended normally with a crashed module
    const written: string[] = []
    const reporter = createIncompleteRunReporter({write: text => written.push(text)})
    process.exitCode = 0

    // #when the run ends
    reporter.onTestRunEnd?.([fakeModule('crash.test.ts', 'pending', ['pending'])], [], 'failed')

    // #then the loss is reported and the exit code is forced
    expect(written.join('')).toContain('crash.test.ts')
    expect(process.exitCode).toBe(1)
  })

  it('writes nothing and leaves process.exitCode untouched for an interrupted run', () => {
    // #given a cancelled run that legitimately left a module unfinished
    const written: string[] = []
    const reporter = createIncompleteRunReporter({write: text => written.push(text)})
    process.exitCode = undefined

    // #when the run ends with reason "interrupted"
    reporter.onTestRunEnd?.([fakeModule('crash.test.ts', 'pending', ['pending'])], [], 'interrupted')

    // #then no report is written and the exit code is not mutated
    expect(written).toEqual([])
    expect(process.exitCode).toBeUndefined()
  })

  it('writes nothing and leaves process.exitCode untouched when every module finished', () => {
    // #given a clean run
    const written: string[] = []
    const reporter = createIncompleteRunReporter({write: text => written.push(text)})
    process.exitCode = undefined

    // #when the run ends
    reporter.onTestRunEnd?.([fakeModule('ok.test.ts', 'passed', ['passed'])], [], 'passed')

    // #then nothing happens
    expect(written).toEqual([])
    expect(process.exitCode).toBeUndefined()
  })
})

function configure(plugin: ReturnType<typeof incompleteRunReporterPlugin>, vitest: Vitest): void {
  const context = {vitest} as unknown as VitestPluginContext
  plugin.configureVitest?.call({} as never, context)
}

function fakeVitest(reporters: Reporter[]): Vitest {
  return {config: {reporters}} as unknown as Vitest
}

describe('incompleteRunReporterPlugin', () => {
  it('appends to the already-resolved reporter list instead of replacing it', () => {
    // #given a Vitest instance with a configured reporter
    const existing: Reporter = {}
    const reporters: Reporter[] = [existing]

    // #when the plugin configures Vitest
    configure(incompleteRunReporterPlugin(), fakeVitest(reporters))

    // #then the existing reporter is preserved in order and the safety net is added after it
    expect(reporters).toHaveLength(2)
    expect(reporters[0]).toBe(existing)
    expect(reporters[1]?.onTestRunEnd).toBeTypeOf('function')
  })

  it('registers once per Vitest instance when configureVitest runs for several projects', () => {
    // #given one plugin instance configured once per project
    const reporters: Reporter[] = []
    const vitest = fakeVitest(reporters)
    const plugin = incompleteRunReporterPlugin()

    // #when the hook runs twice for the same Vitest instance
    configure(plugin, vitest)
    configure(plugin, vitest)

    // #then only one reporter is registered
    expect(reporters).toHaveLength(1)
  })

  it('registers once even when the plugin itself is added twice', () => {
    // #given two plugin instances (e.g. a merged config listing the plugin again)
    const reporters: Reporter[] = []
    const vitest = fakeVitest(reporters)

    // #when both configure the same Vitest instance
    configure(incompleteRunReporterPlugin(), vitest)
    configure(incompleteRunReporterPlugin(), vitest)

    // #then the failure report would still be written once
    expect(reporters).toHaveLength(1)
  })
})
