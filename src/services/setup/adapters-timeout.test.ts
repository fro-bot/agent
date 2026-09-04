import * as childProcess from 'node:child_process'
import {EventEmitter} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createExecAdapter} from './adapters.js'

vi.mock('node:child_process', () => ({spawn: vi.fn()}))

interface FakeChild extends EventEmitter {
  readonly stdin: {write: () => void; end: () => void}
  readonly stdout: EventEmitter
  readonly stderr: EventEmitter
  readonly kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  Object.assign(child, {
    stdin: {write: vi.fn(), end: vi.fn()},
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  })
  return child
}

describe('execWithTimeout', () => {
  beforeEach(() => {
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
    const result = await resultPromise
    child.emit('close', 143)
    await vi.advanceTimersByTimeAsync(5_000)

    // #then only the initial graceful termination is sent
    expect(result).toBe('timed-out')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
