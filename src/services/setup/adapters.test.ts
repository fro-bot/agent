import process from 'node:process'
import {describe, expect, it, vi} from 'vitest'
import {createExecAdapter, holdSignalOwnership} from './adapters.js'

describe('createExecAdapter', () => {
  it('returns a successful exit code for a completed child', async () => {
    // #given the production execution adapter
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    // #when a child exits before the timeout
    const result = await execWithTimeout(process.execPath, ['-e', 'process.exit(0)'], 1_000, {silent: true})

    // #then its exit code is returned
    expect(result).toBe(0)
  })

  it('terminates a child that exceeds the timeout', async () => {
    // #given the production execution adapter and a long-running child
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    // #when the child exceeds its execution budget
    const result = await execWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], 10, {silent: true})

    // #then the timeout is reported without waiting for the child
    expect(result).toBe('timed-out')
  })
})

/** Starts a real child, returns the SIGTERM listener the adapter registered for it, and a way to finish it. */
async function startChild(): Promise<{
  readonly listener: () => void
  readonly finish: () => Promise<unknown>
}> {
  const execWithTimeout = createExecAdapter().execWithTimeout
  if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')
  const before = new Set(process.listeners('SIGTERM'))
  const result = execWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], 400, {silent: true})
  const added = process.listeners('SIGTERM').filter(candidate => !before.has(candidate))
  const [listener] = added
  if (listener === undefined || added.length !== 1) throw new Error('the adapter registered no SIGTERM listener')
  return {listener: listener as () => void, finish: async () => result}
}

describe('signal ownership', () => {
  it('kills its child and re-raises the signal when nobody owns signal handling', async () => {
    // #given an in-flight child, and process.kill observed instead of performed
    const {listener, finish} = await startChild()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    // #when SIGTERM reaches the adapter's listener
    listener()

    // #then it took the child's group down and re-raised the signal against itself
    const calls = kill.mock.calls.map(
      call => `${String(call[0] === process.pid ? 'self' : 'group')}:${String(call[1])}`,
    )
    kill.mockRestore()
    expect(calls).toEqual(['group:SIGKILL', 'self:SIGTERM'])
    await finish()
  })

  it('defers entirely while a lifecycle holds ownership: no kill, no re-raise', async () => {
    // #given an in-flight child and a held ownership
    const {listener, finish} = await startChild()
    const release = holdSignalOwnership()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    // #when SIGTERM reaches the adapter's listener
    listener()

    // #then the adapter did nothing: the owner decides what stops and when the process ends
    const calls = kill.mock.calls.length
    kill.mockRestore()
    release()
    expect(calls).toBe(0)
    await finish()
  })

  it('goes back to killing and re-raising once ownership is released, and release is idempotent', async () => {
    // #given ownership taken and released twice
    const release = holdSignalOwnership()
    release()
    release()
    const {listener, finish} = await startChild()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    // #when
    listener()

    // #then
    const calls = kill.mock.calls.length
    kill.mockRestore()
    expect(calls).toBe(2)
    await finish()
  })

  it('counts holders: it defers until the last one releases', async () => {
    // #given two holders, one released
    const first = holdSignalOwnership()
    const second = holdSignalOwnership()
    first()
    const {listener, finish} = await startChild()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    // #when
    listener()
    const whileHeld = kill.mock.calls.length
    second()
    kill.mockRestore()

    // #then
    expect(whileHeld).toBe(0)
    await finish()
  })
})
