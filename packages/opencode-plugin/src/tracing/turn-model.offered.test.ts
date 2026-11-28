/** Whether a called tool was in the tool list of the request that asked for it (fro-bot/agent#2403). */

import {describe, expect, it} from 'vitest'

import {omittedContent} from './snapshot.js'
import {byCall, STEP, turn} from './turn-model.conventions.testing.js'

const OFFERED = {tools: {read: {description: 'Read a file'}, grep: {description: 'Search'}}}

describe('whether a called tool was offered', () => {
  it('is true for an offered tool, whether it ran or failed', () => {
    // #given a request that offered read and grep, a read that worked and a grep that failed on its own
    const records = turn(
      [
        {id: 'c1', name: 'read', messageId: STEP, succeeded: true},
        {id: 'c2', name: 'grep', messageId: STEP, succeeded: false, message: 'pattern is invalid'},
      ],
      {request: OFFERED},
    )

    // #then both were in the list
    expect(byCall(records, 'c1')?.offered).toBe(true)
    expect(byCall(records, 'c2')?.offered).toBe(true)
  })

  it('is false for OpenCode’s refusal of a tool the request did not offer', () => {
    // #given the model called write, which the request never offered; OpenCode answers with its refusal
    const records = turn(
      [
        {
          id: 'c1',
          name: 'write',
          messageId: STEP,
          succeeded: false,
          message: 'Tool is not available for this request: write',
        },
      ],
      {request: OFFERED},
    )

    // #then
    expect(byCall(records, 'c1')?.offered).toBe(false)
  })

  it('is false for OpenCode’s refusal of a name it has no tool for', () => {
    // #given
    const records = turn(
      [
        {
          id: 'c1',
          name: 'ghost',
          messageId: STEP,
          succeeded: false,
          message: 'No tool named "ghost" is currently available. Please use a tool from the available tool list.',
        },
      ],
      {request: OFFERED},
    )

    // #then
    expect(byCall(records, 'c1')?.offered).toBe(false)
  })

  it('is decided by the list, not by the failure message', () => {
    // #given a refusal-shaped message on a tool the request did offer
    const records = turn(
      [
        {
          id: 'c1',
          name: 'read',
          messageId: STEP,
          succeeded: false,
          message: 'Tool is not available for this request: read',
        },
      ],
      {request: OFFERED},
    )

    // #then the list says it was offered, so the plugin does not contradict it
    expect(byCall(records, 'c1')?.offered).toBe(true)
  })

  it('is false when the request offered nothing and the model called a tool anyway', () => {
    // #given a request whose tool list is known and empty
    const records = turn([{id: 'c1', name: 'read', messageId: STEP, succeeded: false}], {request: {tools: {}}})

    // #then
    expect(byCall(records, 'c1')?.offered).toBe(false)
  })

  it.each([
    ['the called event names no step', {messageId: undefined}, OFFERED],
    ['the called event names a step no request owns', {messageId: 'someone-else'}, OFFERED],
    ['the request’s tool list was left out of the snapshot', {}, {tools: omittedContent('snapshot-bound')}],
    ['the request carried no tool list', {}, {messages: []}],
    ['the request’s content was not captured', {}, undefined],
    ['the provider ran the tool', {executed: true}, OFFERED],
    ['the tool’s name is not known', {name: undefined}, OFFERED],
  ] as const)('is unset when %s', (_label, overrides, request) => {
    // #given a call the plugin cannot compare with a list it can trust
    const records = turn([{id: 'c1', name: 'read', messageId: STEP, succeeded: true, ...overrides}], {request})

    // #then no flag is recorded: unset, not false
    expect(byCall(records, 'c1')?.offered).toBeUndefined()
  })

  it('is unset when an observation was lost after the step bound, so its request is no longer certain', () => {
    // #given a loss between the step and its calls
    const records = turn([{id: 'c1', name: 'read', messageId: STEP, succeeded: true}], {
      request: OFFERED,
      lossBeforeCalls: true,
    })

    // #then the plugin does not vouch for the list
    expect(byCall(records, 'c1')?.offered).toBeUndefined()
  })

  it('is unset when the step could not be bound to its request', () => {
    // #given a step that carries no start time, so no request can be said to be its own
    const records = turn([{id: 'c1', name: 'read', messageId: STEP, succeeded: true}], {
      request: OFFERED,
      bindStep: false,
    })

    // #then
    expect(byCall(records, 'c1')?.offered).toBeUndefined()
  })
})
