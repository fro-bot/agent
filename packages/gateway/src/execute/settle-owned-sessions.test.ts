/**
 * Tests for `settleOwnedSessions` — the termination barrier `run-core.ts`'s
 * `throwWithBarrier` calls before letting a causal error escape.
 */

import type {SessionClient} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'

import {createOwnershipLedger} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {DEFAULT_SETTLE_TIMEOUT_MS, settleOwnedSessions} from './settle-owned-sessions.js'

// ---------------------------------------------------------------------------
// Test-double helpers
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeClient(
  overrides: {
    readonly abort?: (args: unknown) => Promise<unknown>
    readonly children?: (args: unknown) => Promise<unknown>
    readonly status?: (args: unknown) => Promise<unknown>
  } = {},
): SessionClient {
  return {
    session: {
      abort: vi.fn().mockImplementation(overrides.abort ?? (async () => ({data: {}, error: null}))),
      children: vi.fn().mockImplementation(overrides.children ?? (async () => ({data: [], error: null}))),
      status: vi.fn().mockImplementation(overrides.status ?? (async () => ({data: {}, error: null}))),
    },
  } as unknown as SessionClient
}

const ROOT = 'sess-root'
const CHILD = 'sess-child'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('settleOwnedSessions', () => {
  it('exports DEFAULT_SETTLE_TIMEOUT_MS', () => {
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBeGreaterThan(0)
  })

  describe('fast path — nothing to settle', () => {
    it('returns settled:true and makes zero remote calls when the ledger is already complete', async () => {
      // #given — an empty ledger (nothing was ever adopted).
      const ledger = createOwnershipLedger()
      const client = makeClient()
      const logger = makeLogger()

      // #when
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
      })

      // #then — no unnecessary abort call, no unnecessary reconcile call.
      expect(result).toEqual({settled: true})
      const sessionClient = client.session as unknown as {
        readonly abort: ReturnType<typeof vi.fn>
        readonly children: ReturnType<typeof vi.fn>
        readonly status: ReturnType<typeof vi.fn>
      }
      expect(sessionClient.abort).not.toHaveBeenCalled()
      expect(sessionClient.children).not.toHaveBeenCalled()
      expect(sessionClient.status).not.toHaveBeenCalled()
    })

    it('returns settled:true with zero remote calls when every tracked entry is already settled', async () => {
      // #given — a child adopted AND already settled before this barrier ever runs.
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      ledger.settle(CHILD)
      const client = makeClient()
      const logger = makeLogger()

      // #when
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
      })

      // #then
      expect(result).toEqual({settled: true})
      const sessionClient = client.session as unknown as {readonly abort: ReturnType<typeof vi.fn>}
      expect(sessionClient.abort).not.toHaveBeenCalled()
    })
  })

  describe('happy settle — cancel then confirm', () => {
    it('cancels the root and every unsettled entry, confirms via reconciliation, and returns settled:true', async () => {
      // #given — one outstanding child; reconciliation reports it a child of root AND no
      // longer live (settled) once queried.
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const client = makeClient({
        abort: abortSpy,
        children: async () => ({data: [{id: CHILD}], error: null}),
        status: async () => ({data: {}, error: null}),
      })
      const logger = makeLogger()

      // #when
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
      })

      // #then
      expect(result).toEqual({settled: true})
      expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
      expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
      expect(ledger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('settled')
    })

    it('threads a fresh signal to every abort call, independent of any caller-owned signal', async () => {
      // #given — the barrier must build its own teardown signal (run-core's own signal is
      // already aborted by the time this runs and cannot carry a new request).
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const seenSignals: AbortSignal[] = []
      const client = makeClient({
        abort: async (args: unknown) => {
          seenSignals.push((args as {readonly signal: AbortSignal}).signal)
          return {data: {}, error: null}
        },
        children: async () => ({data: [{id: CHILD}], error: null}),
        status: async () => ({data: {}, error: null}),
      })
      const logger = makeLogger()

      // #when
      await settleOwnedSessions({client, directory: '/workspace/repo', rootSessionId: ROOT, ledger, logger})

      // #then — every observed signal is fresh (not already aborted) and none is `undefined`.
      expect(seenSignals.length).toBeGreaterThan(0)
      for (const signal of seenSignals) {
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal.aborted).toBe(false)
      }
    })
  })

  describe('unconfirmed settlement — quarantine', () => {
    it('abort succeeds (no envelope error, nothing thrown) but confirmation still reports the child live — stays unresolved', async () => {
      // #given — the abort call itself looks entirely successful; only reconciliation
      // reveals the child is still live.
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const client = makeClient({
        abort: async () => ({data: {}, error: null}),
        children: async () => ({data: [{id: CHILD}], error: null}),
        status: async () => ({data: {[CHILD]: {}}, error: null}), // still live
      })
      const logger = makeLogger()

      // #when
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
      })

      // #then
      expect(result.settled).toBe(false)
      expect(ledger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('unknown')
    })

    it('abort returns an SDK error envelope (not a thrown exception) — checked, and settlement stays unresolved', async () => {
      // #given — a response that resolves successfully at the transport level but carries
      // an error envelope. A caller that only checks for a thrown exception would miss this.
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const abortSpy = vi.fn().mockResolvedValue({data: null, error: 'session not found'})
      const client = makeClient({
        abort: abortSpy,
        children: async () => ({data: [{id: CHILD}], error: null}),
        status: async () => ({data: {[CHILD]: {}}, error: null}),
      })
      const logger = makeLogger()

      // #when
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
      })

      // #then — the envelope error was observed (logged) and settlement is unresolved.
      expect(abortSpy).toHaveBeenCalled()
      expect(result.settled).toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({detail: 'session not found'}),
        expect.stringContaining('error envelope'),
      )
    })

    it('abort throws (transport failure) — caught, logged, and settlement stays unresolved rather than propagating', async () => {
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const client = makeClient({
        abort: async () => {
          throw new Error('ECONNRESET')
        },
        children: async () => ({data: [{id: CHILD}], error: null}),
        status: async () => ({data: {[CHILD]: {}}, error: null}),
      })
      const logger = makeLogger()

      // #when / #then — never rejects, even though every abort call threw.
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
      })
      expect(result.settled).toBe(false)
    })

    it('a hung abort call still resolves into quarantine within the bound, never hanging the caller', async () => {
      // #given — session.abort never resolves at all (the SDK client ignoring its signal).
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const client = makeClient({
        abort: async () =>
          new Promise(() => {
            /* never resolves */
          }),
      })
      const logger = makeLogger()

      // #when — bounded by a short override so the test does not wait DEFAULT_SETTLE_TIMEOUT_MS.
      const start = Date.now()
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
        timeoutMs: 50,
      })
      const elapsedMs = Date.now() - start

      // #then — quarantined, and resolved close to the bound (not hung indefinitely).
      expect(result.settled).toBe(false)
      expect(elapsedMs).toBeLessThan(1_000)
    })

    it('a hung confirmation call (reconciliation) still resolves into quarantine within the bound', async () => {
      // #given — abort succeeds promptly, but the confirmation round (session.children /
      // session.status) never resolves.
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const client = makeClient({
        abort: async () => ({data: {}, error: null}),
        children: async () => new Promise(() => {}),
        status: async () => new Promise(() => {}),
      })
      const logger = makeLogger()

      // #when
      const start = Date.now()
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger,
        timeoutMs: 50,
      })
      const elapsedMs = Date.now() - start

      // #then
      expect(result.settled).toBe(false)
      expect(elapsedMs).toBeLessThan(1_000)
    })
  })
})
