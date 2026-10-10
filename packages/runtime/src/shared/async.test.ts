import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {sleep} from './async.js'

describe('sleep', () => {
  // Fake timers make the delay contract deterministic: wall-clock assertions (`elapsed < delay + slack`)
  // measure host scheduling latency, not `sleep`, and flake under load.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after specified delay, and not before', async () => {
    // #given
    const delayMs = 50
    let resolved = false

    // #when
    const pending = sleep(delayMs).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(delayMs - 1)

    // #then it has not resolved one tick early
    expect(resolved).toBe(false)

    // #when the full delay elapses
    await vi.advanceTimersByTimeAsync(1)
    await pending

    // #then
    expect(resolved).toBe(true)
  })

  it('resolves on the first timer tick for 0ms, without waiting for any further time', async () => {
    // #given
    let resolved = false

    // #when
    const pending = sleep(0).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(0)
    await pending

    // #then
    expect(resolved).toBe(true)
  })

  it('throws for negative duration', async () => {
    // #given
    const delayMs = -100

    // #when + #then
    await expect(sleep(delayMs)).rejects.toThrow('Invalid sleep duration: -100')
  })

  it('throws for NaN duration', async () => {
    // #given
    const delayMs = Number.NaN

    // #when + #then
    await expect(sleep(delayMs)).rejects.toThrow('Invalid sleep duration: NaN')
  })

  it('throws for Infinity duration', async () => {
    // #given
    const delayMs = Infinity

    // #when + #then
    await expect(sleep(delayMs)).rejects.toThrow('Invalid sleep duration: Infinity')
  })

  it('throws for negative Infinity duration', async () => {
    // #given
    const delayMs = -Infinity

    // #when + #then
    await expect(sleep(delayMs)).rejects.toThrow('Invalid sleep duration: -Infinity')
  })
})
