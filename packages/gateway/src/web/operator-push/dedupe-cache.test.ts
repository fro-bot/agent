import {describe, expect, it} from 'vitest'
import {createDedupeCache} from './dedupe-cache.js'

function createManualClock(start = 0) {
  let now = start
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('createDedupeCache', () => {
  // #given the same key dispatched twice within the window
  // #when shouldSend is called each time
  // #then only the first call returns true
  it('sends once within the dedupe window', () => {
    const {clock} = createManualClock()
    const cache = createDedupeCache({windowMs: 1000, clock})
    expect(cache.shouldSend('run-1:run_failed')).toBe(true)
    expect(cache.shouldSend('run-1:run_failed')).toBe(false)
  })

  // #given two different run ids
  // #when shouldSend is called for each
  // #then both send independently
  it('sends independently for different run ids', () => {
    const {clock} = createManualClock()
    const cache = createDedupeCache({windowMs: 1000, clock})
    expect(cache.shouldSend('run-1:run_failed')).toBe(true)
    expect(cache.shouldSend('run-2:run_failed')).toBe(true)
  })

  // #given the same run id but different notification kinds
  // #when shouldSend is called for each
  // #then both send independently
  it('sends independently for different kinds on the same run id', () => {
    const {clock} = createManualClock()
    const cache = createDedupeCache({windowMs: 1000, clock})
    expect(cache.shouldSend('run-1:run_failed')).toBe(true)
    expect(cache.shouldSend('run-1:approval')).toBe(true)
  })

  // #given a key dispatched, then the dedupe window elapses
  // #when shouldSend is called again for the same key
  // #then it sends again
  it('re-sends after the window expires', () => {
    const {clock, advance} = createManualClock()
    const cache = createDedupeCache({windowMs: 1000, clock})
    expect(cache.shouldSend('run-1:run_failed')).toBe(true)
    advance(1000)
    expect(cache.shouldSend('run-1:run_failed')).toBe(true)
  })
})
