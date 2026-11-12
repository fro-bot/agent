import {spawnSync} from 'node:child_process'
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

describe('timeout diagnostics', () => {
  it('hands the process tree under the command to onTimeout before it kills anything, then reports timed-out', async () => {
    // #given a shell that starts a background sleeper (a grandchild in the same group) and then waits
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')
    const snapshots: string[] = []

    // #when it outlives its budget
    const result = await execWithTimeout('sh', ['-c', 'sleep 30 & wait'], 600, {
      silent: true,
      onTimeout: snapshot => snapshots.push(snapshot),
    })

    // #then the snapshot was taken once, while both processes were alive: it names the shell and its sleeper
    expect(result).toBe('timed-out')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatch(/sleep 30/)
    expect(snapshots[0]).toMatch(/sh -c sleep 30 & wait/)
    expect(snapshots[0]).toMatch(/^\s*PID\s+PPID\s+PGID\s+STAT\s+ELAPSED\s+COMMAND/m)
  })

  it('also lists a descendant that left the process group (a helper that called setsid)', async () => {
    // #given a node process whose child is detached into its own group, so only the parent chain links them
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')
    const snapshots: string[] = []
    const script =
      "require('node:child_process').spawn('sleep',['31'],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>{},30000)"

    // #when it times out
    await execWithTimeout(process.execPath, ['-e', script], 1_200, {silent: true, onTimeout: s => snapshots.push(s)})

    // #then the detached sleeper is in the listing although it is in another process group
    expect(snapshots[0]).toMatch(/sleep 31/)
    spawnSync('pkill', ['-f', 'sleep 31'])
  })

  it('takes no snapshot for a command that finishes in time, and survives a throwing onTimeout', async () => {
    // #given
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')
    const onTimeout = vi.fn()

    // #when a command finishes
    const finished = await execWithTimeout(process.execPath, ['-e', 'process.exit(0)'], 5_000, {
      silent: true,
      onTimeout,
    })

    // #and another times out while its callback throws
    const timedOut = await execWithTimeout('sleep', ['30'], 300, {
      silent: true,
      onTimeout: () => {
        throw new Error('callback blew up')
      },
    })

    // #then the first never called it; the second still ended as timed-out
    expect(finished).toBe(0)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(timedOut).toBe('timed-out')
  })
})

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
