/**
 * Tests for the minimal web StatusSink and ReplySink implementations.
 */

import {describe, expect, it, vi} from 'vitest'
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
  type ObserveOutputFn = (text: string, opts?: {final?: boolean; droppedCount?: number}) => void

  function makeDeps(overrides?: {observeOutput?: ObserveOutputFn}) {
    return {
      runId: 'run-abc-123',
      observeOutput: overrides?.observeOutput ?? vi.fn<ObserveOutputFn>(),
    }
  }

  it('append accumulates text in the buffer', () => {
    // #given
    const sink = createWebReplySink(makeDeps())

    // #when
    sink.append('hello ')
    sink.append('world')

    // #then
    expect(sink.buffered()).toBe('hello world')
  })

  it('append calls observeOutput with each delta text', () => {
    // #given
    const observeOutput = vi.fn<ObserveOutputFn>()
    const sink = createWebReplySink(makeDeps({observeOutput}))

    // #when
    sink.append('a')
    sink.append('b')

    // #then — two delta calls, each with the appended text
    expect(observeOutput).toHaveBeenCalledTimes(2)
    expect(observeOutput).toHaveBeenNthCalledWith(1, 'a')
    expect(observeOutput).toHaveBeenNthCalledWith(2, 'b')
  })

  it('flush calls observeOutput with the full buffer and final:true', async () => {
    // #given
    const observeOutput = vi.fn<ObserveOutputFn>()
    const sink = createWebReplySink(makeDeps({observeOutput}))
    sink.append('hello ')
    sink.append('world')
    observeOutput.mockClear() // clear the append calls

    // #when
    const result = await sink.flush()

    // #then — one final call with the full buffer
    expect(observeOutput).toHaveBeenCalledTimes(1)
    expect(observeOutput).toHaveBeenCalledWith('hello world', {final: true})
    expect(result).toBeUndefined()
  })

  it('flush with empty buffer still calls observeOutput with empty string and final:true', async () => {
    // #given — no appends before flush
    const observeOutput = vi.fn<ObserveOutputFn>()
    const sink = createWebReplySink(makeDeps({observeOutput}))

    // #when
    const result = await sink.flush()

    // #then — empty-final backstop: guarantees a terminal output frame even with no output
    expect(observeOutput).toHaveBeenCalledTimes(1)
    expect(observeOutput).toHaveBeenCalledWith('', {final: true})
    expect(result).toBeUndefined()
  })

  it('buffered returns accumulated text without flushing', () => {
    // #given
    const sink = createWebReplySink(makeDeps())
    sink.append('partial')

    // #when
    const text = sink.buffered()

    // #then — buffer is unchanged after read
    expect(text).toBe('partial')
    expect(sink.buffered()).toBe('partial')
  })

  it('hasVisibleOutput returns false initially', () => {
    // #given
    const sink = createWebReplySink(makeDeps())

    // #when / #then
    expect(sink.hasVisibleOutput()).toBe(false)
  })

  it('markVisibleOutputSent causes hasVisibleOutput to return true', () => {
    // #given
    const sink = createWebReplySink(makeDeps())

    // #when
    sink.markVisibleOutputSent()

    // #then
    expect(sink.hasVisibleOutput()).toBe(true)
  })

  it('markVisibleOutputPending causes hasVisibleOutput to return true while pending', () => {
    // #given
    const sink = createWebReplySink(makeDeps())

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
    const sink = createWebReplySink(makeDeps())

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
    const sink = createWebReplySink(makeDeps())

    // #when
    const result = await sink.send('source', {content: 'hello'})

    // #then
    expect(result).toBeUndefined()
  })

  it('send with thread target is also a no-op', async () => {
    // #given
    const sink = createWebReplySink(makeDeps())

    // #when
    const result = await sink.send('thread', {content: 'error message'})

    // #then
    expect(result).toBeUndefined()
  })
})
