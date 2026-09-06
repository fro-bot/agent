import * as childProcess from 'node:child_process'
import {EventEmitter} from 'node:events'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createExecAdapter} from './adapters.js'

vi.mock('node:child_process', () => ({spawn: vi.fn()}))

interface FakeChild extends EventEmitter {
  readonly pid?: number
  exitCode?: number | null
  signalCode?: NodeJS.Signals | null
  readonly stdin: EventEmitter & {write: () => void; end: () => void}
  readonly stdout: EventEmitter
  readonly stderr: EventEmitter
  readonly kill: ReturnType<typeof vi.fn>
}

function createFakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild
  const stdin = new EventEmitter() as FakeChild['stdin']
  Object.assign(child, {
    pid,
    stdin: Object.assign(stdin, {write: vi.fn(), end: vi.fn()}),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  })
  return child
}

describe('execWithTimeout', () => {
  beforeEach(() => {
    vi.mocked(childProcess.spawn).mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not leave the delayed kill armed when the child closes after timeout', async () => {
    // #given a child that closes after receiving the timeout termination signal
    const child = createFakeChild()
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    // #when the child times out and then closes before the hard-kill grace period expires
    const resultPromise = execWithTimeout('opencode', [], 10)
    await vi.advanceTimersByTimeAsync(10)
    child.emit('close', 143)
    const result = await resultPromise
    await vi.advanceTimersByTimeAsync(5_000)

    // #then only the initial graceful termination is sent (fake child has no pid, so the
    // process-group kill falls back to a direct child.kill())
    expect(result).toBe('timed-out')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reports a timeout when the escalation runs to the grace expiry without a close', async () => {
    // #given a child that never emits close, so only the grace timer can settle the promise
    const child = createFakeChild()
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    // #when the timeout, the SIGKILL escalation, and the reap grace all expire
    const resultPromise = execWithTimeout('opencode', [], 10)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then both signals went out and the grace path reports the timeout
    expect(await resultPromise).toBe('timed-out')
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('resolves the grace path as a normal completion when both escalation stages found the child gone', async () => {
    // #given a child that has already exited by the time the timeout fires, and never emits close
    const child = createFakeChild(4242)
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    // #when the child's exit state is already set before the timeout, and the whole escalation
    // chain runs to the grace expiry
    const resultPromise = execWithTimeout('opencode', [], 10)
    child.exitCode = 0
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(2_000)

    // #then nothing was signalled and the grace path reports the child's own exit code, not a
    // timeout the caller would use to skip the tools cache save
    expect(await resultPromise).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('forwards an explicit environment to the spawned child', async () => {
    // #given a child process stub and an explicit environment
    const child = createFakeChild()
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')
    const env = {PATH: '/custom/bin', SYSTEMATIC_TEST: 'true'}

    // #when the child is started
    const resultPromise = execWithTimeout('opencode', [], 1_000, {env})
    child.emit('close', 0)

    // #then the child receives exactly the supplied environment
    expect(await resultPromise).toBe(0)
    const spawnOptions = vi.mocked(childProcess.spawn).mock.calls[0]?.[2]
    expect(spawnOptions?.env).toEqual(env)
  })

  it('spawns the child detached so it can act as its own process group leader', async () => {
    // #given a child process stub
    const child = createFakeChild()
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    // #when the child is started (non-Windows only — no process groups on Windows)
    const resultPromise = execWithTimeout('opencode', [], 1_000, {})
    child.emit('close', 0)
    await resultPromise

    // #then
    const spawnOptions = vi.mocked(childProcess.spawn).mock.calls[0]?.[2]
    expect(spawnOptions?.detached).toBe(process.platform !== 'win32')
  })

  it('kills the process group via the negative pid on timeout', async () => {
    // #given a child with a pid, spawned detached as its own process group leader
    const child = createFakeChild(4321)
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    try {
      // #when the timeout fires and the child then reports its own exit
      const resultPromise = execWithTimeout('opencode', [], 10)
      await vi.advanceTimersByTimeAsync(10)
      child.emit('close', 143)
      const result = await resultPromise

      // #then the whole process group is signaled via the negative pid, not the direct child
      expect(result).toBe('timed-out')
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM')
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })

  it('falls back to child.kill when the process-group kill throws', async () => {
    // #given a child with a pid, but process.kill(-pid, ...) rejects (e.g. ESRCH)
    const child = createFakeChild(4321)
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    try {
      // #when the timeout fires and the child then reports its own exit
      const resultPromise = execWithTimeout('opencode', [], 10)
      await vi.advanceTimersByTimeAsync(10)
      child.emit('close', 143)
      const result = await resultPromise

      // #then the fallback direct kill is attempted after the group kill fails
      expect(result).toBe('timed-out')
      expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGTERM')
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('does not signal a recycled pid when the child exits before the escalation timer fires', async () => {
    // #given a child with a pid that has already exited (exit fires before close), but the
    // `close` event hasn't arrived yet
    const child = createFakeChild(4321)
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    try {
      // #when the child's exitCode flips before the timeout callback runs
      const resultPromise = execWithTimeout('opencode', [], 10)
      child.exitCode = 0
      await vi.advanceTimersByTimeAsync(10)

      // #then no signal is sent to the (possibly-recycled) pid or the child directly
      expect(killSpy).not.toHaveBeenCalledWith(-4321, expect.anything())
      expect(child.kill).not.toHaveBeenCalled()

      // #when close finally arrives
      child.emit('close', 0)
      const result = await resultPromise

      // #then it resolves as a normal completion, not 'timed-out' — the child finished on its own
      expect(result).toBe(0)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('kills the child process group and re-raises the signal when the parent is terminated', async () => {
    // #given a running child and a parent that is about to receive SIGTERM
    const child = createFakeChild(4321)
    vi.mocked(childProcess.spawn).mockReturnValue(child as never)
    const baselineSigtermListeners = process.listenerCount('SIGTERM')
    const baselineExitListeners = process.listenerCount('exit')
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const execWithTimeout = createExecAdapter().execWithTimeout
    if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

    try {
      const resultPromise = execWithTimeout('opencode', [], 10_000)

      // #when the parent process receives SIGTERM (process.kill is stubbed so the test process
      // itself does not exit)
      process.emit('SIGTERM')

      // #then the child's process group is killed first, then the signal is re-raised against
      // the parent itself so Node's default terminate-on-signal behavior still applies
      expect(killSpy.mock.calls[0]).toEqual([-4321, 'SIGKILL'])
      expect(killSpy.mock.calls[1]).toEqual([process.pid, 'SIGTERM'])
      expect(child.kill).not.toHaveBeenCalled()

      // #and our SIGTERM listener has already been removed (it fires via `once`)
      expect(process.listenerCount('SIGTERM')).toBe(baselineSigtermListeners)

      // #when the child later closes
      child.emit('close', 143)
      await resultPromise

      // #then the remaining `exit` listener is removed too, so long-lived processes don't
      // accumulate listeners across repeated calls
      expect(process.listenerCount('exit')).toBe(baselineExitListeners)
    } finally {
      killSpy.mockRestore()
    }
  })
})

describe('execWithTimeout - process reaping (real child)', () => {
  it.skipIf(process.platform === 'win32')(
    'awaits the real child exit before resolving, so the process is actually reaped',
    async () => {
      // #given the real (unmocked) node:child_process.spawn, delegated through the vi.fn() mock
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      vi.mocked(childProcess.spawn).mockImplementation((...spawnArgs: Parameters<typeof actual.spawn>) =>
        actual.spawn(...spawnArgs),
      )
      const execWithTimeout = createExecAdapter().execWithTimeout
      if (execWithTimeout === undefined) throw new Error('execWithTimeout is not configured')

      // #when a real child that ignores nothing but never exits on its own is timed out
      const result = await execWithTimeout('node', ['-e', 'setInterval(() => {}, 1000)'], 200, {})
      expect(result).toBe('timed-out')

      // Index by the most recent call, not [0] — spawn's mock call/result history accumulates
      // across every test in this file's shared module mock.
      const spawnResults = vi.mocked(childProcess.spawn).mock.results
      const spawnResult = spawnResults.at(-1)
      const realChild = spawnResult?.value as childProcess.ChildProcess
      const pid = realChild.pid
      if (typeof pid !== 'number') throw new Error('expected the real child to have a pid')

      // #then the child is actually gone (ESRCH), not just signaled — bounded poll, real timers
      const deadline = Date.now() + 2_000
      let reaped = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          reaped = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(reaped).toBe(true)
    },
  )
})
