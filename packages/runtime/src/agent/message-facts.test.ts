import {describe, expect, it} from 'vitest'

import {hasBlockingToolPart} from './message-facts.js'

function toolPart(overrides: Record<string, unknown> = {}) {
  return {type: 'tool', state: {status: 'running'}, ...overrides}
}

describe('hasBlockingToolPart', () => {
  it('blocks on a running tool', () => {
    // #given
    const parts = [{type: 'text', text: 'working'}, toolPart()]

    // #when / #then
    expect(hasBlockingToolPart(parts)).toBe(true)
  })

  it('blocks on a completed, non-provider-executed tool', () => {
    // #given
    const parts = [toolPart({state: {status: 'completed'}})]

    // #when / #then
    expect(hasBlockingToolPart(parts)).toBe(true)
  })

  it('does not block when there are no tool parts', () => {
    // #given / #when / #then
    expect(hasBlockingToolPart([])).toBe(false)
    expect(hasBlockingToolPart([{type: 'text', text: 'done'}])).toBe(false)
  })

  it('exempts a provider-executed tool', () => {
    // #given
    const parts = [toolPart({metadata: {providerExecuted: true}})]

    // #when / #then
    expect(hasBlockingToolPart(parts)).toBe(false)
  })

  it('does not exempt a tool whose providerExecuted is not exactly true', () => {
    // #given / #when / #then
    expect(hasBlockingToolPart([toolPart({metadata: {providerExecuted: false}})])).toBe(true)
    expect(hasBlockingToolPart([toolPart({metadata: {providerExecuted: 'true'}})])).toBe(true)
  })

  it('exempts an orphaned interrupted tool', () => {
    // #given
    const parts = [toolPart({state: {status: 'error', metadata: {interrupted: true}}})]

    // #when / #then
    expect(hasBlockingToolPart(parts)).toBe(false)
  })

  it('does not exempt an errored tool that is not marked interrupted', () => {
    // #given / #when / #then
    expect(hasBlockingToolPart([toolPart({state: {status: 'error'}})])).toBe(true)
    expect(hasBlockingToolPart([toolPart({state: {status: 'error', metadata: {}}})])).toBe(true)
    expect(hasBlockingToolPart([toolPart({state: {status: 'error', metadata: {interrupted: false}}})])).toBe(true)
    expect(hasBlockingToolPart([toolPart({state: {status: 'error', metadata: {interrupted: 'true'}}})])).toBe(true)
  })

  it('does not exempt an interrupted flag on a non-error state', () => {
    // #given
    const parts = [toolPart({state: {status: 'running', metadata: {interrupted: true}}})]

    // #when / #then
    expect(hasBlockingToolPart(parts)).toBe(true)
  })

  it('blocks on a tool with a missing or malformed state', () => {
    // #given / #when / #then
    expect(hasBlockingToolPart([{type: 'tool'}])).toBe(true)
    expect(hasBlockingToolPart([toolPart({state: 'error'})])).toBe(true)
    expect(hasBlockingToolPart([toolPart({state: {status: 'error', metadata: 'interrupted'}})])).toBe(true)
  })

  it('blocks when one tool among exempt ones is pending', () => {
    // #given
    const parts = [
      toolPart({metadata: {providerExecuted: true}}),
      toolPart({state: {status: 'error', metadata: {interrupted: true}}}),
      toolPart(),
    ]

    // #when / #then
    expect(hasBlockingToolPart(parts)).toBe(true)
  })

  it('does not block when parts is not an array', () => {
    // #given / #when / #then
    expect(hasBlockingToolPart(undefined)).toBe(false)
    expect(hasBlockingToolPart(null)).toBe(false)
    expect(hasBlockingToolPart('tool')).toBe(false)
    expect(hasBlockingToolPart({0: toolPart(), length: 1})).toBe(false)
  })

  it('ignores non-object entries in the array', () => {
    // #given / #when / #then
    expect(hasBlockingToolPart([null, undefined, 'tool', 1])).toBe(false)
  })
})
