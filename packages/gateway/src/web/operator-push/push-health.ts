/**
 * Passive, in-memory operator push health tracker.
 *
 * Reports a single coarse status for the authenticated `GET /operator/session`
 * response. It never probes, polls, persists, or performs I/O: it only records
 * outcomes of store and dispatch operations that already happen, and derives the
 * status from those records when read.
 *
 * Status semantics:
 *   - `disabled`  push was never configured.
 *   - `ready`     the subsystem was OBSERVED working recently. This is not a
 *                 guarantee that a notification reaches a browser — a relay
 *                 "accepted" is not proof of receipt.
 *   - `degraded`  the startup CAS self-test failed, or the most recent fresh
 *                 observation of a component failed.
 *   - `unknown`   configured but nothing fresh has been observed (startup still
 *                 pending, or every observation is older than the staleness
 *                 window). Stale never means "still healthy".
 *
 * Components are tracked separately so one kind of success cannot erase another
 * kind of failure: store reads, store writes, and relay delivery each keep only
 * their latest outcome. There is deliberately no sticky "ever failed" flag.
 *
 * Privacy: holds three outcomes and three timestamps — no endpoints, hashes,
 * operator ids, trigger kinds, counts, or error text — and exposes only the
 * coarse status.
 */

export const PUSH_HEALTH_STALENESS_MS = 60 * 60 * 1000

export type PushHealthStatus = 'disabled' | 'ready' | 'degraded' | 'unknown'

export type PushHealthOutcome = 'ok' | 'failed'

export type PushHealthBackendKind = 'read' | 'write'

export interface PushHealthTrackerDeps {
  /** Injected clock (ms since epoch) so staleness is testable. */
  readonly clock: () => number
  /** Observations older than this are stale. Defaults to one hour. */
  readonly stalenessMs?: number
}

export interface PushHealthTracker {
  /** Push is configured. Until called, the status is `disabled`. */
  readonly markConfigured: () => void
  /** Outcome of the startup CAS self-test. A failure holds `degraded` until restart. */
  readonly recordStartup: (outcome: 'passed' | 'failed') => void
  /** Outcome of a store backend operation. Policy denials must NOT be reported here. */
  readonly recordBackend: (kind: PushHealthBackendKind, outcome: PushHealthOutcome) => void
  /** Outcome of a broadcast that actually attempted relay delivery. */
  readonly recordRelay: (outcome: PushHealthOutcome) => void
  /** Pure derivation from in-memory state. Performs no I/O. */
  readonly getStatus: () => PushHealthStatus
}

interface Observation {
  readonly outcome: PushHealthOutcome
  readonly atMs: number
}

export function createPushHealthTracker(deps: PushHealthTrackerDeps): PushHealthTracker {
  const {clock} = deps
  const stalenessMs = deps.stalenessMs ?? PUSH_HEALTH_STALENESS_MS

  let configured = false
  let startupFailed = false
  let read: Observation | undefined
  let write: Observation | undefined
  let relay: Observation | undefined

  function markConfigured(): void {
    configured = true
  }

  function recordStartup(outcome: 'passed' | 'failed'): void {
    configured = true
    if (outcome === 'failed') {
      startupFailed = true
      return
    }
    // The CAS self-test exercises the store's read and write paths, so a pass
    // is a fresh backend observation of both.
    const observation: Observation = {outcome: 'ok', atMs: clock()}
    read = observation
    write = observation
  }

  function recordBackend(kind: PushHealthBackendKind, outcome: PushHealthOutcome): void {
    const observation: Observation = {outcome, atMs: clock()}
    if (kind === 'read') {
      read = observation
    } else {
      write = observation
    }
  }

  function recordRelay(outcome: PushHealthOutcome): void {
    relay = {outcome, atMs: clock()}
  }

  function getStatus(): PushHealthStatus {
    if (configured === false) {
      return 'disabled'
    }
    if (startupFailed === true) {
      return 'degraded'
    }

    const nowMs = clock()
    const observations = [read, write, relay].filter(
      (observation): observation is Observation => observation !== undefined,
    )

    let freshOk = false
    let staleFailure = false
    for (const observation of observations) {
      const fresh = nowMs - observation.atMs < stalenessMs
      if (fresh === true && observation.outcome === 'failed') {
        return 'degraded'
      }
      if (fresh === true) {
        freshOk = true
      } else if (observation.outcome === 'failed') {
        staleFailure = true
      }
    }

    // A failure that has aged out is not evidence of recovery: without a newer
    // observation of that component we cannot call the subsystem ready.
    if (freshOk === true && staleFailure === false) {
      return 'ready'
    }
    return 'unknown'
  }

  return {markConfigured, recordStartup, recordBackend, recordRelay, getStatus}
}
