import {afterEach, describe, expect, it} from 'vitest'
import {
  assertRunNotCancelled,
  isRunCancelled,
  markRunCancelled,
  resetRunCancellation,
  RUN_CANCELLED_ERROR_NAME,
} from './cancellation.js'

describe('cancellation', () => {
  afterEach(() => {
    resetRunCancellation()
  })

  it('is not cancelled until it is marked, and assert passes', () => {
    expect(isRunCancelled()).toBe(false)
    expect(() => assertRunNotCancelled('the comment')).not.toThrow()
  })

  it('is cancelled from the moment it is marked, and assert throws a named error that names the write', () => {
    // #given / #when
    markRunCancelled()

    // #then
    expect(isRunCancelled()).toBe(true)
    expect(() => assertRunNotCancelled('the comment')).toThrow(/the comment was not sent/)
    expect(() => assertRunNotCancelled('the comment')).toThrow(
      expect.objectContaining({name: RUN_CANCELLED_ERROR_NAME}),
    )
  })

  it('stays cancelled on a second mark', () => {
    markRunCancelled()
    markRunCancelled()
    expect(isRunCancelled()).toBe(true)
  })
})
