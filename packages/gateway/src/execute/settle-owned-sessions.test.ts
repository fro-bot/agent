/**
 * Tests for `settleOwnedSessions` — the termination barrier `run-core.ts`'s
 * `throwWithBarrier` calls before letting a causal error escape.
 */

import type {OwnershipLedger, SessionClient} from '@fro-bot/runtime'
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

  describe('reconciliation is scoped to the run directory', () => {
    it('does not confirm a still-live child settled: status/children are queried with the run directory', async () => {
      // #given — a child whose abort did not take effect: `session.status` reports it busy ONLY
      // for the directory it runs in, and returns an empty `{}` for any other directory.
      const directory = '/workspace/repos/owner/repo'
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const childrenSpy = vi.fn().mockResolvedValue({data: [{id: CHILD}], error: null})
      const statusSpy = vi.fn().mockImplementation(async (args?: {query?: {directory?: string}}) => ({
        data: args?.query?.directory === directory ? {[CHILD]: {type: 'busy'}} : {},
        error: null,
      }))
      const client = makeClient({children: childrenSpy, status: statusSpy})

      // #when
      const result = await settleOwnedSessions({client, directory, rootSessionId: ROOT, ledger, logger: makeLogger()})

      // #then — both reconciliation calls carried the directory, so the live child is not settled
      expect(childrenSpy).toHaveBeenCalledWith({
        path: {id: ROOT},
        query: {directory},
        signal: expect.any(AbortSignal) as AbortSignal,
      })
      expect(statusSpy).toHaveBeenCalledWith({query: {directory}, signal: expect.any(AbortSignal) as AbortSignal})
      expect(result.settled).toBe(false)
      expect(ledger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('unknown')
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

    it('an unexpected throw inside the bounded work (e.g. from reconciliation) is caught -- the barrier still returns a settlement decision instead of rejecting', async () => {
      // #given the ledger looks normal on the FIRST snapshot() call (computing `unsettled`
      // before the bounded work starts), but throws on every call after that -- simulating
      // an unexpected failure inside `reconcileLedgerOnce`, which calls `ledger.snapshot()`
      // as part of its own bookkeeping. This is NOT one of the already-caught paths
      // (`abortSession` has its own try/catch, and the SDK adapter itself catches transport
      // errors from `session.children`/`session.status`) -- it is a genuinely unexpected
      // throw from code the barrier's own try/catch must still contain.
      let snapshotCalls = 0
      const entries = [{sessionId: CHILD, label: 'background task', state: 'outstanding' as const}]
      const throwingLedger: OwnershipLedger = {
        adopt: () => {},
        settle: () => {},
        markUnknown: () => {},
        outstanding: () => 1,
        unknown: () => 0,
        isDrainComplete: () => false,
        isPersistenceSafe: () => false,
        isTracked: () => true,
        snapshot: () => {
          snapshotCalls += 1
          if (snapshotCalls > 1) {
            throw new Error('boom: unexpected ledger failure')
          }
          return entries
        },
      }
      const client = makeClient({
        abort: async () => ({data: {}, error: null}),
        children: async () => ({data: [{id: CHILD}], error: null}),
        status: async () => ({data: {}, error: null}),
      })
      const logger = makeLogger()

      // #when / #then -- never rejects, even though reconciliation threw unexpectedly
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger: throwingLedger,
        logger,
      })
      expect(result).toEqual({
        settled: false,
        reason: 'settle attempt threw unexpectedly: boom: unexpected ledger failure',
      })
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({detail: 'boom: unexpected ledger failure'}),
        expect.stringContaining('unexpected error during settle attempt'),
      )
    })

    it('the causal error a caller re-throws after a barrier failure survives unchanged, even when settlement itself threw', async () => {
      // #given the same throwing-ledger setup as above, wrapped exactly as `run-core.ts`'s
      // `throwWithBarrier` wraps it: await the barrier, then re-throw the ORIGINAL causal
      // error regardless of what settlement reports. This is the property the barrier's
      // contract exists to protect -- an unexpected throw from inside settlement must never
      // replace or mask the causal error the caller is about to (re-)throw.
      let snapshotCalls = 0
      const entries = [{sessionId: CHILD, label: 'background task', state: 'outstanding' as const}]
      const throwingLedger: OwnershipLedger = {
        adopt: () => {},
        settle: () => {},
        markUnknown: () => {},
        outstanding: () => 1,
        unknown: () => 0,
        isDrainComplete: () => false,
        isPersistenceSafe: () => false,
        isTracked: () => true,
        snapshot: () => {
          snapshotCalls += 1
          if (snapshotCalls > 1) {
            throw new Error('boom: unexpected ledger failure')
          }
          return entries
        },
      }
      const client = makeClient({
        abort: async () => ({data: {}, error: null}),
        children: async () => ({data: [{id: CHILD}], error: null}),
        status: async () => ({data: {}, error: null}),
      })
      const logger = makeLogger()
      const causalError = new Error('session error: the ORIGINAL failure this run is reporting')

      // #when -- a `throwWithBarrier`-shaped caller: await settlement, then always re-throw
      // the causal error
      const throwWithBarrier = async (): Promise<never> => {
        await settleOwnedSessions({
          client,
          directory: '/workspace/repo',
          rootSessionId: ROOT,
          ledger: throwingLedger,
          logger,
        })
        throw causalError
      }

      // #then the exact causal error escapes, unchanged -- never replaced by the settlement
      // barrier's own internal failure
      await expect(throwWithBarrier()).rejects.toThrow(causalError)
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

      // #and the entry the confirmation never answered for is unknown, not left outstanding
      expect(ledger.snapshot()).toEqual([{sessionId: CHILD, label: 'background task', state: 'unknown'}])
    })
  })

  describe('settle timeout — what is left in the ledger', () => {
    it('marks every unsettled tracked entry unknown when the bound runs out, and leaves a settled one alone', async () => {
      // #given — one outstanding, one already unknown, one settled; the abort never answers
      const ledger = createOwnershipLedger()
      ledger.adopt('sess-a', 'outstanding task')
      ledger.adopt('sess-b', 'unknown task')
      ledger.markUnknown('sess-b')
      ledger.adopt('sess-c', 'settled task')
      ledger.settle('sess-c')
      const client = makeClient({
        abort: async () =>
          new Promise(() => {
            /* never resolves */
          }),
      })

      // #when
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
        timeoutMs: 50,
      })

      // #then — quarantine, and the ledger says honestly that nothing was confirmed
      expect(result.settled).toBe(false)
      expect(ledger.snapshot()).toEqual([
        {sessionId: 'sess-a', label: 'outstanding task', state: 'unknown'},
        {sessionId: 'sess-b', label: 'unknown task', state: 'unknown'},
        {sessionId: 'sess-c', label: 'settled task', state: 'settled'},
      ])
      expect(ledger.isDrainComplete()).toBe(false)
    })

    it('does not let a confirmation that answers after the bound settle an entry', async () => {
      // #given — the confirmation answers late, and says the child is a child of the root and no longer live
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const lateAnswers: (() => void)[] = []
      const client = makeClient({
        abort: async () => ({data: {}, error: null}),
        children: async () =>
          new Promise(resolve => {
            lateAnswers.push(() => resolve({data: [{id: CHILD}], error: null}))
          }),
        status: async () => ({data: {}, error: null}),
      })

      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
        timeoutMs: 50,
      })
      expect(result.settled).toBe(false)

      // #when — the abandoned confirmation finally answers
      for (const answer of lateAnswers) answer()
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20)
      })

      // #then — the decision already made stands
      expect(ledger.snapshot()).toEqual([{sessionId: CHILD, label: 'background task', state: 'unknown'}])
    })

    it('hands the confirmation the same teardown signal the aborts use', async () => {
      // #given
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const abortSignals: AbortSignal[] = []
      const childrenSignals: AbortSignal[] = []
      const client = makeClient({
        abort: async args => {
          abortSignals.push((args as {signal: AbortSignal}).signal)
          return {data: {}, error: null}
        },
        children: async args => {
          childrenSignals.push((args as {signal: AbortSignal}).signal)
          return {data: [{id: CHILD}], error: null}
        },
        status: async () => ({data: {}, error: null}),
      })

      // #when
      await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
      })

      // #then — one signal for the whole attempt, so the bound that ends the attempt also ends the request
      expect(childrenSignals).toHaveLength(1)
      expect(childrenSignals[0]).toBeInstanceOf(AbortSignal)
      expect(abortSignals.every(signal => signal === childrenSignals[0])).toBe(true)
    })
  })
  describe('confirming a root that was prompted', () => {
    it('confirms and releases on absence after an abort sent right after promptAsync returned', async () => {
      // #given a root aborted immediately after the 204: on OpenCode 1.19.0 the abort wins even before any busy
      // status exists (live probe: the session never goes busy, nothing runs, and the assistant turn is created
      // and completed with MessageAbortedError), so the live set never shows the root
      const ledger = createOwnershipLedger()
      const client = makeClient({status: async () => ({data: {}, error: null})})

      // #when
      const result = await settleOwnedSessions({
        client,
        directory: '/workspace/repo',
        rootSessionId: ROOT,
        ledger,
        logger: makeLogger(),
        confirmRootQuiescent: true,
        rootPollIntervalMs: 5,
      })

      // #then absence after the abort is the confirmation: one abort, no extra evidence required
      expect(result).toEqual({settled: true})
      const session = client.session as unknown as {
        readonly abort: ReturnType<typeof vi.fn>
        readonly status: ReturnType<typeof vi.fn>
      }
      expect(session.abort).toHaveBeenCalledTimes(1)
      expect(session.abort).toHaveBeenCalledWith(expect.objectContaining({path: {id: ROOT}}))
      expect(session.status).toHaveBeenCalledTimes(1)
    })
  })
})

/** Every logger call as `[level, context, message]`, across all levels. */
function loggedCalls(logger: GatewayLogger): readonly (readonly [string, Record<string, unknown>, string])[] {
  const levels = ['debug', 'info', 'warn', 'error'] as const
  return levels.flatMap(level =>
    (logger[level] as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      call => [level, call[0] as Record<string, unknown>, call[1] as string] as const,
    ),
  )
}

describe('settleOwnedSessions: run correlation in logs', () => {
  const RUN_ID = 'run-1889-correlation'

  it('stamps the run id on the start and success logs of a settled run', async () => {
    // #given an outstanding child that the confirmation round finds settled
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'background task')
    const client = makeClient({
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
      runId: RUN_ID,
    })

    // #then the opening warning, the closing info line and the reconciliation lines in between all carry the run id
    expect(result).toEqual({settled: true})
    const calls = loggedCalls(logger)
    const messages = calls.map(([, , message]) => message)
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('run failed with owned work still outstanding'),
        'settle-owned-sessions: owned work confirmed settled',
      ]),
    )
    expect(calls.length).toBeGreaterThan(2)
    for (const [, context] of calls) {
      expect(context.runId).toBe(RUN_ID)
    }
  })

  it('stamps the run id on abort-error, abort-throw and unconfirmed-settlement logs', async () => {
    // #given an envelope error on the root abort, a throw on the child abort, and a child that stays live
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'background task')
    const client = makeClient({
      abort: async (args: unknown) => {
        if ((args as {path: {id: string}}).path.id === ROOT) return {data: null, error: 'session not found'}
        throw new Error('ECONNRESET')
      },
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
      runId: RUN_ID,
    })

    // #then every emitted line, whatever its level, is attributable to the run
    expect(result.settled).toBe(false)
    const calls = loggedCalls(logger)
    const messages = calls.map(([, , message]) => message)
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('error envelope'),
        expect.stringContaining('session.abort threw'),
        expect.stringContaining('could not be confirmed settled'),
      ]),
    )
    for (const [, context] of calls) {
      expect(context.runId).toBe(RUN_ID)
    }
  })

  it('stamps the run id on the bound-exceeded log', async () => {
    // #given an abort that never answers
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'background task')
    const client = makeClient({abort: async () => new Promise(() => {})})
    const logger = makeLogger()

    // #when
    const result = await settleOwnedSessions({
      client,
      directory: '/workspace/repo',
      rootSessionId: ROOT,
      ledger,
      logger,
      runId: RUN_ID,
      timeoutMs: 50,
    })

    // #then
    expect(result.settled).toBe(false)
    const calls = loggedCalls(logger)
    expect(calls.map(([, , message]) => message)).toContain(
      'settle-owned-sessions: settle attempt exceeded its bound — quarantining rather than hanging',
    )
    for (const [, context] of calls) {
      expect(context.runId).toBe(RUN_ID)
    }
  })

  it('stamps the run id on the unexpected-error log', async () => {
    // #given a ledger whose snapshot throws once the settle attempt is underway
    let snapshotCalls = 0
    const entries = [{sessionId: CHILD, label: 'background task', state: 'outstanding' as const}]
    const throwingLedger: OwnershipLedger = {
      adopt: () => {},
      settle: () => {},
      markUnknown: () => {},
      outstanding: () => 1,
      unknown: () => 0,
      isDrainComplete: () => false,
      isPersistenceSafe: () => false,
      isTracked: () => true,
      snapshot: () => {
        snapshotCalls += 1
        if (snapshotCalls > 1) throw new Error('boom')
        return entries
      },
    }
    const logger = makeLogger()

    // #when
    await settleOwnedSessions({
      client: makeClient(),
      directory: '/workspace/repo',
      rootSessionId: ROOT,
      ledger: throwingLedger,
      logger,
      runId: RUN_ID,
    })

    // #then
    for (const [, context] of loggedCalls(logger)) {
      expect(context.runId).toBe(RUN_ID)
    }
  })

  it('leaves the log context unchanged when no run id is supplied', async () => {
    // #given
    const ledger = createOwnershipLedger()
    ledger.adopt(CHILD, 'background task')
    const client = makeClient({
      children: async () => ({data: [{id: CHILD}], error: null}),
      status: async () => ({data: {}, error: null}),
    })
    const logger = makeLogger()

    // #when
    await settleOwnedSessions({client, directory: '/workspace/repo', rootSessionId: ROOT, ledger, logger})

    // #then no `runId` key appears at all
    for (const [, context] of loggedCalls(logger)) {
      expect(Object.keys(context)).not.toContain('runId')
    }
  })
})
