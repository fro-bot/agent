import {describe, expect, it} from 'vitest'
import {createAbortRegistry} from './abort-registry.js'

describe('abort-registry', () => {
  it('register/abort/isAborted/delete lifecycle', () => {
    // #given a fresh registry
    const registry = createAbortRegistry()
    const runId = 'run-1'

    // #when registering the run
    const signal = registry.register(runId)

    // #then it is tracked, not yet aborted
    expect(registry.has(runId)).toBe(true)
    expect(registry.isAborted(runId)).toBe(false)
    expect(signal.aborted).toBe(false)

    // #when aborting the run
    const aborted = registry.abort(runId, 'operator cancel')

    // #then abort reports success and the signal/probe reflect it
    expect(aborted).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(registry.isAborted(runId)).toBe(true)

    // #when deleting the entry
    registry.delete(runId)

    // #then the registry no longer tracks it
    expect(registry.has(runId)).toBe(false)
    expect(registry.isAborted(runId)).toBe(false)
  })

  it('abort on an unknown runId is a no-op returning false', () => {
    // #given a fresh registry with no registrations
    const registry = createAbortRegistry()

    // #when aborting an unregistered runId
    const result = registry.abort('never-registered')

    // #then it reports false without throwing
    expect(result).toBe(false)
  })

  it('double-abort on the same runId is a no-op (spec AbortController behavior)', () => {
    // #given a registered, already-aborted run
    const registry = createAbortRegistry()
    const runId = 'run-2'
    const signal = registry.register(runId)
    expect(registry.abort(runId, 'first')).toBe(true)

    // #when aborting again
    const secondAbort = registry.abort(runId, 'second')

    // #then it still reports true (controller found + abort() called), signal stays aborted once
    expect(secondAbort).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(registry.isAborted(runId)).toBe(true)
  })

  it('delete on an unknown runId is a no-op', () => {
    // #given a fresh registry
    const registry = createAbortRegistry()

    // #when/#then deleting an unregistered runId does not throw
    expect(() => {
      registry.delete('never-registered')
    }).not.toThrow()
  })

  it('register is idempotent — returns the same signal on repeat calls before delete', () => {
    // #given a registered run
    const registry = createAbortRegistry()
    const runId = 'run-3'
    const first = registry.register(runId)

    // #when registering again without deleting
    const second = registry.register(runId)

    // #then the same signal/controller is reused (not reset)
    expect(second).toBe(first)
  })
})
