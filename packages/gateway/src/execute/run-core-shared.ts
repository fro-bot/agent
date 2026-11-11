/**
 * What the V2 gateway run loop (`run-core-v2.ts`) and the run pipeline (`run.ts`) share: the typed error `run.ts` maps to coarse Discord replies, the minimal sink the loop writes to, the
 * ledger-change wrapper, and the first-frame and abortable-stream helpers.
 *
 * Lives in its own module because `run-core-v2.ts` is already large.
 */

import type {OwnershipEntryState, OwnershipLedger} from '@fro-bot/runtime'
import type {ProviderFailureReason} from './provider-failure-v2.js'

/**
 * How long the run waits for the event stream to announce itself (`server.connected`) before it gives up on the
 * server as unreachable. The wait is also bounded by the run's own deadline and cancel, whichever comes first.
 */
export const EVENT_STREAM_CONNECT_TIMEOUT_MS = 10_000

/** Discriminant for `RunCoreError` — `run.ts` maps these to coarse Discord replies. */
export type RunCoreErrorKind =
  | 'unreachable' // network error / server not reachable
  | 'auth' // proxy rejected the bearer token (401)
  | 'session-error' // OpenCode `session.error` event received
  | 'prompt-error' // `promptAsync` returned an error
  | 'timeout' // run exceeded the configured wall-clock timeout
  | 'inactivity-timeout' // run exceeded the inactivity timeout (no text/tool progress)
  | 'stream-ended' // event stream closed before session.idle was received
  | 'missing-coordinator' // approval-required mode but no coordinator provided (fail-closed)
  | 'drain-timeout' // root session went idle with owned work outstanding and the deadline expired before it settled
  | 'checkout-substituted' // inspect() found a tree that is not the expected repository — a correctness failure, not a missing label
  | 'workspace-unavailable' // clone failed for a reason that will not resolve on its own (e.g. the repo does not exist or is inaccessible) — do not invite a retry

/**
 * Error thrown by `runOpenCodeCoreV2` on any failure path.
 *
 * The `message` field is for internal logging only — never post it to Discord.
 * `run.ts` maps `kind` to coarse user-visible replies.
 *
 * `quarantined` is `true` only when this failure passed through the
 * termination barrier (`throwWithBarrier`, see below) and the barrier could
 * NOT confirm that this run's owned background sessions actually stopped.
 * `kind` and `message` are never altered by quarantine — they always
 * describe the ORIGINAL causal failure; quarantine is additional safety
 * evidence layered on top, never a replacement explanation. `run.ts` must
 * treat a quarantined error as a signal to hold the lock, keep the heartbeat
 * renewing it, and refuse hand-off — never release or hand off resources for
 * a run whose owned work could not be confirmed settled.
 *
 * `providerFailureReason` is set only by `failFromProvider` (always with `kind: 'session-error'`): the
 * closed, fixed-text reason from the provider-failure classifier. `run.ts` reads this typed property and
 * never parses `message`. It is carried through every `throwWithBarrier` throw site, quarantined or not.
 *
 * `cause` is the underlying error when the failure wraps one (an event stream that rejected, an unexpected
 * throw in the event loop). Like `message`, it is for internal logging only.
 */
export class RunCoreError extends Error {
  readonly kind: RunCoreErrorKind
  readonly quarantined: boolean
  readonly providerFailureReason?: ProviderFailureReason

  constructor(
    kind: RunCoreErrorKind,
    internalMessage: string,
    quarantined = false,
    providerFailureReason?: ProviderFailureReason,
    cause?: unknown,
  ) {
    super(internalMessage, cause === undefined ? undefined : {cause})
    this.name = 'RunCoreError'
    this.kind = kind
    this.quarantined = quarantined
    if (providerFailureReason !== undefined) {
      this.providerFailureReason = providerFailureReason
    }
  }
}

/**
 * Minimal streaming sink interface required by `runOpenCodeCoreV2`.
 *
 * `runOpenCodeCoreV2` only calls `sink.append(text)` — it never calls `flush()`,
 * `buffered()`, or any other method. The caller (`run.ts`) is responsible for
 * flushing after `runOpenCodeCoreV2` resolves.
 *
 * Both `ReplySink` (from `execute/launch-types.ts`) and `DiscordStreamSink`
 * (from `discord/streaming.ts`) satisfy this interface structurally, so no
 * cast is needed at the call site in `run.ts`.
 */
export interface CoreStreamSink {
  /** Append a text delta to the internal buffer. */
  readonly append: (text: string) => void
}

/** Snapshot of every tracked entry's state, keyed by session id — the comparison basis for detecting a genuine mutation. */
function snapshotStates(ledger: OwnershipLedger): ReadonlyMap<string, OwnershipEntryState> {
  return new Map(ledger.snapshot().map(entry => [entry.sessionId, entry.state]))
}

function statesEqual(
  before: ReadonlyMap<string, OwnershipEntryState>,
  after: ReadonlyMap<string, OwnershipEntryState>,
): boolean {
  if (before.size !== after.size) return false
  for (const [sessionId, state] of before) {
    if (after.get(sessionId) !== state) return false
  }
  return true
}

/**
 * Wrap an `OwnershipLedger` so every mutating call also fires `onChange` —
 * used to persist ownership onto run state and to re-check drain completion
 * after every adopt/settle/markUnknown, regardless of whether the mutation
 * came from an observed dispatch event or a reconciliation pass (both go
 * through this wrapper since reconciliation is handed the wrapped instance).
 *
 * `onChange` (and, for `adopt`, `onAdopted`) only fires when the mutation
 * actually changed the ledger's tracked state. All three mutators are
 * idempotent by contract (`adopt` on an already-tracked id, `settle` on a
 * missing or already-settled entry, `markUnknown` on a missing/settled/
 * already-unknown entry are all no-ops) — firing on those calls would mean a
 * duplicate event or a repeated reconciliation pass triggers a redundant
 * remote persistence write for state that did not move. Comparing the full
 * per-session state snapshot (not just membership) is required, not just an
 * optimization: an `outstanding` → `unknown` transition keeps the session in
 * the ledger the whole time, so a membership-only comparison would miss it,
 * but it IS a real state change that must reach `onChange` so the unknown
 * entry is persisted.
 *
 * `onAdopted` is the gateway's hook point for registering a directly-observed
 * dispatch with `coordinator.addOwnedSession` — see `runOpenCodeCoreV2`. In
 * practice this fires only from the `task`-tool-completion path: reconciliation
 * never calls `adopt` (it settles or downgrades already-tracked entries only —
 * see `@fro-bot/runtime`'s `ledger-reconcile.ts` module doc), so a
 * reconciliation pass never reaches this branch. It intentionally lives here,
 * at the gateway's existing ledger-wrapping boundary, rather than as a
 * callback threaded through `reconcileLedgerOnce` in `@fro-bot/runtime`: that
 * primitive is shared with the Action, which has no coordinator concept at
 * all, and every ledger mutation — from either path — already flows through
 * this single wrapper (reconciliation is handed the wrapped ledger instance).
 * Adding a gateway-only hook here keeps the runtime primitive free of gateway
 * concepts and leaves the Action's direct, unwrapped use of
 * `createLedgerReconciler`/`reconcileLedgerOnce` untouched.
 *
 * Exported for direct unit testing of the no-op detection: through the real
 * `runOpenCodeCoreV2` → `reconcileLedgerOnce` path, `settle`/`markUnknown` can
 * only ever be called once per entry per genuine transition (the reconcile
 * loop snapshots once and skips non-outstanding/non-unknown entries), so a
 * true duplicate call cannot be forced deterministically through that
 * integration path — exercising this wrapper directly is the only reliable
 * way to prove the no-op branch itself.
 */
export function wrapLedgerWithHooks(
  ledger: OwnershipLedger,
  onChange: () => void,
  onAdopted: (sessionId: string) => void,
): OwnershipLedger {
  return {
    adopt: (sessionId, label) => {
      const before = snapshotStates(ledger)
      ledger.adopt(sessionId, label)
      const after = snapshotStates(ledger)
      if (statesEqual(before, after)) return
      onAdopted(sessionId)
      onChange()
    },
    settle: sessionId => {
      const before = snapshotStates(ledger)
      ledger.settle(sessionId)
      const after = snapshotStates(ledger)
      if (statesEqual(before, after)) return
      onChange()
    },
    markUnknown: sessionId => {
      const before = snapshotStates(ledger)
      ledger.markUnknown(sessionId)
      const after = snapshotStates(ledger)
      if (statesEqual(before, after)) return
      onChange()
    },
    release: sessionId => {
      const before = snapshotStates(ledger)
      ledger.release(sessionId)
      const after = snapshotStates(ledger)
      if (statesEqual(before, after)) return
      onChange()
    },
    outstanding: () => ledger.outstanding(),
    unknown: () => ledger.unknown(),
    isDrainComplete: () => ledger.isDrainComplete(),
    isPersistenceSafe: () => ledger.isPersistenceSafe(),
    snapshot: () => ledger.snapshot(),
    isTracked: sessionId => ledger.isTracked(sessionId),
  }
}

/** The result of waiting for the first frame of an event stream. */
type FirstEvent =
  | {readonly kind: 'frame'; readonly value: unknown}
  | {readonly kind: 'ended'}
  | {readonly kind: 'error'; readonly error: unknown}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'aborted'}

/**
 * Reads the first frame of `iterator`, bounded by `timeoutMs` and abortable. Never closes the iterator: the caller
 * decides what happens to it. A read that loses the race is left pending, with its rejection absorbed (a late failure
 * must not become an unhandled rejection), because the caller aborts the subscription that backs it.
 */
export async function awaitFirstEvent(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<FirstEvent> {
  if (signal.aborted) return {kind: 'aborted'}
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const read: Promise<FirstEvent> = iterator.next().then(
      (result): FirstEvent => (result.done === true ? {kind: 'ended'} : {kind: 'frame', value: result.value}),
      (error: unknown): FirstEvent => ({kind: 'error', error}),
    )
    const timedOut = new Promise<FirstEvent>(resolve => {
      timer = setTimeout(() => {
        resolve({kind: 'timeout'})
      }, timeoutMs)
    })
    const aborted = new Promise<FirstEvent>(resolve => {
      onAbort = () => {
        resolve({kind: 'aborted'})
      }
      signal.addEventListener('abort', onAbort, {once: true})
    })
    return await Promise.race([read, timedOut, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** An iterable over `iterator` that yields `first` (already read from it) before anything else, then the rest. */
export function resumeWith(iterator: AsyncIterator<unknown>, first: unknown): AsyncIterable<unknown> {
  let pending = true
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (pending) {
          pending = false
          return {done: false, value: first}
        }
        return iterator.next()
      },
      return: async (value?: unknown) => iterator.return?.(value) ?? {done: true, value},
    }),
  }
}

/**
 * Wrap an async iterable so that each `next()` call races against the abort
 * signal. When the signal fires while the stream is blocked waiting for the
 * next event, the generator terminates immediately rather than hanging until
 * the server sends another event.
 *
 * This is the key fix for the "silent stream" reliability issue: without this
 * wrapper the `for await` loop only checks `signal.aborted` AFTER an event
 * arrives, meaning a timed-out run can block indefinitely on a quiet stream.
 */
export async function* makeAbortableStream(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  const iterator = stream[Symbol.asyncIterator]()

  try {
    while (true) {
      // Race the next event against the abort signal.
      const nextPromise = iterator.next()

      // Build an abort promise that resolves (not rejects) so Promise.race
      // returns cleanly rather than throwing an AbortError.
      const abortPromise = new Promise<{done: true; value: undefined}>(resolve => {
        if (signal.aborted === true) {
          resolve({done: true, value: undefined})
          return
        }
        const onAbort = () => {
          resolve({done: true, value: undefined})
        }
        signal.addEventListener('abort', onAbort, {once: true})
        // Clean up the listener when the next event arrives first (resolve or reject).
        // Using .then(cleanup, cleanup) instead of .finally() to avoid creating an
        // additional microtask chain and to handle both resolve and reject paths
        // without swallowing the rejection (nextPromise rejection propagates normally
        // through Promise.race — we only need the side-effect of removing the listener).
        // eslint-disable-next-line no-void
        void nextPromise.then(
          () => {
            signal.removeEventListener('abort', onAbort)
          },
          () => {
            signal.removeEventListener('abort', onAbort)
          },
        )
      })

      const result = await Promise.race([nextPromise, abortPromise])

      if (result.done === true) return

      yield result.value
    }
  } finally {
    // Fire-and-forget: the iterator may never resolve return(); awaiting it would hang.
    // .catch avoids an unhandled rejection if return() rejects (Node 24 crashes on those).
    // eslint-disable-next-line no-void
    void iterator.return?.()?.catch(() => {})
  }
}
