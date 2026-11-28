/** Tool offers and the size of a request's tool list (fro-bot/agent#2403). */

import {describe, expect, it} from 'vitest'

import {chat, exported, tool} from './genai-attributes.testing.js'
import {toolDefinitionStats} from './tool-definitions.js'

describe('fro_bot.tool.offered', () => {
  it.each([true, false])('is exported as %s when the model knows it', offered => {
    expect(exported(tool({offered})).attributes['fro_bot.tool.offered']).toBe(offered)
  })

  it('is not set when the plugin could not tell: unset is not false', () => {
    // #given a tool record with no verdict
    const span = exported(tool())

    // #then the attribute is absent, not false
    expect('fro_bot.tool.offered' in span.attributes).toBe(false)
  })
})

describe('the size of the tool list on a model span', () => {
  const TOOLS = {
    read: {description: 'Read a file', input: {type: 'object', properties: {path: {type: 'string'}}}},
    grep: {description: 'Search files'},
  }
  const serialized = JSON.stringify([
    {
      type: 'function',
      name: 'read',
      description: 'Read a file',
      parameters: {type: 'object', properties: {path: {type: 'string'}}},
    },
    {type: 'function', name: 'grep', description: 'Search files'},
  ])

  it('counts the tools and measures the serialized definitions the span carries', () => {
    // #given a request that offered two tools
    const span = exported(chat({request: {tools: TOOLS}}))

    // #then the count is the tools offered and the length is that of the definitions attribute before any bound
    expect(span.attributes['fro_bot.tool_definitions.count']).toBe(2)
    expect(span.attributes['fro_bot.tool_definitions.chars']).toBe(serialized.length)
    expect(String(span.attributes['gen_ai.tool.definitions'])).toBe(serialized)
  })

  it('says zero for a request that offered no tools', () => {
    // #given a known, empty list
    const span = exported(chat({request: {tools: {}}}))

    // #then
    expect(span.attributes['fro_bot.tool_definitions.count']).toBe(0)
    expect(span.attributes['fro_bot.tool_definitions.chars']).toBe(0)
  })

  it.each([
    ['no request was captured', undefined],
    ['the request carried no tool list', {messages: []}],
    ['the snapshot left the list out', {tools: {kind: 'snapshot-omitted', reason: 'snapshot-bound'}}],
  ])('sets neither when %s', (_label, request) => {
    // #given
    const span = exported(chat({request}))

    // #then
    expect('fro_bot.tool_definitions.count' in span.attributes).toBe(false)
    expect('fro_bot.tool_definitions.chars' in span.attributes).toBe(false)
  })

  it('measures what was captured, not what the span kept after a bound', () => {
    // #given a list far over the span's ceiling for tool definitions
    const big = Object.fromEntries(
      Array.from({length: 60}, (_, index) => [`tool_${index}`, {description: 'd'.repeat(5_000)}]),
    )
    const span = exported(chat({request: {tools: big}}))

    // #then the length is the full serialized length, which is more than the attribute that was exported
    expect(Number(span.attributes['fro_bot.tool_definitions.chars'])).toBeGreaterThan(300_000)
    expect(String(span.attributes['gen_ai.tool.definitions']).length).toBeLessThan(
      Number(span.attributes['fro_bot.tool_definitions.chars']),
    )
  })

  it('is computed once per snapshot, however many spans are built from it', () => {
    // #given one frozen snapshot of the tool list
    const tools = Object.freeze({read: Object.freeze({description: 'Read'})})

    // #when two spans are built from it
    const first = toolDefinitionStats(tools)
    const second = toolDefinitionStats(tools)

    // #then the second ask is the first answer, not a second computation
    expect(second).toBe(first)
  })
})
