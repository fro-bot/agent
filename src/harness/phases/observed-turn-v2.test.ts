import type {ErrorInfo} from '@fro-bot/runtime'
import type {EventStreamResult} from '../../features/agent/streaming.js'
import type {MetricsCollector} from '../../features/observability/index.js'
import type {ExecutePhaseResult} from './execute.js'
import {describe, expect, it, vi} from 'vitest'
import {mergeObservedTurn, recordObservedTurn, type ObservedTurnV2} from './observed-turn-v2.js'

function execution(overrides: Partial<ExecutePhaseResult> = {}): ExecutePhaseResult {
  return {
    success: true,
    exitCode: 0,
    sessionId: 'ses_root',
    error: null,
    tokenUsage: null,
    model: null,
    cost: null,
    prsCreated: ['https://github.com/o/r/pull/1'],
    commitsCreated: ['abc1234'],
    commentsPosted: 1,
    llmError: null,
    resolvedOutputMode: 'working-dir',
    outputModeMigration: {requested: 'omitted', resolved: 'working-dir'},
    observationGap: false,
    recoveryBoundaryUnresolved: false,
    executionDurationMs: 10,
    ...overrides,
  }
}

function stream(overrides: Partial<EventStreamResult> = {}): EventStreamResult {
  return {
    tokens: null,
    model: null,
    cost: null,
    prsCreated: [],
    commitsCreated: [],
    commentsPosted: 0,
    llmError: null,
    ...overrides,
  }
}

function observed(overrides: Partial<ObservedTurnV2> = {}): ObservedTurnV2 {
  return {result: stream(), rootTerminal: {kind: 'succeeded'}, failure: null, usage: null, ...overrides}
}

const QUOTA: ErrorInfo = {type: 'quota_exceeded', message: 'out of credit', retryable: false}

describe('mergeObservedTurn', () => {
  it('fails a run whose last root turn failed, even though the first one succeeded', () => {
    // #given
    const turn = observed({rootTerminal: {kind: 'failed'}, failure: QUOTA, result: stream({llmError: QUOTA})})

    // #when
    const merged = mergeObservedTurn(execution(), turn)

    // #then
    expect(merged).toMatchObject({success: false, exitCode: 1, error: 'out of credit', llmError: QUOTA})
  })

  it('fails a run whose last root turn was interrupted', () => {
    // #given / #when
    const merged = mergeObservedTurn(execution(), observed({rootTerminal: {kind: 'interrupted', reason: 'user'}}))

    // #then
    expect(merged).toMatchObject({success: false, exitCode: 1})
    expect(merged.error).toContain('interrupted')
  })

  it('keeps a run whose last turn succeeded, and adds the artifacts and usage of the turns it saw', () => {
    // #given a notice turn that opened a second pull request and used more tokens
    const turn = observed({
      result: stream({
        prsCreated: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
        commitsCreated: ['abc1234', 'def5678'],
        commentsPosted: 3,
      }),
      usage: {tokens: {input: 9, output: 8, reasoning: 0, cache: {read: 0, write: 0}}, cost: 0.5, model: 'p/m'},
    })

    // #when
    const merged = mergeObservedTurn(execution(), turn)

    // #then
    expect(merged).toMatchObject({
      success: true,
      prsCreated: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
      commitsCreated: ['abc1234', 'def5678'],
      commentsPosted: 3,
      tokenUsage: {input: 9},
      cost: 0.5,
      model: 'p/m',
    })
  })

  it('leaves a run that already failed as it was, and carries a stream gap into the observation facts', () => {
    // #given
    const before = execution({success: false, exitCode: 1, error: 'first failure'})
    const turn = observed({
      rootTerminal: {kind: 'failed'},
      failure: QUOTA,
      result: stream({discontinuity: {message: 'stream lost'}}),
    })

    // #when
    const merged = mergeObservedTurn(before, turn)

    // #then the earlier failure stands, and the gap is recorded
    expect(merged).toMatchObject({success: false, error: 'first failure', observationGap: true})
  })

  it('leaves usage alone when it could not be re-read', () => {
    // #given / #when
    const merged = mergeObservedTurn(execution({cost: 0.1}), observed({usage: null}))

    // #then
    expect(merged.cost).toBe(0.1)
  })
})

describe('recordObservedTurn', () => {
  it('records only what the observed turns added', () => {
    // #given
    const metrics = {
      addPRCreated: vi.fn(),
      addCommitCreated: vi.fn(),
      incrementComments: vi.fn(),
      setTokenUsage: vi.fn(),
      recordError: vi.fn(),
    } as unknown as MetricsCollector
    const before = execution()
    const after = mergeObservedTurn(
      before,
      observed({
        rootTerminal: {kind: 'failed'},
        failure: QUOTA,
        result: stream({
          prsCreated: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
          commitsCreated: ['abc1234'],
          commentsPosted: 3,
        }),
      }),
    )

    // #when
    recordObservedTurn(before, after, metrics)

    // #then
    expect(metrics.addPRCreated).toHaveBeenCalledTimes(1)
    expect(metrics.addPRCreated).toHaveBeenCalledWith('https://github.com/o/r/pull/2')
    expect(metrics.addCommitCreated).not.toHaveBeenCalled()
    expect(metrics.incrementComments).toHaveBeenCalledTimes(2)
    expect(metrics.recordError).toHaveBeenCalledWith('quota_exceeded', 'out of credit', false, undefined, undefined)
  })
})
