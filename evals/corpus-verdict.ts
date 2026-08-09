import type {EvalRunState} from './types.js'

export interface CorpusVerdict {
  readonly status: 'passed' | 'failed' | 'inconclusive'
  readonly reason: string
}

export function evaluateCorpusVerdict(states: readonly EvalRunState[]): CorpusVerdict {
  if (states.length === 0) {
    return {status: 'failed', reason: 'No scenario reports were produced'}
  }

  if (states.includes('failed')) {
    return {status: 'failed', reason: 'At least one scenario failed'}
  }

  if (states.includes('inconclusive')) {
    return {status: 'inconclusive', reason: 'At least one scenario was inconclusive'}
  }

  return {status: 'passed', reason: 'No completed scenario regression was observed'}
}
