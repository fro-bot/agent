import type {Result} from '@bfra.me/es/result'
import type {Logger} from './logger.js'
import {vi} from 'vitest'

/** Every argument of every call on a mock logger, serialized, for "nothing secret was logged" assertions. */
export function serializeLoggerCalls(logger: Logger): string {
  return JSON.stringify(
    (['debug', 'info', 'warning', 'error'] as const).flatMap(level => vi.mocked(logger[level]).mock.calls),
  )
}

export function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

/** The value of a successful result; fails the test loudly otherwise, so assertions need no conditional. */
export function unwrapOk<T, E>(result: Result<T, E>): T {
  if (!result.success) throw new Error(`expected a successful result, got: ${JSON.stringify(result.error)}`)
  return result.data
}

/** The error of a failed result; fails the test loudly otherwise. */
export function unwrapErr<T, E>(result: Result<T, E>): E {
  if (result.success) throw new Error('expected a failed result, got a success')
  return result.error
}
