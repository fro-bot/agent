import type {OperatorPushTriggerKind} from './index.js'

import {describe, expect, it} from 'vitest'

import {OPERATOR_PUSH_TRIGGER_KINDS} from './index.js'

describe('OPERATOR_PUSH_TRIGGER_KINDS', () => {
  it('is exactly the three push trigger kinds, in order', () => {
    // #given the tuple imported from the contract barrel
    // #when read
    // #then it is the closed set of notification-producing events
    expect(OPERATOR_PUSH_TRIGGER_KINDS).toEqual(['approval', 'question', 'run_failed'])
  })

  it('is the same value the responses module defines', async () => {
    // #given the responses module that owns the definition
    const responses = await import('./responses.js')

    // #when compared with the barrel export
    // #then the barrel re-exports it rather than copying it
    expect(OPERATOR_PUSH_TRIGGER_KINDS).toBe(responses.OPERATOR_PUSH_TRIGGER_KINDS)
  })

  it('derives the OperatorPushTriggerKind union from the tuple', () => {
    // #given every tuple member typed as the exported union
    const kinds: readonly OperatorPushTriggerKind[] = OPERATOR_PUSH_TRIGGER_KINDS

    // #when counted
    // #then each member is a distinct union member
    expect(new Set(kinds).size).toBe(OPERATOR_PUSH_TRIGGER_KINDS.length)
  })
})
