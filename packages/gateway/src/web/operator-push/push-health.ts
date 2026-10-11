/**
 * Passive in-memory operator push health: records outcomes of calls that already
 * happen and derives a coarse status on read, with no I/O. Store reads, store
 * writes and relay delivery each keep their latest-by-start observation; the
 * wire semantics of each status are documented on `OPERATOR_PUSH_HEALTH_STATUSES`
 * in `operator-contract/responses.ts`.
 */

export const PUSH_HEALTH_STALENESS_MS = 60 * 60 * 1000

export type PushHealthStatus = 'disabled' | 'ready' | 'degraded' | 'unknown'

export type PushHealthOutcome = 'ok' | 'failed'

export type PushHealthBackendKind = 'read' | 'write'

export interface PushHealthTrackerDeps {
  /** Monotonic clock (ms); only differences are used. */
  readonly clock: () => number
}

export interface PushHealthTracker {
  /** Outcome of the startup CAS self-test; also marks push configured. A failure holds `degraded` until restart. */
  readonly recordStartup: (outcome: PushHealthOutcome) => void
  /** Start ticket for an operation. Pass it back when recording so an older operation cannot overwrite a newer one. */
  readonly nextSequence: () => number
  /** Outcome of an object-store call that began at `startSequence`. */
  readonly recordBackend: (kind: PushHealthBackendKind, outcome: PushHealthOutcome, startSequence: number) => void
  /** Outcome of a broadcast that attempted delivery and began at `startSequence`. */
  readonly recordRelay: (outcome: PushHealthOutcome, startSequence: number) => void
  readonly getStatus: () => PushHealthStatus
}

interface Observation {
  readonly outcome: PushHealthOutcome
  readonly atMs: number
  readonly startSequence: number
}

export function createPushHealthTracker(deps: PushHealthTrackerDeps): PushHealthTracker {
  const {clock} = deps

  let configured = false
  let startupFailed = false
  let sequence = 0
  let read: Observation | undefined
  let write: Observation | undefined
  let relay: Observation | undefined

  function nextSequence(): number {
    sequence += 1
    return sequence
  }

  function newest(current: Observation | undefined, incoming: Observation): Observation {
    return current === undefined || incoming.startSequence > current.startSequence ? incoming : current
  }

  function recordStartup(outcome: PushHealthOutcome): void {
    configured = true
    if (outcome === 'failed') {
      startupFailed = true
      return
    }
    // The CAS self-test exercises the store's read and write paths.
    const observation: Observation = {outcome: 'ok', atMs: clock(), startSequence: nextSequence()}
    read = newest(read, observation)
    write = newest(write, observation)
  }

  function recordBackend(kind: PushHealthBackendKind, outcome: PushHealthOutcome, startSequence: number): void {
    const observation: Observation = {outcome, atMs: clock(), startSequence}
    if (kind === 'read') {
      read = newest(read, observation)
    } else {
      write = newest(write, observation)
    }
  }

  function recordRelay(outcome: PushHealthOutcome, startSequence: number): void {
    relay = newest(relay, {outcome, atMs: clock(), startSequence})
  }

  function getStatus(): PushHealthStatus {
    if (configured === false) {
      return 'disabled'
    }
    if (startupFailed === true) {
      return 'degraded'
    }

    const nowMs = clock()
    let freshOk = false
    let staleFailure = false
    for (const observation of [read, write, relay]) {
      if (observation === undefined) {
        continue
      }
      // A negative age (clock stepped back) is not fresh: it cannot be trusted to still be within the window.
      const ageMs = nowMs - observation.atMs
      const fresh = ageMs >= 0 && ageMs < PUSH_HEALTH_STALENESS_MS
      if (fresh === true && observation.outcome === 'failed') {
        return 'degraded'
      }
      if (fresh === true) {
        freshOk = true
      } else if (observation.outcome === 'failed') {
        staleFailure = true
      }
    }

    // A failure that has aged out is not evidence of recovery.
    return freshOk === true && staleFailure === false ? 'ready' : 'unknown'
  }

  return {recordStartup, nextSequence, recordBackend, recordRelay, getStatus}
}
