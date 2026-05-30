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

  // ---------------------------------------------------------------------------
  // FIX 1: reserve / commit / release
  // ---------------------------------------------------------------------------

  describe('reserve → commit → reserve-again is blocked', () => {
    it('a committed sig cannot be reserved again within TTL', () => {
      // #given
      const now = 1_000_000
      const cache = createReplayCache({clock: () => now})
      const sig = 'abcdef01'

      // #when
      const reserved = cache.reserve(sig)
      cache.commit(sig, now)

      // #then — committed entry blocks further reserve
      expect(reserved).toBe(true)
      expect(cache.reserve(sig)).toBe(false)
    })
  })

  describe('reserve → release → reserve-again is allowed', () => {
    it('a released sig can be reserved again', () => {
      // #given
      const now = 1_000_000
      const cache = createReplayCache({clock: () => now})
      const sig = 'abcdef02'

      // #when
      cache.reserve(sig)
      cache.release(sig)
      const reservedAgain = cache.reserve(sig)

      // #then — released sig can be reserved once more
      expect(reservedAgain).toBe(true)
    })
  })

  describe('reserve blocks a concurrent reserve of the same sig', () => {
    it('returns false for the second reserve attempt while first is reserved', () => {
      // #given
      const now = 1_000_000
      const cache = createReplayCache({clock: () => now})
      const sig = 'abcdef03'

      // #when — first reserve succeeds
      const first = cache.reserve(sig)
      // second reserve of same sig (concurrent duplicate) — must fail
      const second = cache.reserve(sig)

      // #then
      expect(first).toBe(true)
      expect(second).toBe(false)
    })
  })

  describe('committed entry expires after TTL', () => {
    it('check returns false after window + buffer has elapsed', () => {
      // #given — reserve and commit at t=0
      let now = 0
      const cache = createReplayCache({clock: () => now})
      const sig = 'expirecommit'
      cache.reserve(sig)
      cache.commit(sig, now)
      expect(cache.check(sig)).toBe(true)

      // #when — advance past REPLAY_WINDOW_MS + buffer + 1ms
      now = REPLAY_WINDOW_MS + 60_001

      // #then — expired
      expect(cache.check(sig)).toBe(false)
    })
  })

  describe('release of a non-reserved sig is a safe no-op', () => {
    it('does not throw and does not affect other entries', () => {
      // #given
      const now = 1_000_000
      const cache = createReplayCache({clock: () => now})
      cache.record('other-sig', now)

      // #when — release a sig that was never reserved
      expect(() => cache.release('never-reserved')).not.toThrow()

      // #then — existing recorded sig unaffected
      expect(cache.check('other-sig')).toBe(true)
    })
  })
})
