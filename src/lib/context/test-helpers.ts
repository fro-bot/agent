import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import {vi} from 'vitest'

export function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

export function createMockOctokit(graphqlResponse: unknown): Octokit {
  return {
    graphql: vi.fn().mockResolvedValue(graphqlResponse),
  } as unknown as Octokit
}

export function createFailingMockOctokit(error: Error): Octokit {
  return {
    graphql: vi.fn().mockRejectedValue(error),
  } as unknown as Octokit
}
