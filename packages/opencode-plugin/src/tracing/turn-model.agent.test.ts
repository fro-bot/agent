/** The agent of tool spans and of title and compaction requests (fro-bot/agent#2403). */

import type {Observation} from './observation.js'

import {describe, expect, it} from 'vitest'

import {byCall, SES, STEP, turn} from './turn-model.conventions.testing.js'
import {replay} from './turn-model.testing.js'

describe('the agent of a tool span', () => {
  it('falls back to the owning session’s agent when the hook never fired', () => {
    // #given a refused call: no execute.before hook ran for it
    const records = turn([{id: 'c1', name: 'write', messageId: STEP, succeeded: false}])

    // #then the span still names the agent that owns the session
    expect(byCall(records, 'c1')?.agent).toBe('build')
  })

  it('prefers the agent the hook reported', () => {
    // #given a hook that names another agent
    const records = turn([{id: 'c1', name: 'read', messageId: STEP, succeeded: true, hookAgent: 'plan'}])

    // #then
    expect(byCall(records, 'c1')?.agent).toBe('plan')
  })

  it('prefers the agent of the request that asked for the call over the session’s first agent, when the session switched agents', () => {
    // #given one execution that ran a request as `build`, then switched to `plan`, whose call is refused before any hook runs
    let time = 0
    const at = (): number => (time += 1)
    const observations: Observation[] = [
      {kind: 'prompt', at: at(), sessionId: SES, messageId: 'm1', delivery: 'steer', content: 'hi'},
      {kind: 'inbox.enqueued', at: at(), sessionId: SES, inboxId: 'm1', item: 'user'},
      {kind: 'execution.started', at: at(), sessionId: SES},
      {kind: 'inbox.delivered', at: at(), sessionId: SES, inboxId: 'm1'},
    ]
    const request = (agent: string, step: string): void => {
      const hook = at()
      observations.push(
        {kind: 'request', at: hook, sessionId: SES, requestKind: 'primary', agent, model: 'm', provider: 'p'},
        {kind: 'step.started', at: at(), sessionId: SES, messageId: step, started: hook, agent},
      )
    }
    request('build', 's1')
    observations.push({
      kind: 'step.ended',
      at: at(),
      sessionId: SES,
      messageId: 's1',
      finish: 'stop',
      rawFinish: 'stop',
    })
    request('plan', 's2')
    observations.push(
      {kind: 'tool.named', at: at(), sessionId: SES, callId: 'c-plan', tool: 'write'},
      {kind: 'tool.called', at: at(), sessionId: SES, callId: 'c-plan', messageId: 's2', executed: false},
      {kind: 'tool.ended', at: at(), sessionId: SES, callId: 'c-plan', succeeded: false},
      {kind: 'step.ended', at: at(), sessionId: SES, messageId: 's2', finish: 'stop', rawFinish: 'stop'},
      {kind: 'execution.ended', at: at(), sessionId: SES, outcome: 'succeeded'},
    )

    // #when
    const refused = byCall(replay(observations).records, 'c-plan')

    // #then the span names the agent of the request that asked, not the session's first agent
    expect(refused?.agent).toBe('plan')
  })

  it('stays unset when neither the hook nor the session has an agent', () => {
    // #given a request that named no agent
    const records = turn([{id: 'c1', name: 'write', messageId: STEP, succeeded: false}], {agent: undefined})

    // #then nothing is guessed
    expect(byCall(records, 'c1')?.agent).toBeUndefined()
  })
})

describe('requests that are not an agent’s', () => {
  it.each(['title', 'compaction'] as const)(
    'records no agent for a %s request, whose name is a framework constant',
    requestKind => {
      // #given a request of that kind that reports an agent name
      const observations: Observation[] = [
        {kind: 'prompt', at: 1, sessionId: SES, messageId: 'm1', delivery: 'steer', content: 'hi'},
        {kind: 'inbox.enqueued', at: 2, sessionId: SES, inboxId: 'm1', item: 'user'},
        {kind: 'execution.started', at: 3, sessionId: SES},
        {kind: 'inbox.delivered', at: 4, sessionId: SES, inboxId: 'm1'},
        {kind: 'request', at: 5, sessionId: SES, requestKind, agent: requestKind, model: 'm', provider: 'p'},
        {kind: 'execution.ended', at: 7, sessionId: SES, outcome: 'succeeded'},
      ]

      // #when it is replayed
      const chat = replay(observations).records.find(record => record.kind === 'chat')

      // #then the span has no agent: the request kind says what it is
      expect(chat).toMatchObject({kind: 'chat', requestKind})
      expect(chat?.agent).toBeUndefined()
    },
  )

  it('still records the agent of a primary request', () => {
    // #given a primary request
    const records = turn([])

    // #then
    expect(records.find(record => record.kind === 'chat')?.agent).toBe('build')
  })
})
