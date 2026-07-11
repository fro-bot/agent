import {describe, expect, it} from 'vitest'
import {buildApprovalPayload, buildFailedRunPayload} from './payload-builder.js'

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
