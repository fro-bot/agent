import type {Logger} from '../logger.js'
import type {Octokit} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {createAppClient, createClient, getBotLogin} from './client.js'

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

describe('createAppClient', () => {
  it('returns null when appId is empty', async () => {
    const logger = createMockLogger()
    const result = await createAppClient({
      appId: '',
      privateKey: 'test-key',
      logger,
    })

    expect(result).toBeNull()
    expect(logger.debug).toHaveBeenCalledWith('GitHub App credentials not provided')
  })

  it('returns null when privateKey is empty', async () => {
    const logger = createMockLogger()
    const result = await createAppClient({
      appId: '12345',
      privateKey: '',
      logger,
    })

    expect(result).toBeNull()
    expect(logger.debug).toHaveBeenCalledWith('GitHub App credentials not provided')
  })

  it('returns null and logs error when auth fails with invalid credentials', async () => {
    const logger = createMockLogger()
    const result = await createAppClient({
      appId: '12345',
      privateKey: 'invalid-key-format',
      installationId: 67890,
      logger,
    })

    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create GitHub App client',
      expect.objectContaining({error: expect.any(String) as unknown as string}),
    )
  })

  it('does not log privateKey in any log calls', async () => {
    const logger = createMockLogger()
    const sensitiveKey = 'super-secret-private-key-content'

    await createAppClient({
      appId: '12345',
      privateKey: sensitiveKey,
      installationId: 67890,
      logger,
    })

    const allCalls = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]

    for (const call of allCalls) {
      const stringified = JSON.stringify(call)
      expect(stringified).not.toContain(sensitiveKey)
    }
  })
})
