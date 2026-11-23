import {afterEach, describe, expect, it} from 'vitest'
import {createExecAdapter, holdSignalOwnership, isSignalOwned, killRunningExecChildren} from './adapters.js'

/** Real children: the signal owner reaps what the exec adapter is running when a run is cancelled with no teardown to run. */
describe('killRunningExecChildren', () => {
  const exec = createExecAdapter().execWithTimeout

  afterEach(() => {
    killRunningExecChildren('SIGKILL')
  })

  it('kills the process group of a running command, which then ends, and reports how many it signalled', async () => {
    // #given a minute-long command
    if (exec === undefined) throw new Error('execWithTimeout is not configured')
    const running = exec('sh', ['-c', 'exec sleep 60'], 120_000, {silent: true})
    await new Promise(resolve => setTimeout(resolve, 200))
    const started = Date.now()

    // #when it is reaped
    const signalled = killRunningExecChildren('SIGKILL')
    const code = await running

    // #then it ended at once, and was not a timeout
    expect(signalled).toBe(1)
    expect(code).not.toBe('timed-out')
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('signals nothing when no command is running, and forgets a command once it has finished', async () => {
    // #given a command that finishes by itself
    if (exec === undefined) throw new Error('execWithTimeout is not configured')
    await exec('sh', ['-c', 'exit 0'], 10_000, {silent: true})

    // #then
    expect(killRunningExecChildren('SIGKILL')).toBe(0)
  })

  it('leaves the adapter’s own signal handling alone: ownership is the owner’s to hold', () => {
    // #given / #when
    const release = holdSignalOwnership()

    // #then
    expect(isSignalOwned()).toBe(true)
    release()
    expect(isSignalOwned()).toBe(false)
  })
})
