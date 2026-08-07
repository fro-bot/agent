import type {EvalRunState} from './types.js'
import {describe, expect, it} from 'vitest'
import {evaluateCorpusVerdict} from './corpus-verdict.js'

describe('evaluateCorpusVerdict', () => {
  it('passes when every scenario passes', () => {
    // #given completed scenarios with no quality regressions
    const states: readonly EvalRunState[] = ['passed', 'passed']

    // #when the suite verdict is evaluated
    const verdict = evaluateCorpusVerdict(states)

    // #then the corpus passes
    expect(verdict.status).toBe('passed')
  })

  it('fails when any scenario fails', () => {
    // #given one completed scenario with an observed regression
    const states: readonly EvalRunState[] = ['passed', 'failed', 'inconclusive']

    // #when the suite verdict is evaluated
    const verdict = evaluateCorpusVerdict(states)

    // #then the corpus fails for the completed regression
    expect(verdict.status).toBe('failed')
    expect(verdict.reason).toContain('failed')
  })

  it('fails when every scenario is inconclusive', () => {
    // #given a run that obtained no completed scenario outcome
    const states: readonly EvalRunState[] = ['inconclusive', 'inconclusive']

    // #when the suite verdict is evaluated
    const verdict = evaluateCorpusVerdict(states)

    // #then the corpus fails because the harness produced no information
    expect(verdict.status).toBe('failed')
    expect(verdict.reason).toContain('inconclusive')
  })
})
