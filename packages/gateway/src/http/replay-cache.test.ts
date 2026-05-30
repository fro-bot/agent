/**
 * Tests for the in-memory replay cache.
 * Pure unit tests — no network, no filesystem.
 */

import {describe, expect, it} from 'vitest'

import {REPLAY_WINDOW_MS} from './hmac.js'
import {createReplayCache} from './replay-cache.js'

describe('createReplayCache', () => {
  describe('record then check — same sig', () => {
    it('returns true for a signature that was just recorded', () => {
      // #given
      const now = 1_000_000
      const cache = createReplayCache({clock: () => now})
      const sig = 'aabbccdd'

      // #when
      cache.record(sig, now)

      // #then
      expect(cache.check(sig)).toBe(true)
    })
  })

  describe('unseen sig', () => {
    it('returns false for a signature that was never recorded', () => {
      // #given
      const cache = createReplayCache()

      // #when / #then
      expect(cache.check('deadbeef')).toBe(false)
    })
  })

  describe('expired entry', () => {
    it('returns false after TTL has elapsed and evicts the entry', () => {
      // #given — record at t=0
      let now = 0
      const cache = createReplayCache({clock: () => now})
      const sig = 'expiredentry'
      cache.record(sig, now)

      // Advance clock past REPLAY_WINDOW_MS + eviction buffer (60s) + 1ms
      now = REPLAY_WINDOW_MS + 60_001

      // #when
      const seen = cache.check(sig)

      // #then — expired → not seen
      expect(seen).toBe(false)
    })
  })

  describe('two different sigs are independent', () => {
    it('recording one sig does not affect the check of another', () => {
      // #given
      const now = 1_000_000
      const cache = createReplayCache({clock: () => now})

      // #when
      cache.record('sig-a', now)

      // #then — sig-a seen, sig-b not seen
      expect(cache.check('sig-a')).toBe(true)
      expect(cache.check('sig-b')).toBe(false)
    })
  })

  describe('opportunistic eviction', () => {
    it('evicts expired entries on subsequent calls', () => {
      // #given — record sig-a at t=0
      let now = 0
      const cache = createReplayCache({clock: () => now})
      cache.record('sig-a', now)
      cache.record('sig-b', now)

      // #when — advance past TTL then record a new sig (triggers eviction)
      now = REPLAY_WINDOW_MS + 60_001
      cache.record('sig-c', now)

      // #then — old sigs expired, new sig seen
      expect(cache.check('sig-a')).toBe(false)
      expect(cache.check('sig-b')).toBe(false)
      expect(cache.check('sig-c')).toBe(true)
    })
  })
})
