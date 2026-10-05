import type {ReportedModule} from './vitest-incomplete-run-reporter.js'

import {describe, expect, it} from 'vitest'

import {findIncompleteModules, formatIncompleteRunReport} from './vitest-incomplete-run-reporter.js'

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
