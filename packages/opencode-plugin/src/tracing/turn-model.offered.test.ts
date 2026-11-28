/** Whether a called tool was in the tool list of the request that asked for it (fro-bot/agent#2403). */

import {describe, expect, it} from 'vitest'

import {omittedContent, snapshotRequest} from './snapshot.js'
import {byCall, STEP, toolsOf, turn, turnObservations} from './turn-model.conventions.testing.js'
import {replay} from './turn-model.testing.js'

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

  it('is unset for every call of a request whose tool snapshot dropped an entry, never false', () => {
    // #given a request whose list held a tool the snapshot could not keep (not an object), so the list is incomplete
    const request = snapshotRequest({tools: {read: {description: 'Read'}, broken: 'not a tool'}})
    const records = turn(
      [
        {id: 'c1', name: 'read', messageId: STEP, succeeded: true},
        {id: 'c2', name: 'broken', messageId: STEP, succeeded: false},
        {id: 'c3', name: 'write', messageId: STEP, succeeded: false},
      ],
      {request},
    )

    // #then no call gets a verdict: a name missing from an incomplete list proves nothing, and neither does one present in it
    for (const id of ['c1', 'c2', 'c3']) expect(byCall(records, id)?.offered).toBeUndefined()
  })

  it('is unset when the request’s tool list was cut by the snapshot’s bound', () => {
    // #given a list over the snapshot's character bound
    const tools = Object.fromEntries(
      Array.from({length: 20}, (_, index) => [`t${index}`, {description: 'd'.repeat(200)}]),
    )
    const request = snapshotRequest({tools}, {limits: {toolDefinitionChars: 1_000}})
    const records = turn([{id: 'c1', name: 'write', messageId: STEP, succeeded: false}], {request})

    // #then
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

  it('is unset when attribution is lost after the call captured its request’s list, before the call ends', () => {
    // #given a call whose request was certain when it was published, and a loss that arrives while the tool still runs
    const records = turn(
      [
        {id: 'c1', name: 'write', messageId: STEP, succeeded: false, lossBeforeEnd: true},
        {id: 'c2', name: 'read', messageId: STEP, succeeded: true, lossBeforeEnd: true},
      ],
      {request: OFFERED},
    )

    // #then the verdict taken earlier is not exported, whichever way it would have gone
    expect(byCall(records, 'c1')?.offered).toBeUndefined()
    expect(byCall(records, 'c2')?.offered).toBeUndefined()
  })

  it('is unset when the tool ended before a loss that landed before its step ended, whichever way the verdict would have gone', () => {
    // #given calls that end (tool.called -> tool.ended) before a loss, and only then the step's end: one that would have been
    // true and one that would have been false
    const records = turn(
      [
        {id: 'c1', name: 'read', messageId: STEP, succeeded: true},
        {id: 'c2', name: 'write', messageId: STEP, succeeded: false},
      ],
      {request: OFFERED, lossAfterCalls: true},
    )

    // #then both tool spans still export, with no verdict: the binding the verdict rested on was withheld before it settled
    expect(byCall(records, 'c1')).toBeDefined()
    expect(byCall(records, 'c2')).toBeDefined()
    expect(byCall(records, 'c1')?.offered).toBeUndefined()
    expect(byCall(records, 'c2')?.offered).toBeUndefined()
  })

  it('still gives true and false when nothing is lost between the tool ending and its step ending', () => {
    // #given the same calls with a clean replay
    const records = turn(
      [
        {id: 'c1', name: 'read', messageId: STEP, succeeded: true},
        {id: 'c2', name: 'write', messageId: STEP, succeeded: false},
      ],
      {request: OFFERED},
    )

    // #then
    expect(byCall(records, 'c1')?.offered).toBe(true)
    expect(byCall(records, 'c2')?.offered).toBe(false)
  })

  it('exports the span without a verdict when the execution ends before its step does', () => {
    // #given a call whose step never ends: the execution ends first
    const observations = turnObservations([{id: 'c1', name: 'read', messageId: STEP, succeeded: true}], {
      request: OFFERED,
      omitStepEnd: true,
    })
    const records = replay(observations).records

    // #then the tool span exported, and nothing settled its verdict
    expect(byCall(records, 'c1')).toBeDefined()
    expect(byCall(records, 'c1')?.offered).toBeUndefined()
  })

  it('exports every tool span, and a verdict only for as many as the hold allows, when the cap is hit', () => {
    // #given more calls ending before their step than the model may hold
    const calls = Array.from({length: 5}, (_, index) => ({
      id: `c${index}`,
      name: 'read',
      messageId: STEP,
      succeeded: true,
    }))
    const records = replay(turnObservations(calls, {request: OFFERED}), {limits: {maxHeldToolSpans: 2}}).records

    // #then every span exported; the first two held their verdict, the rest exported without one
    expect(
      toolsOf(records)
        .map(record => record.callId)
        .toSorted(),
    ).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(toolsOf(records).filter(record => record.offered === true)).toHaveLength(2)
    expect(toolsOf(records).filter(record => record.offered === undefined)).toHaveLength(3)
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
