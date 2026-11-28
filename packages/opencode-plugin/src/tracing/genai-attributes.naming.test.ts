/** Span names when the agent is unknown (fro-bot/agent#2403). */

import {describe, expect, it} from 'vitest'

import {exported, invoke} from './genai-attributes.testing.js'

describe('span names without an agent', () => {
  it('is plain invoke_agent when the agent is unknown, and carries no agent attribute', () => {
    // #given a turn whose agent was never reported
    const span = exported(invoke({agent: undefined}))

    // #then
    expect(span.name).toBe('invoke_agent')
    expect(span.attributes['gen_ai.agent.name']).toBeUndefined()
  })

  it('keeps invoke_agent <name> when the agent is known', () => {
    expect(exported(invoke({agent: 'plan'})).name).toBe('invoke_agent plan')
  })
})
