/**
 * Tests for the in-memory rate limiter.
 * Pure unit tests — no network, no filesystem.
 */

import {describe, expect, it} from 'vitest'

import {createRateLimiter} from './rate-limit.js'

describe('createRateLimiter', () => {
  describe('under limit', () => {
    it('allows requests up to the configured limit', () => {
      // #given
      const limiter = createRateLimiter({limit: 3, windowMs: 60_000, clock: () => 0})

      // #when / #then — first 3 requests allowed
      expect(limiter.allow('key')).toBe(true)
      expect(limiter.allow('key')).toBe(true)
      expect(limiter.allow('key')).toBe(true)
    })
  })

  describe('at limit', () => {
    it('denies the request that would exceed the limit', () => {
      // #given — limit of 2
      const limiter = createRateLimiter({limit: 2, windowMs: 60_000, clock: () => 0})

      // Consume the limit
      limiter.allow('key')
      limiter.allow('key')

      // #when — third request
      const allowed = limiter.allow('key')

      // #then
      expect(allowed).toBe(false)
    })
  })

  describe('window reset', () => {
    it('allows again after the window expires', () => {
      // #given
      let now = 0
      const limiter = createRateLimiter({limit: 2, windowMs: 60_000, clock: () => now})

      // Exhaust the window
      limiter.allow('key')
      limiter.allow('key')
      expect(limiter.allow('key')).toBe(false)

      // #when — advance past window
      now = 60_001

      // #then — fresh window, allowed again
      expect(limiter.allow('key')).toBe(true)
    })
  })

  describe('distinct keys are independent', () => {
    it('rate limits each key separately', () => {
      // #given — limit of 1
      const limiter = createRateLimiter({limit: 1, windowMs: 60_000, clock: () => 0})

      // #when — exhaust key-a
      expect(limiter.allow('key-a')).toBe(true)
      expect(limiter.allow('key-a')).toBe(false)

      // #then — key-b is unaffected
      expect(limiter.allow('key-b')).toBe(true)
    })
  })

  describe('lazy per-key window expiry', () => {
    it('renews an expired window the next time the key is touched', () => {
      // #given — multiple keys
      let now = 0
      const limiter = createRateLimiter({limit: 1, windowMs: 60_000, clock: () => now})
      limiter.allow('key-a')
      limiter.allow('key-b')

      // #when — advance past window
      now = 60_001
      // trigger eviction via a call for a new key
      limiter.allow('key-c')

      // #then — key-a and key-b windows have been reset and are allowed again
      expect(limiter.allow('key-a')).toBe(true)
      expect(limiter.allow('key-b')).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // MAX_KEYS cap — bounded map, window-renewal FIFO eviction (#1652)
  // ---------------------------------------------------------------------------

  describe('MAX_KEYS cap — bounded, new keys are always admitted', () => {
    const MAX_KEYS = 10_000
    const WINDOW = 60_000

    /** limit-1 limiter saturated with `key-0 … key-9999`, all active in one window. */
    function makeSaturated(clock: () => number) {
      const limiter = createRateLimiter({limit: 1, windowMs: WINDOW, clock})
      for (let i = 0; i < MAX_KEYS; i++) {
        expect(limiter.allow(`key-${i}`)).toBe(true)
      }
      return limiter
    }

    it('admits a never-seen key when the map is saturated with active keys', () => {
      // #given — the map is full of active counters
      const now = 1_000_000
      const limiter = makeSaturated(() => now)

      // #when — a key that has never been seen arrives
      const admitted = limiter.allow('fresh-client')

      // #then — admitted (previously refused) and then limited like any other key
      expect(admitted).toBe(true)
      expect(limiter.allow('fresh-client')).toBe(false)
    })

    it('retains the active counters of surviving keys when a newcomer evicts the oldest', () => {
      // #given
      const now = 1_000_000
      const limiter = makeSaturated(() => now)

      // #when — one newcomer displaces exactly one key (the oldest, key-0)
      limiter.allow('fresh-client')

      // #then — every other key keeps its exhausted counter
      expect(limiter.allow('key-1')).toBe(false)
      expect(limiter.allow(`key-${MAX_KEYS - 1}`)).toBe(false)
    })

    it('accepted best-effort behavior: evicting an active key resets its bucket', () => {
      // #given — key-0 is the oldest and has used its whole allowance
      const now = 1_000_000
      const limiter = makeSaturated(() => now)
      expect(limiter.allow('key-0')).toBe(false)

      // #when — cardinality pressure evicts it
      limiter.allow('fresh-client')

      // #then — its bucket starts over: this is the documented tradeoff
      expect(limiter.allow('key-0')).toBe(true)
    })

    it('an expired-window renewal moves the key to the tail, so it outlives older keys', () => {
      // #given — saturated at t=0; at t>window every entry is expired
      let now = 0
      const limiter = makeSaturated(() => now)
      now = WINDOW + 1

      // #when — key-0 renews (delete-then-set → youngest), then a newcomer forces one eviction
      expect(limiter.allow('key-0')).toBe(true)
      now += 1
      limiter.allow('fresh-client')

      // #then — the evicted key was the oldest remaining (key-1), not the renewed key-0,
      // whose fresh counter is still enforced
      expect(limiter.allow('key-0')).toBe(false)
    })

    it('ordinary hits do not promote a key (FIFO by window start, not LRU)', () => {
      // #given — limit 2 so key-0 can be hit again without being denied
      const now = 1_000_000
      const limiter = createRateLimiter({limit: 2, windowMs: WINDOW, clock: () => now})
      for (let i = 0; i < MAX_KEYS; i++) limiter.allow(`key-${i}`)

      // #when — key-0 is hit again (a within-window hit), then a newcomer arrives
      expect(limiter.allow('key-0')).toBe(true)
      limiter.allow('fresh-client')

      // #then — key-0 was still the oldest and was evicted: its counter restarted
      // (count 1 of 2), so two more hits fit; it would be denied on the 2nd if retained
      expect(limiter.allow('key-0')).toBe(true)
      expect(limiter.allow('key-0')).toBe(true)
    })

    it('stays bounded under repeated churn of new keys', () => {
      // #given
      const now = 1_000_000
      const limiter = createRateLimiter({limit: 1, windowMs: WINDOW, clock: () => now})

      // #when — three full capacities of distinct keys flow through
      for (let i = 0; i < MAX_KEYS * 3; i++) {
        expect(limiter.allow(`churn-${i}`)).toBe(true)
      }

      // #then — only the newest MAX_KEYS remain: the newest is still counted, the oldest is gone
      expect(limiter.allow(`churn-${MAX_KEYS * 3 - 1}`)).toBe(false)
      expect(limiter.allow(`churn-${MAX_KEYS * 2}`)).toBe(false)
      expect(limiter.allow('churn-0')).toBe(true)
      expect(limiter.allow(`churn-${MAX_KEYS - 1}`)).toBe(true)
    })

    it('admits new keys again once old entries expire', () => {
      // #given
      let now = 0
      const limiter = makeSaturated(() => now)

      // #when
      now = WINDOW + 1

      // #then
      expect(limiter.allow('fresh-key')).toBe(true)
    })
  })
})
