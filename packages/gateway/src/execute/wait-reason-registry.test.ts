import {afterEach, describe, expect, it, vi} from 'vitest'

import {clearWaitReason, getWaitReason, onWaitReasonChange, setWaitReason} from './wait-reason-registry.js'

describe('the wait-reason registry', () => {
  afterEach(() => {
    clearWaitReason('run-a')
    clearWaitReason('run-b')
  })

  it('holds the latest code per run, and forgets it when cleared', () => {
    // #given
    setWaitReason('run-a', 'root-live')
    setWaitReason('run-b', 'notice-not-observed')

    // #when the first run moves on
    setWaitReason('run-a', 'ledger-not-drained')

    // #then
    expect(getWaitReason('run-a')).toBe('ledger-not-drained')
    expect(getWaitReason('run-b')).toBe('notice-not-observed')
    clearWaitReason('run-a')
    expect(getWaitReason('run-a')).toBeUndefined()
    expect(getWaitReason('run-b')).toBe('notice-not-observed')
  })

  it('tells listeners when a code changes, not when it repeats, and when it is cleared', () => {
    // #given
    const listener = vi.fn()
    const unsubscribe = onWaitReasonChange(listener)

    // #when
    setWaitReason('run-a', 'root-live')
    setWaitReason('run-a', 'root-live')
    setWaitReason('run-a', 'revision-drift')
    clearWaitReason('run-a')
    clearWaitReason('run-a')
    unsubscribe()
    setWaitReason('run-a', 'root-live')

    // #then three changes: set, change, clear; the repeat, the second clear and the unsubscribed set told nobody
    expect(listener.mock.calls).toEqual([['run-a'], ['run-a'], ['run-a']])
  })

  it('contains a throwing listener', () => {
    // #given
    const later = vi.fn()
    const offThrower = onWaitReasonChange(() => {
      throw new Error('listener exploded')
    })
    const offLater = onWaitReasonChange(later)

    // #when / #then
    expect(() => setWaitReason('run-a', 'root-live')).not.toThrow()
    expect(later).toHaveBeenCalledWith('run-a')
    offThrower()
    offLater()
  })
})
