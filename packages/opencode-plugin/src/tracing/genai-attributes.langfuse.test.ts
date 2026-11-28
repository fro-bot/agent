/** Langfuse's observation type and cost details (fro-bot/agent#2403). */

import {describe, expect, it} from 'vitest'

import {chat, exported, invoke, rewritingScrubber, tool} from './genai-attributes.testing.js'

describe('langfuse.observation.type', () => {
  it.each([
    [chat(), 'generation'],
    [invoke(), 'agent'],
    [tool(), 'tool'],
  ] as const)('is set explicitly on a %# span', (record, expected) => {
    expect(exported(record).attributes['langfuse.observation.type']).toBe(expected)
  })
})

describe('langfuse.observation.cost_details', () => {
  it('is a JSON string with the total, wherever a positive cost is reported', () => {
    // #given a model call that cost money
    const span = exported(chat({cost: 0.0123}))

    // #then both the plugin's attribute and Langfuse's carry it
    expect(span.attributes['fro_bot.usage.cost_usd']).toBe(0.0123)
    expect(typeof span.attributes['langfuse.observation.cost_details']).toBe('string')
    expect(JSON.parse(String(span.attributes['langfuse.observation.cost_details']))).toEqual({total: 0.0123})
  })

  it.each([
    ['unknown', undefined],
    ['zero (OpenCode reports 0 for a model it has no price for, which Langfuse would take as a real cost)', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('is omitted when the cost is %s', (_label, cost) => {
    // #given
    const span = exported(chat({cost}))

    // #then
    expect('langfuse.observation.cost_details' in span.attributes).toBe(false)
  })

  it('goes through the scrub like every other attribute', () => {
    // #given a scrubber that rewrites every string

    // #then the value is what the scrubber made of it
    expect(exported(chat({cost: 0.5}), {}, rewritingScrubber).attributes['langfuse.observation.cost_details']).toBe(
      '[REDACTED:13]',
    )
  })
})
