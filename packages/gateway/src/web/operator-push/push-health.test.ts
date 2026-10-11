import type {PushHealthBackendKind, PushHealthOutcome} from './push-health.js'
import {describe, expect, it} from 'vitest'
import {createPushHealthTracker, PUSH_HEALTH_STALENESS_MS} from './push-health.js'

const HOUR = PUSH_HEALTH_STALENESS_MS

function makeTracker() {
  const time = {nowMs: 1_000_000}
  const tracker = createPushHealthTracker({clock: () => time.nowMs})
  return {
    tracker,
    time,
    /** Records an operation that starts and completes immediately. */
    backend: (kind: PushHealthBackendKind, outcome: PushHealthOutcome) =>
      tracker.recordBackend(kind, outcome, tracker.nextSequence()),
    relay: (outcome: PushHealthOutcome) => tracker.recordRelay(outcome, tracker.nextSequence()),
  }
}

describe('createPushHealthTracker — startup', () => {
  it('reports disabled until startup is recorded (push never configured)', () => {
    // #given a tracker nobody recorded startup on
    const {tracker, backend} = makeTracker()

    // #when only stray observations arrive
    backend('read', 'ok')

    // #then
    expect(tracker.getStatus()).toBe('disabled')
  })

  it('reports ready after the startup self-test passes', () => {
    // #given
    const {tracker} = makeTracker()

    // #when
    tracker.recordStartup('ok', tracker.nextSequence())

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('reports degraded after the startup self-test fails and stays degraded past the staleness window', () => {
    // #given
    const {tracker, time} = makeTracker()

    // #when
    tracker.recordStartup('failed', tracker.nextSequence())
    time.nowMs += 10 * HOUR

    // #then — unavailable until restart; an old failure is never softened to unknown
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not let later successes clear a failed startup', () => {
    // #given
    const {tracker, backend, relay} = makeTracker()
    tracker.recordStartup('failed', tracker.nextSequence())

    // #when
    backend('read', 'ok')
    backend('write', 'ok')
    relay('ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushHealthTracker — failure, recovery, staleness', () => {
  it('degrades on a backend failure, recovers on success, then goes unknown after one hour', () => {
    // #given a healthy started tracker
    const {tracker, time, backend} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())

    // #when a write fails after startup
    time.nowMs += 1000
    backend('write', 'failed')

    // #then
    expect(tracker.getStatus()).toBe('degraded')

    // #when a later write succeeds
    time.nowMs += 1000
    backend('write', 'ok')

    // #then
    expect(tracker.getStatus()).toBe('ready')

    // #when the last observation ages past one hour
    time.nowMs += HOUR

    // #then stale means unknown, never still-healthy
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('is still ready one millisecond before the staleness window and unknown exactly at it', () => {
    // #given
    const {tracker, time} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())

    // #when / #then
    time.nowMs += HOUR - 1
    expect(tracker.getStatus()).toBe('ready')
    time.nowMs += 1
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('goes unknown (not ready) when a failure ages out while other observations are fresh', () => {
    // #given a relay failure, then only fresh backend successes
    const {tracker, time, backend, relay} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    relay('failed')
    expect(tracker.getStatus()).toBe('degraded')

    // #when the relay failure goes stale but reads keep succeeding
    time.nowMs += HOUR
    backend('read', 'ok')

    // #then the stale failure is not evidence of recovery
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('has no sticky ever-failed flag: a later success of the same component clears degraded', () => {
    // #given
    const {tracker, relay} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    relay('failed')

    // #when
    relay('ok')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('reports a stable status across repeated reads with a constant clock', () => {
    // #given
    const {tracker, backend} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    backend('write', 'failed')

    // #when / #then
    expect([tracker.getStatus(), tracker.getStatus(), tracker.getStatus()]).toEqual([
      'degraded',
      'degraded',
      'degraded',
    ])
  })
})

describe('createPushHealthTracker — component isolation', () => {
  it('does not let a read success clear a write failure', () => {
    // #given
    const {tracker, backend} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    backend('write', 'failed')

    // #when
    backend('read', 'ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not let a read success clear a relay failure', () => {
    // #given
    const {tracker, backend, relay} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    relay('failed')

    // #when
    backend('read', 'ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not let a relay success clear a backend write failure', () => {
    // #given
    const {tracker, backend, relay} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    backend('write', 'failed')

    // #when
    relay('ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushHealthTracker — ordering by start', () => {
  it('does not let an older operation that finishes late clear a newer failure', () => {
    // #given an older read starts, then a newer read starts and fails
    const {tracker} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    const olderStart = tracker.nextSequence()
    const newerStart = tracker.nextSequence()
    tracker.recordBackend('read', 'failed', newerStart)
    expect(tracker.getStatus()).toBe('degraded')

    // #when the older read completes successfully afterwards
    tracker.recordBackend('read', 'ok', olderStart)

    // #then the newer failure stands
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not let an older failure that finishes late overwrite a newer success', () => {
    // #given an older write starts, then a newer write starts and succeeds
    const {tracker} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    const olderStart = tracker.nextSequence()
    const newerStart = tracker.nextSequence()
    tracker.recordBackend('write', 'ok', newerStart)

    // #when the older write fails afterwards
    tracker.recordBackend('write', 'failed', olderStart)

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('applies the same start ordering to relay observations', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    const olderStart = tracker.nextSequence()
    const newerStart = tracker.nextSequence()
    tracker.recordRelay('failed', newerStart)

    // #when an older broadcast reports success late
    tracker.recordRelay('ok', olderStart)

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushHealthTracker — clock steps', () => {
  it('treats observations as not fresh when the clock steps backward', () => {
    // #given a ready tracker
    const {tracker, time} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    expect(tracker.getStatus()).toBe('ready')

    // #when the clock steps back, so every observation has a negative age
    time.nowMs -= 30 * 60 * 1000

    // #then they must not read as fresh for another hour
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('does not report a backward-stepped failure as degraded or healthy', () => {
    // #given a fresh failure
    const {tracker, time, backend} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    backend('write', 'failed')

    // #when the clock steps back
    time.nowMs -= 5000

    // #then an observation of unknowable age cannot be called a recovery
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('ages a just-recorded observation out when the clock steps forward past the window', () => {
    // #given
    const {tracker, time} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())

    // #when the clock jumps forward by more than the window
    time.nowMs += HOUR + 1

    // #then
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('recovers once a fresh observation is recorded after a backward step', () => {
    // #given
    const {tracker, time, backend} = makeTracker()
    tracker.recordStartup('ok', tracker.nextSequence())
    time.nowMs -= 5000
    expect(tracker.getStatus()).toBe('unknown')

    // #when fresh observations of both backend components arrive on the new clock
    backend('read', 'ok')
    backend('write', 'ok')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })
})
