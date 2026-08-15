import type {EvalRunState, GateResult} from './types.js'
import {isDecisiveGateFailure} from './gates.js'

export interface CorpusScenarioVerdict {
  readonly state: EvalRunState
  readonly gates?: readonly Pick<GateResult, 'id' | 'kind' | 'status'>[]
}

export interface CorpusVerdict {
  readonly status: 'passed' | 'failed' | 'inconclusive'
  readonly reason: string
}

export function evaluateCorpusReports(reports: readonly CorpusScenarioVerdict[]): CorpusVerdict {
  if (reports.some(report => report.gates?.some(isDecisiveGateFailure) === true)) {
    return {status: 'failed', reason: 'At least one decisive safety or response-contract gate failed'}
  }
  return evaluateCorpusVerdict(reports.map(report => report.state))
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
