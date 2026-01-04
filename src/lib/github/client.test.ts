import type {Logger} from '../logger.js'
import type {Octokit} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {createClient, getBotLogin} from './client.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

describe('createClient', () => {
  it('creates Octokit instance with token', () => {
    const logger = createMockLogger()
    const client = createClient({token: 'test-token', logger})

    expect(client).toBeDefined()
    expect(client.rest).toBeDefined()
    expect(client.rest.issues).toBeDefined()
    expect(client.rest.pulls).toBeDefined()
  })

  it('logs debug message on client creation', () => {
    const logger = createMockLogger()
    createClient({token: 'test-token', logger})

    expect(logger.debug).toHaveBeenCalledWith('Creating GitHub client with token')
  })
})

describe('getBotLogin', () => {
  it('returns login from authenticated user response', async () => {
    const logger = createMockLogger()
    const mockClient = {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockResolvedValue({
            data: {login: 'test-bot', type: 'User'},
          }),
        },
      },
    } as unknown as Octokit

    const login = await getBotLogin(mockClient, logger)

    expect(login).toBe('test-bot')
    expect(logger.debug).toHaveBeenCalledWith('Authenticated as', {login: 'test-bot', type: 'User'})
  })

  it('returns fallback for GitHub App tokens when API call fails', async () => {
    const logger = createMockLogger()
    const mockClient = {
      rest: {
        users: {
          getAuthenticated: vi.fn().mockRejectedValue(new Error('Resource not accessible')),
        },
      },
    } as unknown as Octokit

    const login = await getBotLogin(mockClient, logger)

    expect(login).toBe('fro-bot[bot]')
    expect(logger.debug).toHaveBeenCalledWith('Failed to get authenticated user, may be app token')
  })
})
