import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createInactivityTimer} from './inactivity-timer.js'

describe('createInactivityTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms on create when timeoutMs > 0 and fires abort after the window elapses', () => {
    // #given — a timer with a 1000ms window
    const timer = createInactivityTimer({timeoutMs: 1000})

    // #when — no reset; advance past the window
    expect(timer.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1000)

    // #then — signal aborts
    expect(timer.signal.aborted).toBe(true)
  })

  it('reset defers firing: advancing to just-before-deadline then resetting prevents the original-deadline fire', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: 1000})

    // #when — advance to just before the deadline, then reset
    vi.advanceTimersByTime(900)
    timer.reset()
    // Advance past the ORIGINAL deadline (100ms more = 1000ms total) — should not fire
    // because reset() re-armed a fresh 1000ms window at t=900.
    vi.advanceTimersByTime(100)

    // #then — no abort yet
    expect(timer.signal.aborted).toBe(false)

    // #when — advance the full new window
    vi.advanceTimersByTime(900)

    // #then — fires
    expect(timer.signal.aborted).toBe(true)
  })

  it('pause prevents firing indefinitely', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: 1000})

    // #when
    vi.advanceTimersByTime(500)
    timer.pause()
    vi.advanceTimersByTime(10_000)

    // #then — never fires while paused
    expect(timer.signal.aborted).toBe(false)
  })

  it('resume re-arms a fresh window after pause', () => {
    // #given — paused timer
    const timer = createInactivityTimer({timeoutMs: 1000})
    vi.advanceTimersByTime(500)
    timer.pause()
    vi.advanceTimersByTime(10_000)
    expect(timer.signal.aborted).toBe(false)

    // #when — resume and advance less than the window
    timer.resume()
    vi.advanceTimersByTime(999)
    expect(timer.signal.aborted).toBe(false)

    // #then — fires once the full window elapses post-resume
    vi.advanceTimersByTime(1)
    expect(timer.signal.aborted).toBe(true)
  })

  it('dispose prevents firing', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: 1000})

    // #when
    vi.advanceTimersByTime(500)
    timer.dispose()
    vi.advanceTimersByTime(10_000)

    // #then
    expect(timer.signal.aborted).toBe(false)
  })

  it('is inert when timeoutMs is 0 — signal never aborts, methods are no-ops', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: 0})

    // #when
    timer.reset()
    timer.pause()
    timer.resume()
    vi.advanceTimersByTime(1_000_000)

    // #then
    expect(timer.signal.aborted).toBe(false)
  })

  it('is inert when timeoutMs is negative', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: -1})

    // #when
    vi.advanceTimersByTime(1_000_000)

    // #then
    expect(timer.signal.aborted).toBe(false)
  })

  it('signal.reason is distinguishable — abort() with no reason argument yields a default AbortError-like reason', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: 1000})

    // #when
    vi.advanceTimersByTime(1000)

    // #then — the signal identity itself is the distinguishing mechanism (callers compare
    // `timer.signal === abortedSignal` or `timer.signal.aborted`); reason is present but not
    // asserted structurally here since callers probe identity, not reason shape.
    expect(timer.signal.aborted).toBe(true)
    expect(timer.signal.reason).toBeDefined()
  })

  it('double-dispose is safe', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: 1000})

    // #when / #then — no throw
    expect(() => {
      timer.dispose()
      timer.dispose()
    }).not.toThrow()
    vi.advanceTimersByTime(10_000)
    expect(timer.signal.aborted).toBe(false)
  })

  it('reset after dispose is a safe no-op — does not resurrect the timer', () => {
    // #given
    const timer = createInactivityTimer({timeoutMs: 1000})
    timer.dispose()

    // #when
    expect(() => {
      timer.reset()
    }).not.toThrow()
    vi.advanceTimersByTime(10_000)

    // #then
    expect(timer.signal.aborted).toBe(false)
  })
})
