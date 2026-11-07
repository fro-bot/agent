import type {Logger} from '../../shared/logger.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'

/**
 * `createExecutionDeadline`'s `run()`: the race between an operation and the deadline must be
 * decided once, by whichever settles first, and never re-explained afterwards by rereading the
 * clock. Each pair below shares identical timing but differs only in which side actually won,
 * proving the winner -- not the clock state at inspection time -- decides the outcome.
 */
describe('createExecutionDeadline — run() race causality', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("propagates the operation's own rejection when it arrives after wall-clock expiry but before the timeout latch fires", async () => {
    // #given a deadline whose wall clock has passed deadlineAt, but whose setTimeout callback
    // (latchTimeout) has not yet run -- isExpired() has not been consulted by anything since call
    // time, so the deadline racer has not genuinely won.
    const {createExecutionDeadline} = await import('./execution-deadline.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    let rejectOperation!: (error: unknown) => void
    const operation = vi.fn(
      async () =>
        new Promise((_resolve, reject) => {
          rejectOperation = reject
        }),
    )
    const ownError = new Error('operation failed on its own terms')

    // #when
    const resultPromise = deadline.run(operation, 'test operation')
    await Promise.resolve() // let operation() actually run and capture rejectOperation
    vi.setSystemTime(Date.now() + 1_500) // wall clock now past deadlineAt; timer has not ticked
    rejectOperation(ownError)

    // #then — the operation's own error propagates, not DeadlineExceededError
    await expect(resultPromise).rejects.toBe(ownError)
    deadline.dispose()
  })

  it("returns the operation's own success when it arrives after wall-clock expiry but before the timeout latch fires", async () => {
    // #given — sibling of the previous test: identical timing, non-deadline (successful) cause
    const {createExecutionDeadline} = await import('./execution-deadline.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    let resolveOperation!: (value: string) => void
    const operation = vi.fn(
      async () =>
        new Promise<string>(resolve => {
          resolveOperation = resolve
        }),
    )

    // #when
    const resultPromise = deadline.run(operation, 'test operation')
    await Promise.resolve() // let operation() actually run and capture resolveOperation
    vi.setSystemTime(Date.now() + 1_500) // wall clock now past deadlineAt; timer has not ticked
    resolveOperation('operation value')

    // #then — the operation's own value is returned; observing quiescence never erases a result
    await expect(resultPromise).resolves.toBe('operation value')
    deadline.dispose()
  })

  it('throws DeadlineExceededError when the operation is still pending and the timeout latch genuinely fires', async () => {
    // #given an operation that never settles on its own
    const {createExecutionDeadline} = await import('./execution-deadline.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const operation = vi.fn(async () => new Promise<string>(() => undefined))

    // #when — the timeout latch genuinely fires (its setTimeout callback runs) while the
    // operation is still pending: the deadline racer wins for real
    const resultPromise = deadline.run(operation, 'test operation')

    // #then
    await Promise.all([
      expect(resultPromise).rejects.toMatchObject({name: 'DeadlineExceededError'}),
      vi.advanceTimersByTimeAsync(1_000),
    ])
    deadline.dispose()
  })

  it("returns the operation's own success when it settles before the timeout latch fires", async () => {
    // #given — sibling of the previous test: same genuine-race timing, operation wins instead of
    // the deadline. Also the "existing behavior for operations comfortably inside the budget is
    // unchanged" case.
    const {createExecutionDeadline} = await import('./execution-deadline.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const operation = vi.fn(async () => 'operation value')

    // #when
    const result = await deadline.run(operation, 'test operation')

    // #then
    expect(result).toBe('operation value')
    expect(operation).toHaveBeenCalledOnce()
    deadline.dispose()
  })

  it("propagates the operation's own rejection when it settles before the timeout latch fires", async () => {
    // #given — sibling of the two previous tests: same genuine-race timing, operation wins the
    // race via its own rejection instead of the deadline winning or the operation succeeding
    const {createExecutionDeadline} = await import('./execution-deadline.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const ownError = new Error('operation failed on its own terms')
    const operation = vi.fn(async () => {
      throw ownError
    })

    // #when / #then — the operation's own error propagates, not DeadlineExceededError
    await expect(deadline.run(operation, 'test operation')).rejects.toBe(ownError)
    deadline.dispose()
  })

  it('rejects at admission with DeadlineExceededError when the deadline has already expired before run() is called, without invoking the operation', async () => {
    // #given a deadline whose wall clock has already passed deadlineAt before run() is ever called
    // -- this is a valid admission-time clock check, not a retrospective one
    const {createExecutionDeadline} = await import('./execution-deadline.js')
    vi.useFakeTimers()
    const deadline = createExecutionDeadline(1_000, mockLogger)
    const operation = vi.fn(async () => 'should not run')
    vi.setSystemTime(Date.now() + 1_500)

    // #when / #then
    await expect(deadline.run(operation, 'test operation')).rejects.toMatchObject({name: 'DeadlineExceededError'})
    expect(operation).not.toHaveBeenCalled()
    deadline.dispose()
  })

  it('invokes and resolves the operation normally when submitted comfortably within the deadline budget', async () => {
    // #given — sibling of the admission-rejection test: same admission decision point, non-deadline
    // (successful, well within budget) cause
    const {createExecutionDeadline} = await import('./execution-deadline.js')
    const deadline = createExecutionDeadline(10_000, mockLogger)
    const operation = vi.fn(async () => 'operation value')

    // #when
    const result = await deadline.run(operation, 'test operation')

    // #then
    expect(result).toBe('operation value')
    expect(operation).toHaveBeenCalledOnce()
    deadline.dispose()
  })
})
