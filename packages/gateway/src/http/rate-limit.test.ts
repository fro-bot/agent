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

  describe('opportunistic eviction', () => {
    it('evicts expired windows on subsequent calls', () => {
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
})
