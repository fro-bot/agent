import type {DrainRejectCode} from '../execute/drain-completion.js'
import type {OperatorWaitReason} from './wait-reason.js'

import {describe, expect, it} from 'vitest'
import {DRAIN_REJECT_CODES} from '../execute/drain-completion.js'
import {
  DRAIN_REJECT_CODE_TO_WAIT_REASON,
  isOperatorWaitReason,
  OPERATOR_WAIT_REASONS,
  toOperatorWaitReason,
} from './wait-reason.js'

const EXPECTED = [
  ['root-live', 'agent-working'],
  ['root-liveness-unavailable', 'agent-working'],
  ['root-messages-unavailable', 'awaiting-reply'],
  ['no-root-user-message', 'awaiting-reply'],
  ['stream-user-message-not-persisted', 'awaiting-reply'],
  ['latest-root-user-message-unanswered', 'awaiting-reply'],
  ['reply-text-not-delivered', 'awaiting-reply'],
  ['notice-not-observed', 'awaiting-background-task'],
  ['ledger-not-drained', 'awaiting-background-task'],
  ['revision-drift', 'confirming-completion'],
  ['idle-evidence-stale', 'confirming-completion'],
  ['validation-threw', 'confirming-completion'],
] as const satisfies readonly (readonly [DrainRejectCode, OperatorWaitReason])[]

describe('toOperatorWaitReason', () => {
  it.each(EXPECTED)("maps drain code '%s' to wire '%s'", (code, wire) => {
    // #given / #when
    const result = toOperatorWaitReason(code)

    // #then
    expect(result).toBe(wire)
  })

  it('maps every drain code the gate can report, and nothing else', () => {
    // #then the table under test covers the same set as the production code list and mapping
    expect([...DRAIN_REJECT_CODES].sort()).toEqual(EXPECTED.map(([code]) => code).sort())
    expect(Object.keys(DRAIN_REJECT_CODE_TO_WAIT_REASON).sort()).toEqual([...DRAIN_REJECT_CODES].sort())
  })

  it.each([
    'something-new',
    '',
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
    ' root-live',
    'ROOT-LIVE',
    '/workspace/repos/acme/widget/secret.txt',
  ])('never lets the unknown code %j reach the wire', code => {
    // #then
    expect(toOperatorWaitReason(code)).toBeUndefined()
  })

  it.each([undefined, null, 0, 1, true, {}, [], ['root-live'], {code: 'root-live'}])(
    'returns nothing for the non-string %j',
    value => {
      expect(toOperatorWaitReason(value)).toBeUndefined()
    },
  )

  it('only ever yields members of the closed wire set', () => {
    // #then
    for (const [, wire] of EXPECTED) expect(OPERATOR_WAIT_REASONS).toContain(wire)
    expect(OPERATOR_WAIT_REASONS).toEqual([
      'agent-working',
      'awaiting-reply',
      'awaiting-background-task',
      'confirming-completion',
    ])
  })
})

describe('isOperatorWaitReason', () => {
  it('accepts exactly the wire values', () => {
    // #then
    for (const wire of OPERATOR_WAIT_REASONS) expect(isOperatorWaitReason(wire)).toBe(true)
    expect(isOperatorWaitReason('root-live')).toBe(false)
    expect(isOperatorWaitReason('toString')).toBe(false)
    expect(isOperatorWaitReason(undefined)).toBe(false)
  })
})
