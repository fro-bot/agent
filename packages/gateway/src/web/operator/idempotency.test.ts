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
    it('evicts the oldest entry when the cap is reached', () => {
      // #given — cap of 2 entries
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
  })

  describe('defaults', () => {
    it('exports the expected default TTL', () => {
      expect(IDEMPOTENCY_TTL_MS).toBe(10 * 60 * 1000)
    })

    it('exports the expected default max entries', () => {
      expect(IDEMPOTENCY_MAX_ENTRIES).toBe(10_000)
    })
  })
})
