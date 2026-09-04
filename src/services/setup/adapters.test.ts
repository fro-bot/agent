import process from 'node:process'
import {describe, expect, it} from 'vitest'
import {createExecAdapter} from './adapters.js'

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
