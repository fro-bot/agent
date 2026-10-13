import {describe, expect, it} from 'vitest'
import {OPERATOR_PUSH_TRIGGER_KINDS} from '../../operator-contract/index.js'
import {buildApprovalPayload, buildFailedRunPayload, buildQuestionPayload} from './payload-builder.js'

const FORBIDDEN_SUBSTRINGS = [
  'repo',
  'prompt',
  'command',
  'endpoint',
  'p256dh',
  'auth',
  'token',
  'cookie',
  'csrf',
  'idempotency',
  'sessionId',
  'session-id',
]

function assertNoForbiddenFields(payload: unknown): void {
  const serialized = JSON.stringify(payload).toLowerCase()
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    expect(serialized).not.toContain(forbidden.toLowerCase())
  }
}

describe('buildApprovalPayload', () => {
  // #given no input
  // #when the approval payload is built
  // #then it has the fixed approval copy keys and route
  it('returns the fixed approval-needed payload shape', () => {
    const payload = buildApprovalPayload()
    expect(payload).toEqual({
      title: 'operator.approval_needed.title',
      body: 'operator.approval_needed.body',
      data: {type: 'approval', route: '/'},
    })
  })

  // #given the approval payload
  // #when serialized
  // #then it never carries a forbidden field
  it('never carries forbidden fields', () => {
    assertNoForbiddenFields(buildApprovalPayload())
  })
})

const RUN_UUID = '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f9e7b34'

describe('buildQuestionPayload', () => {
  // #given a UUID run id
  // #when the question payload is built
  // #then the copy is fixed and the route deep-links to the run
  it('deep-links a UUID run id and keeps the fixed copy', () => {
    expect(buildQuestionPayload(RUN_UUID)).toEqual({
      title: 'operator.question_pending.title',
      body: 'operator.question_pending.body',
      data: {type: 'question', route: `/operator#${RUN_UUID}`, runId: RUN_UUID},
    })
  })

  // #given short URL-safe run ids at the allowlist boundaries
  // #when the question payload is built
  // #then each deep-links to the run
  it.each(['a', 'run_1-B', 'a'.repeat(128)])('deep-links the allowlisted id %s', runId => {
    const {data} = buildQuestionPayload(runId)
    expect(data.route).toBe(`/operator#${runId}`)
    expect(data.runId).toBe(runId)
  })

  // #given a run id outside the allowlist
  // #when the question payload is built
  // #then it falls back to the root route with no runId key
  it.each(['', 'a#b', '//evil', 'javascript:x', 'a b', '%2F', 'a\n', '../x', 'a'.repeat(129)])(
    'falls back to / with no runId for %j',
    runId => {
      const payload = buildQuestionPayload(runId)
      expect(payload.data).toEqual({type: 'question', route: '/'})
      expect(Object.prototype.hasOwnProperty.call(payload.data, 'runId')).toBe(false)
      expect(payload.title).toBe('operator.question_pending.title')
      expect(payload.body).toBe('operator.question_pending.body')
    },
  )

  // #given allowlisted and non-allowlisted ids
  // #when the question payload is built
  // #then the route is always same-origin: starts with / and never //
  it.each([RUN_UUID, 'run-1', '', '//evil', '/evil', 'a#b', 'javascript:x'])(
    'produces a same-origin route for %j',
    runId => {
      const {route} = buildQuestionPayload(runId).data
      expect(route.startsWith('/')).toBe(true)
      expect(route.startsWith('//')).toBe(false)
    },
  )

  // #given the question payloads for a valid and an invalid id
  // #when serialized
  // #then they never carry a forbidden field
  it('never carries forbidden fields', () => {
    assertNoForbiddenFields(buildQuestionPayload(RUN_UUID))
    assertNoForbiddenFields(buildQuestionPayload('run-1'))
    assertNoForbiddenFields(buildQuestionPayload('//evil'))
  })

  // #given a run id that is not allowlisted
  // #when serialized
  // #then the id never reaches the payload
  it('does not echo a rejected id into the payload', () => {
    expect(JSON.stringify(buildQuestionPayload('javascript:x'))).not.toContain('javascript')
  })
})

describe('payload routes outside the question deep link', () => {
  // #given the approval and run-failed builders
  // #when each builds its payload
  // #then both keep the root route and carry no runId
  it('keeps route / and no runId for approval and run-failed payloads', () => {
    for (const payload of [buildApprovalPayload(), buildFailedRunPayload('session-error'), buildFailedRunPayload()]) {
      expect(payload.data.route).toBe('/')
      expect(Object.prototype.hasOwnProperty.call(payload.data, 'runId')).toBe(false)
    }
  })
})

describe('buildFailedRunPayload', () => {
  // #given a known-safe failure label
  // #when the failed-run payload is built
  // #then the failureLabel is included verbatim
  it('includes a known-safe failure label', () => {
    const payload = buildFailedRunPayload('inactivity-timeout')
    expect(payload).toEqual({
      title: 'operator.run_failed.title',
      body: 'operator.run_failed.body',
      data: {type: 'run_failed', route: '/', failureLabel: 'inactivity-timeout'},
    })
  })

  // #given an unknown/unmapped failure label
  // #when the failed-run payload is built
  // #then it collapses to generic copy with no failureLabel key
  it('omits an unknown failure label and stays generic', () => {
    const payload = buildFailedRunPayload('some-internal-raw-kind')
    expect(payload).toEqual({
      title: 'operator.run_failed.title',
      body: 'operator.run_failed.body',
      data: {type: 'run_failed', route: '/'},
    })
    expect(Object.prototype.hasOwnProperty.call(payload.data, 'failureLabel')).toBe(false)
  })

  // #given no failure label
  // #when the failed-run payload is built
  // #then it is generic with no failureLabel key
  it('omits failureLabel when absent', () => {
    const payload = buildFailedRunPayload()
    expect(Object.prototype.hasOwnProperty.call(payload.data, 'failureLabel')).toBe(false)
  })

  // #given a failed-run payload (with and without a label)
  // #when serialized
  // #then it never carries a forbidden field
  it('never carries forbidden fields', () => {
    assertNoForbiddenFields(buildFailedRunPayload('session-error'))
    assertNoForbiddenFields(buildFailedRunPayload('unrecognized-raw-value'))
  })
})

describe('payload builders — trigger kinds match the operator contract', () => {
  // #given the three payload builders
  // #when each builds its payload
  // #then the set of `data.type` values is exactly the contract's trigger kinds
  it('produces exactly OPERATOR_PUSH_TRIGGER_KINDS as data.type', () => {
    const types = [buildApprovalPayload(), buildQuestionPayload(RUN_UUID), buildFailedRunPayload()].map(
      payload => payload.data.type,
    )

    expect([...types].sort()).toEqual([...OPERATOR_PUSH_TRIGGER_KINDS].sort())
  })
})
