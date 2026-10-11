import {describe, expect, it} from 'vitest'
import {createPushHealthTracker, PUSH_HEALTH_STALENESS_MS} from './push-health.js'

const HOUR = PUSH_HEALTH_STALENESS_MS

function makeTracker() {
  const time = {nowMs: 1_000_000}
  const tracker = createPushHealthTracker({clock: () => time.nowMs})
  return {tracker, time}
}

describe('createPushHealthTracker — startup', () => {
  it('reports disabled when push was never configured', () => {
    // #given a tracker nobody configured
    const {tracker} = makeTracker()

    // #then
    expect(tracker.getStatus()).toBe('disabled')
  })

  it('reports unknown when configured but startup has not resolved', () => {
    // #given
    const {tracker} = makeTracker()

    // #when
    tracker.markConfigured()

    // #then nothing observed yet — never optimistically ready
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('reports ready after the startup self-test passes', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.markConfigured()

    // #when
    tracker.recordStartup('passed')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })

  it('reports degraded after the startup self-test fails and stays degraded past the staleness window', () => {
    // #given
    const {tracker, time} = makeTracker()
    tracker.markConfigured()

    // #when
    tracker.recordStartup('failed')
    time.nowMs += 10 * HOUR

    // #then — unavailable until restart; an old failure is never softened to unknown
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not let a later backend success clear a failed startup', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.recordStartup('failed')

    // #when
    tracker.recordBackend('read', 'ok')
    tracker.recordBackend('write', 'ok')
    tracker.recordRelay('ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushHealthTracker — failure, recovery, staleness', () => {
  it('degrades on a backend failure, recovers on success, then goes unknown after one hour', () => {
    // #given a healthy started tracker
    const {tracker, time} = makeTracker()
    tracker.recordStartup('passed')

    // #when a write fails after startup
    time.nowMs += 1000
    tracker.recordBackend('write', 'failed')

    // #then
    expect(tracker.getStatus()).toBe('degraded')

    // #when a later write succeeds
    time.nowMs += 1000
    tracker.recordBackend('write', 'ok')

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
    tracker.recordStartup('passed')

    // #when / #then
    time.nowMs += HOUR - 1
    expect(tracker.getStatus()).toBe('ready')
    time.nowMs += 1
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('goes unknown (not ready) when a failure ages out while other observations are fresh', () => {
    // #given a relay failure, then only fresh backend successes
    const {tracker, time} = makeTracker()
    tracker.recordStartup('passed')
    tracker.recordRelay('failed')
    expect(tracker.getStatus()).toBe('degraded')

    // #when the relay failure goes stale but reads keep succeeding
    time.nowMs += HOUR
    tracker.recordBackend('read', 'ok')

    // #then the stale failure is not evidence of recovery
    expect(tracker.getStatus()).toBe('unknown')
  })

  it('does not keep a sticky ever-failed flag: a later fresh success of the same component clears degraded', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.recordStartup('passed')
    tracker.recordRelay('failed')

    // #when
    tracker.recordRelay('ok')

    // #then
    expect(tracker.getStatus()).toBe('ready')
  })
})

describe('createPushHealthTracker — component isolation', () => {
  it('does not let a read success clear a write failure', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.recordStartup('passed')
    tracker.recordBackend('write', 'failed')

    // #when
    tracker.recordBackend('read', 'ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not let a read success clear a relay failure', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.recordStartup('passed')
    tracker.recordRelay('failed')

    // #when
    tracker.recordBackend('read', 'ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })

  it('does not let a relay success clear a backend write failure', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.recordStartup('passed')
    tracker.recordBackend('write', 'failed')

    // #when
    tracker.recordRelay('ok')

    // #then
    expect(tracker.getStatus()).toBe('degraded')
  })
})

describe('createPushHealthTracker — passivity', () => {
  it('derives status purely from the injected clock and recorded state', () => {
    // #given a clock that counts how often it is read
    let reads = 0
    const tracker = createPushHealthTracker({
      clock: () => {
        reads += 1
        return 5000
      },
    })
    tracker.recordStartup('passed')
    const readsAfterRecording = reads

    // #when status is read repeatedly
    const first = tracker.getStatus()
    const second = tracker.getStatus()

    // #then it is stable and only consults the clock — nothing else to do I/O with
    expect(first).toBe('ready')
    expect(second).toBe('ready')
    expect(reads - readsAfterRecording).toBe(2)
  })

  it('exposes only a coarse status string', () => {
    // #given
    const {tracker} = makeTracker()
    tracker.recordStartup('passed')

    // #then — no counts, timestamps, or objects leak from the read API
    expect(typeof tracker.getStatus()).toBe('string')
    expect(Object.keys(tracker).sort()).toEqual([
      'getStatus',
      'markConfigured',
      'recordBackend',
      'recordRelay',
      'recordStartup',
    ])
  })
})
