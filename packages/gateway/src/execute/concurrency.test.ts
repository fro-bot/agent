import {describe, expect, it} from 'vitest'

import {createConcurrencyRegistry, DEFAULT_MAX_CONCURRENT_RUNS} from './concurrency.js'

describe('createConcurrencyRegistry', () => {
  it('exports DEFAULT_MAX_CONCURRENT_RUNS = 3', () => {
    expect(DEFAULT_MAX_CONCURRENT_RUNS).toBe(3)
  })

  it('allows acquisition up to max (global cap)', () => {
    // #given
    const registry = createConcurrencyRegistry(2)

    // #when
    const r1 = registry.tryAcquire('ch-1')
    const r2 = registry.tryAcquire('ch-2')
    const r3 = registry.tryAcquire('ch-3')

    // #then
    expect(r1).toBe('ok')
    expect(r2).toBe('ok')
    expect(r3).toBe('cap')
    expect(registry.activeCount()).toBe(2)
  })

  it('blocks a second acquire for the same channel (busy)', () => {
    // #given
    const registry = createConcurrencyRegistry(3)

    // #when
    const r1 = registry.tryAcquire('ch-a')
    const r2 = registry.tryAcquire('ch-a')

    // #then — second is busy even though global cap not reached
    expect(r1).toBe('ok')
    expect(r2).toBe('busy')
    expect(registry.activeCount()).toBe(1)
  })

  it('returns cap before busy when cap is 0', () => {
    // #given
    const registry = createConcurrencyRegistry(0)

    // #when / #then
    expect(registry.tryAcquire('ch-1')).toBe('cap')
  })

  it('release decrements count and allows re-acquisition for same channel', () => {
    // #given
    const registry = createConcurrencyRegistry(2)
    registry.tryAcquire('ch-1')

    // #when
    registry.release('ch-1')
    const r2 = registry.tryAcquire('ch-1')

    // #then
    expect(r2).toBe('ok')
    expect(registry.activeCount()).toBe(1)
  })

  it('release is idempotent — calling it on an unknown channel is a no-op', () => {
    // #given
    const registry = createConcurrencyRegistry(2)
    registry.tryAcquire('ch-1')

    // #when — release a channel that was never acquired
    registry.release('ch-unknown')

    // #then — count unchanged
    expect(registry.activeCount()).toBe(1)
  })

  it('after releasing a capped slot, another channel can acquire', () => {
    // #given cap = 1
    const registry = createConcurrencyRegistry(1)
    registry.tryAcquire('ch-1')
    expect(registry.tryAcquire('ch-2')).toBe('cap')

    // #when
    registry.release('ch-1')

    // #then
    expect(registry.tryAcquire('ch-2')).toBe('ok')
  })
})
