/**
 * runId → abort-handle registry for operator-initiated run cancellation.
 *
 * Exists so a transport-neutral `cancelRun` orchestrator (a later unit) can
 * abort an in-flight run by `runId` without reaching into `run.ts`'s private
 * execution primitives. The registry is the sole handle: `abort()` fires the
 * `AbortController` for the given run, and `run.ts`'s catch handler probes
 * `isAborted()` to classify the failure as an operator cancel (→ `CANCELLED`)
 * rather than a generic failure (→ `FAILED`).
 *
 * Classification via registry probe (not composite abort-reason inspection)
 * is deliberate: the run's effective signal is `AbortSignal.any([timeoutSignal,
 * cancelSignal])`, and `AbortSignal.any` propagates whichever child fired
 * first — inspecting the composite signal's `reason` for "was this a cancel"
 * is racy. The registry's own controller state is ground truth.
 *
 * Lifecycle: `register(runId)` is called after the EXECUTING transition
 * succeeds (mirrors the `inFlightRuns` set precedent below) and the entry is
 * always removed via `delete(runId)` in the run's existing outer `finally` —
 * regardless of how the run settled. This keeps the registry from leaking
 * entries for completed/failed/cancelled runs.
 */

/**
 * Attribution metadata for an operator-initiated cancel.
 *
 * Written by `cancelRun` (Unit 2) alongside `abort()` so the run's own
 * settlement path in `run.ts` (the single writer of the CANCELLED transition)
 * can read it back and thread `details.cancelledBy` onto the transition —
 * without the orchestrator reaching into run.ts's private execution state.
 */
export interface CancelledByMetadata {
  readonly githubUserId: number
  readonly login: string
  readonly sessionCorrelationId: string
  /** ISO timestamp of the cancel request. */
  readonly cancelledAt: string
}

export interface AbortRegistry {
  /**
   * Create (or return the existing) `AbortController` for `runId` and return
   * its signal. Idempotent: calling `register` twice for the same `runId`
   * returns the same signal without resetting an already-aborted controller.
   */
  readonly register: (runId: string) => AbortSignal
  /**
   * Abort the run's controller, if registered.
   *
   * `metadata`, when provided, is stored retrievably via `getMetadata` — the
   * run's own settlement path reads it back to attribute the CANCELLED
   * transition's `details.cancelledBy` (single writer = the run's own
   * settlement path, per the plan's Key Technical Decisions).
   *
   * Returns `false` (no-op) for an unknown `runId` — the run may already have
   * completed and been deleted, or may not yet be registered (the pre-ACK
   * rendezvous window; a later unit's conditional-write path covers that case).
   * Returns `true` when a registered controller was aborted (or was already
   * aborted — `AbortController.abort()` is itself a spec no-op on a second call).
   */
  readonly abort: (runId: string, reason?: unknown, metadata?: CancelledByMetadata) => boolean
  /** Whether `runId` is currently registered. */
  readonly has: (runId: string) => boolean
  /** Whether `runId`'s registered controller has been aborted. `false` for an unknown `runId`. */
  readonly isAborted: (runId: string) => boolean
  /**
   * Retrieve the attribution metadata stored by `abort()`, if any.
   * Returns `undefined` for an unknown `runId` or a run aborted without metadata
   * (e.g. the ceiling timeout, which is not operator-attributed).
   */
  readonly getMetadata: (runId: string) => CancelledByMetadata | undefined
  /** Remove the registry entry for `runId`. No-op for an unknown `runId`. */
  readonly delete: (runId: string) => void
}

/** Closure-based factory — no classes, matches the project's functional-only convention. */
export function createAbortRegistry(): AbortRegistry {
  const controllers = new Map<string, AbortController>()
  const metadataByRunId = new Map<string, CancelledByMetadata>()

  return {
    register: (runId: string): AbortSignal => {
      const existing = controllers.get(runId)
      if (existing !== undefined) {
        return existing.signal
      }
      const controller = new AbortController()
      controllers.set(runId, controller)
      return controller.signal
    },
    abort: (runId: string, reason?: unknown, metadata?: CancelledByMetadata): boolean => {
      const controller = controllers.get(runId)
      if (controller === undefined) {
        return false
      }
      if (metadata !== undefined) {
        metadataByRunId.set(runId, metadata)
      }
      controller.abort(reason)
      return true
    },
    has: (runId: string): boolean => controllers.has(runId),
    isAborted: (runId: string): boolean => controllers.get(runId)?.signal.aborted === true,
    getMetadata: (runId: string): CancelledByMetadata | undefined => metadataByRunId.get(runId),
    delete: (runId: string): void => {
      controllers.delete(runId)
      metadataByRunId.delete(runId)
    },
  }
}

/**
 * Module-scoped shared registry — mirrors the `inFlightRuns` module-level-singleton
 * precedent in `run.ts`. `run.ts` registers/probes/deletes through this instance;
 * the future `cancelRun` orchestrator calls `abort()` on the same instance.
 */
export const abortRegistry: AbortRegistry = createAbortRegistry()
