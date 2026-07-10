import {describe, expect, it} from 'vitest'
import {shouldNotify} from './trigger-policy.js'

describe('shouldNotify', () => {
  // #given a record signed under an unrecognized (unsupported) key version
  // #when checked against the current/previous key versions
  // #then it is skipped as stale-key
  it('skips a record with an unknown key version', () => {
    const decision = shouldNotify('run_failed', {keyVersion: '99'}, {current: '2', previous: '1'})
    expect(decision).toBe('skip-stale-key')
  })

  // #given a record signed under the current key version
  // #when checked
  // #then it is allowed
  it('allows a record signed under the current key version', () => {
    const decision = shouldNotify('run_failed', {keyVersion: '2'}, {current: '2', previous: '1'})
    expect(decision).toBe('send')
  })

  // #given a record signed under the previous key version during a rollout window
  // #when checked
  // #then it is allowed
  it('allows a record signed under the previous key version during rollout', () => {
    const decision = shouldNotify('approval', {keyVersion: '1'}, {current: '2', previous: '1'})
    expect(decision).toBe('send')
  })

  // #given a record signed under an old key with no previous key configured
  // #when checked
  // #then it is skipped as stale-key
  it('skips a stale key version when no previous key is configured', () => {
    const decision = shouldNotify('run_failed', {keyVersion: '1'}, {current: '2'})
    expect(decision).toBe('skip-stale-key')
  })
})
