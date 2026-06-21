/**
 * Tests for the per-operator bounded in-memory idempotency guard.
 */

import {describe, expect, it} from 'vitest'
import {createIdempotencyGuard, IDEMPOTENCY_MAX_ENTRIES, IDEMPOTENCY_TTL_MS} from './idempotency.js'

describe('createIdempotencyGuard', () => {
  describe('check — new key', () => {
    it('returns undefined for a key that has never been recorded', () => {
      // #given
      const guard = createIdempotencyGuard()

      // #when
      const result = guard.check(1, 'key-a')

      // #then
      expect(result).toBeUndefined()
    })
  })

  describe('record + check — happy path', () => {
    it('returns the recorded runId for a live key', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.record(1, 'key-a', 'run-1')

      // #when
      const result = guard.check(1, 'key-a')

      // #then
      expect(result).toBe('run-1')
    })
  })

  describe('operator isolation — security', () => {
    it('operator A key does NOT suppress operator B launch with the same client key', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.record(1, 'shared-key', 'run-for-operator-1')

      // #when — operator B checks the same client key
      const resultForB = guard.check(2, 'shared-key')

      // #then — operator B sees no prior entry (different namespace)
      expect(resultForB).toBeUndefined()
    })

    it('same operator + same key → echoes the prior runId (exactly-once)', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.record(42, 'my-key', 'run-abc')

      // #when — same operator submits again
      const result = guard.check(42, 'my-key')

      // #then — echoes the prior runId
      expect(result).toBe('run-abc')
    })

    it('different operators with different keys are fully independent', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.record(1, 'key-x', 'run-1')
      guard.record(2, 'key-x', 'run-2')

      // #when
      const resultA = guard.check(1, 'key-x')
      const resultB = guard.check(2, 'key-x')

      // #then — each operator sees their own runId
      expect(resultA).toBe('run-1')
      expect(resultB).toBe('run-2')
    })
  })

  describe('TTL expiry', () => {
    it('returns undefined for an expired entry', () => {
      // #given — clock starts at 0; entry expires at ttlMs
      let nowMs = 0
      const guard = createIdempotencyGuard({now: () => nowMs, ttlMs: 1000})
      guard.record(1, 'key-a', 'run-1')

      // #when — advance past TTL
      nowMs = 1001

      // #then — entry is expired
      expect(guard.check(1, 'key-a')).toBeUndefined()
    })

    it('returns the runId for an entry that has not yet expired', () => {
      // #given
      let nowMs = 0
      const guard = createIdempotencyGuard({now: () => nowMs, ttlMs: 1000})
      guard.record(1, 'key-a', 'run-1')

      // #when — advance to just before TTL
      nowMs = 999

      // #then — entry is still live
      expect(guard.check(1, 'key-a')).toBe('run-1')
    })
  })

  describe('bounded store — eviction', () => {
    it('evicts the oldest entry when the cap is reached (all live)', () => {
      // #given — cap of 2 entries, all live
      const guard = createIdempotencyGuard({maxEntries: 2})
      guard.record(1, 'key-a', 'run-a')
      guard.record(1, 'key-b', 'run-b')

      // #when — insert a third entry (cap exceeded)
      guard.record(1, 'key-c', 'run-c')

      // #then — oldest entry (key-a) is evicted; key-b and key-c survive
      expect(guard.check(1, 'key-a')).toBeUndefined()
      expect(guard.check(1, 'key-b')).toBe('run-b')
      expect(guard.check(1, 'key-c')).toBe('run-c')
    })

    it('evicts an expired entry before a live one when at capacity', () => {
      // #given — cap of 2 entries; key-a is expired, key-b is live
      let nowMs = 0
      const guard = createIdempotencyGuard({maxEntries: 2, now: () => nowMs, ttlMs: 1000})
      guard.record(1, 'key-a', 'run-a') // inserted at t=0, expires at t=1000
      guard.record(1, 'key-b', 'run-b') // inserted at t=0, expires at t=1000

      // Advance past key-a's TTL but keep key-b live by re-recording it
      nowMs = 1001
      guard.record(1, 'key-b', 'run-b-renewed') // update in place; expires at t=2001

      // #when — insert key-c at capacity (key-a is expired, key-b is live)
      guard.record(1, 'key-c', 'run-c')

      // #then — expired key-a is evicted; live key-b survives; key-c is inserted
      expect(guard.check(1, 'key-a')).toBeUndefined()
      expect(guard.check(1, 'key-b')).toBe('run-b-renewed')
      expect(guard.check(1, 'key-c')).toBe('run-c')
    })

    it('updating an existing key does not evict a different live key', () => {
      // #given — cap of 2 entries, both live
      const guard = createIdempotencyGuard({maxEntries: 2})
      guard.record(1, 'key-a', 'run-a')
      guard.record(1, 'key-b', 'run-b')

      // #when — update key-a in place (not a new key)
      guard.record(1, 'key-a', 'run-a-v2')

      // #then — key-b is NOT evicted; key-a is updated
      expect(guard.check(1, 'key-a')).toBe('run-a-v2')
      expect(guard.check(1, 'key-b')).toBe('run-b')
    })
  })

  describe('defaults', () => {
    it('exports the expected default TTL', () => {
      expect(IDEMPOTENCY_TTL_MS).toBe(10 * 60 * 1000)
    })

    it('exports the expected default max entries', () => {
      expect(IDEMPOTENCY_MAX_ENTRIES).toBe(10_000)
    })
  })

  // ---------------------------------------------------------------------------
  // Two-phase lifecycle: reserve → committed
  // ---------------------------------------------------------------------------

  describe('reserve — records a reserved entry', () => {
    it('check returns the reserved runId immediately after reserve', () => {
      // #given
      const guard = createIdempotencyGuard()

      // #when
      guard.reserve(1, 'key-a', 'run-1')

      // #then — check sees the reserved entry
      expect(guard.check(1, 'key-a')).toBe('run-1')
    })

    it('a second same-key request during the reservation window echoes the reserved runId (no double-launch)', () => {
      // #given — first request reserves
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-a', 'run-1')

      // #when — second request checks before commit
      const result = guard.check(1, 'key-a')

      // #then — echoes the reserved runId, does NOT return undefined (which would allow a second launch)
      expect(result).toBe('run-1')
    })

    it('reserved entry expires after TTL (abandoned reservation self-clears)', () => {
      // #given
      let nowMs = 0
      const guard = createIdempotencyGuard({now: () => nowMs, ttlMs: 1000})
      guard.reserve(1, 'key-a', 'run-1')

      // #when — advance past TTL
      nowMs = 1001

      // #then — expired reservation is gone
      expect(guard.check(1, 'key-a')).toBeUndefined()
    })

    it('reserve respects operator namespace isolation', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-x', 'run-for-op-1')

      // #when — operator B checks the same client key
      const resultB = guard.check(2, 'key-x')

      // #then — operator B sees no entry
      expect(resultB).toBeUndefined()
    })
  })

  describe('commit — promotes reserved entry to committed', () => {
    it('committed entry is visible via check', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-a', 'run-1')

      // #when
      guard.commit(1, 'key-a')

      // #then — still visible
      expect(guard.check(1, 'key-a')).toBe('run-1')
    })

    it('committed entry survives past the reserved TTL (commit refreshes expiresAt)', () => {
      // #given — short TTL so we can test expiry
      let nowMs = 0
      const guard = createIdempotencyGuard({now: () => nowMs, ttlMs: 1000})
      guard.reserve(1, 'key-a', 'run-1')

      // Advance to just before TTL expiry, then commit
      nowMs = 900
      guard.commit(1, 'key-a')

      // Advance past the original reservation TTL (t=1000)
      nowMs = 1001

      // #then — committed entry is still live (commit refreshed expiresAt to t=1900)
      expect(guard.check(1, 'key-a')).toBe('run-1')
    })

    it('commit is a no-op when the key is gone (e.g. already rolled back)', () => {
      // #given — key was never reserved
      const guard = createIdempotencyGuard()

      // #when — commit on a non-existent key
      expect(() => guard.commit(1, 'key-a')).not.toThrow()

      // #then — check still returns undefined
      expect(guard.check(1, 'key-a')).toBeUndefined()
    })

    it('same operator + same key twice (both accepted) → second echoes the committed runId', () => {
      // #given — first request goes through reserve → commit
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-a', 'run-1')
      guard.commit(1, 'key-a')

      // #when — second request checks
      const result = guard.check(1, 'key-a')

      // #then — echoes the committed runId
      expect(result).toBe('run-1')
    })
  })

  describe('rollback — removes the reservation', () => {
    it('check returns undefined after rollback (key is gone)', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-a', 'run-1')

      // #when
      guard.rollback(1, 'key-a')

      // #then — key is gone; a subsequent same-key request is NOT treated as a duplicate
      expect(guard.check(1, 'key-a')).toBeUndefined()
    })

    it('rollback is a no-op when the key is gone (idempotent)', () => {
      // #given — key was never reserved
      const guard = createIdempotencyGuard()

      // #when — rollback on a non-existent key
      expect(() => guard.rollback(1, 'key-a')).not.toThrow()

      // #then — check still returns undefined
      expect(guard.check(1, 'key-a')).toBeUndefined()
    })

    it('after rollback, a new reserve+commit cycle works normally (no stuck reservation)', () => {
      // #given — first attempt: reserve then rollback (e.g. launchWork rejected)
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-a', 'run-1')
      guard.rollback(1, 'key-a')

      // #when — second attempt: reserve + commit with a new runId
      guard.reserve(1, 'key-a', 'run-2')
      guard.commit(1, 'key-a')

      // #then — second runId is committed
      expect(guard.check(1, 'key-a')).toBe('run-2')
    })

    it('rollback respects operator namespace (only removes the right operator key)', () => {
      // #given — two operators with the same client key
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-x', 'run-op1')
      guard.reserve(2, 'key-x', 'run-op2')

      // #when — rollback operator 1's key
      guard.rollback(1, 'key-x')

      // #then — operator 1's key is gone; operator 2's key is unaffected
      expect(guard.check(1, 'key-x')).toBeUndefined()
      expect(guard.check(2, 'key-x')).toBe('run-op2')
    })
  })

  describe('two-phase lifecycle — integration', () => {
    it('happy path: reserve → commit → check echoes runId', () => {
      // #given
      const guard = createIdempotencyGuard()

      // #when
      guard.reserve(1, 'key-a', 'run-1')
      guard.commit(1, 'key-a')

      // #then
      expect(guard.check(1, 'key-a')).toBe('run-1')
    })

    it('reject path: reserve → rollback → check returns undefined (no dead runId)', () => {
      // #given
      const guard = createIdempotencyGuard()

      // #when
      guard.reserve(1, 'key-a', 'run-1')
      guard.rollback(1, 'key-a')

      // #then — no dead runId echoed
      expect(guard.check(1, 'key-a')).toBeUndefined()
    })

    it('reservation window: concurrent duplicate during reserve-not-committed echoes reserved runId', () => {
      // #given — first request reserves but has not committed yet
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-a', 'run-1')

      // #when — concurrent duplicate arrives (check before commit)
      const concurrentResult = guard.check(1, 'key-a')

      // #then — echoes the reserved runId (does NOT launch twice)
      expect(concurrentResult).toBe('run-1')

      // #when — first request commits
      guard.commit(1, 'key-a')

      // #then — committed runId is still echoed
      expect(guard.check(1, 'key-a')).toBe('run-1')
    })

    it('operator A key x and operator B key x → distinct entries (namespace preserved)', () => {
      // #given
      const guard = createIdempotencyGuard()
      guard.reserve(1, 'key-x', 'run-op1')
      guard.reserve(2, 'key-x', 'run-op2')
      guard.commit(1, 'key-x')
      guard.commit(2, 'key-x')

      // #when
      const resultA = guard.check(1, 'key-x')
      const resultB = guard.check(2, 'key-x')

      // #then — each operator sees their own runId
      expect(resultA).toBe('run-op1')
      expect(resultB).toBe('run-op2')
    })
  })
})
