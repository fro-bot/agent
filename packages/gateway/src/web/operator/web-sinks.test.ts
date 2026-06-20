/**
 * Tests for the minimal web StatusSink and ReplySink implementations.
 */

import {describe, expect, it} from 'vitest'
import {createWebReplySink, createWebStatusSink} from './web-sinks.js'

describe('createWebStatusSink', () => {
  it('noteActivity is a no-op (does not throw)', () => {
    // #given
    const sink = createWebStatusSink()

    // #when / #then — no throw
    expect(() => sink.noteActivity('doing something')).not.toThrow()
  })

  it('setBusy is a no-op (does not throw)', () => {
    // #given
    const sink = createWebStatusSink()

    // #when / #then
    expect(() => sink.setBusy(true)).not.toThrow()
    expect(() => sink.setBusy(false)).not.toThrow()
  })

  it('resolveToAnswer returns delegated', async () => {
    // #given
    const sink = createWebStatusSink()

    // #when
    const result = await sink.resolveToAnswer('some answer text')

    // #then — engine must flush via replySink
    expect(result).toEqual({transition: 'delegated'})
  })

  it('resolveToFailure returns delegated', async () => {
    // #given
    const sink = createWebStatusSink()

    // #when
    const result = await sink.resolveToFailure('something went wrong')

    // #then — engine must send via replySink
    expect(result).toEqual({transition: 'delegated'})
  })

  it('dispose resolves without throwing', async () => {
    // #given
    const sink = createWebStatusSink()

    // #when / #then
    await expect(sink.dispose()).resolves.toBeUndefined()
  })

  it('setReaction is a no-op (does not throw)', () => {
    // #given
    const sink = createWebStatusSink()

    // #when / #then
    expect(() => sink.setReaction('working')).not.toThrow()
    expect(() => sink.setReaction('awaiting-approval')).not.toThrow()
    expect(() => sink.setReaction('succeeded')).not.toThrow()
    expect(() => sink.setReaction('failed')).not.toThrow()
  })
})

describe('createWebReplySink', () => {
  it('append accumulates text in the buffer', () => {
    // #given
    const sink = createWebReplySink()

    // #when
    sink.append('hello ')
    sink.append('world')

    // #then
    expect(sink.buffered()).toBe('hello world')
  })

  it('flush is a no-op and resolves', async () => {
    // #given
    const sink = createWebReplySink()
    sink.append('some output')

    // #when
    const result = await sink.flush()

    // #then — no-op, returns undefined
    expect(result).toBeUndefined()
  })

  it('buffered returns accumulated text without flushing', () => {
    // #given
    const sink = createWebReplySink()
    sink.append('partial')

    // #when
    const text = sink.buffered()

    // #then — buffer is unchanged after read
    expect(text).toBe('partial')
    expect(sink.buffered()).toBe('partial')
  })

  it('hasVisibleOutput returns false initially', () => {
    // #given
    const sink = createWebReplySink()

    // #when / #then
    expect(sink.hasVisibleOutput()).toBe(false)
  })

  it('markVisibleOutputSent causes hasVisibleOutput to return true', () => {
    // #given
    const sink = createWebReplySink()

    // #when
    sink.markVisibleOutputSent()

    // #then
    expect(sink.hasVisibleOutput()).toBe(true)
  })

  it('markVisibleOutputPending causes hasVisibleOutput to return true while pending', () => {
    // #given
    const sink = createWebReplySink()

    // #when
    const settle = sink.markVisibleOutputPending()

    // #then — pending
    expect(sink.hasVisibleOutput()).toBe(true)

    // #when — settle as delivered
    settle(true)

    // #then — still true (permanently delivered)
    expect(sink.hasVisibleOutput()).toBe(true)
  })

  it('markVisibleOutputPending settle(false) retracts the pending claim', () => {
    // #given
    const sink = createWebReplySink()

    // #when
    const settle = sink.markVisibleOutputPending()
    expect(sink.hasVisibleOutput()).toBe(true)

    // #when — settle as not delivered
    settle(false)

    // #then — retracted
    expect(sink.hasVisibleOutput()).toBe(false)
  })

  it('send is a no-op and resolves', async () => {
    // #given
    const sink = createWebReplySink()

    // #when
    const result = await sink.send('source', {content: 'hello'})

    // #then
    expect(result).toBeUndefined()
  })

  it('send with thread target is also a no-op', async () => {
    // #given
    const sink = createWebReplySink()

    // #when
    const result = await sink.send('thread', {content: 'error message'})

    // #then
    expect(result).toBeUndefined()
  })
})
