import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {createLogger, DEFAULT_SENSITIVE_FIELDS, redactSensitiveFields} from './logger.js'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

interface LogEntry {
  level: string
  message: string
  timestamp: string
  runId?: number
  extra?: string
  field?: string
  error?: {
    message: string
    stack?: string
  }
}

describe('createLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates a logger with all methods', () => {
    const logger = createLogger({})
    expect(logger.debug).toBeDefined()
    expect(logger.info).toBeDefined()
    expect(logger.warning).toBeDefined()
    expect(logger.error).toBeDefined()
  })

  describe('debug', () => {
    it('logs JSON with message and base context', () => {
      const logger = createLogger({runId: 123})
      logger.debug('test message')
      expect(core.debug).toHaveBeenCalledTimes(1)
      const mockCalls = (core.debug as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      expect(parsed.level).toBe('debug')
      expect(parsed.message).toBe('test message')
      expect(parsed.runId).toBe(123)
      expect(parsed.timestamp).toBeDefined()
    })

    it('merges additional context', () => {
      const logger = createLogger({runId: 123})
      logger.debug('test', {extra: 'value'})
      const mockCalls = (core.debug as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      expect(parsed.extra).toBe('value')
      expect(parsed.runId).toBe(123)
    })
  })

  describe('info', () => {
    it('logs JSON with info level', () => {
      const logger = createLogger({})
      logger.info('info message')
      expect(core.info).toHaveBeenCalledTimes(1)
      const mockCalls = (core.info as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      expect(parsed.level).toBe('info')
      expect(parsed.message).toBe('info message')
    })
  })

  describe('warning', () => {
    it('logs JSON with warning level', () => {
      const logger = createLogger({})
      logger.warning('warning message')
      expect(core.warning).toHaveBeenCalledTimes(1)
      const mockCalls = (core.warning as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      expect(parsed.level).toBe('warning')
      expect(parsed.message).toBe('warning message')
    })
  })

  describe('error', () => {
    it('logs JSON with error level', () => {
      const logger = createLogger({})
      logger.error('error message')
      expect(core.error).toHaveBeenCalledTimes(1)
      const mockCalls = (core.error as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      expect(parsed.level).toBe('error')
      expect(parsed.message).toBe('error message')
    })

    it('includes error details when Error object provided', () => {
      const logger = createLogger({})
      const error = new Error('Something went wrong')
      logger.error('operation failed', {error})
      const mockCalls = (core.error as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      expect(parsed.error?.message).toBe('Something went wrong')
      expect(parsed.error?.stack).toBeDefined()
    })
  })

  describe('context merging', () => {
    it('call context overrides base context', () => {
      const logger = createLogger({field: 'base'})
      logger.info('test', {field: 'override'})
      const mockCalls = (core.info as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      expect(parsed.field).toBe('override')
    })

    it('preserves timestamp format', () => {
      const logger = createLogger({})
      logger.info('test')
      const mockCalls = (core.info as ReturnType<typeof vi.fn>).mock.calls
      const loggedArg = mockCalls[0]?.[0] as string
      const parsed = JSON.parse(loggedArg) as LogEntry
      // ISO 8601 format
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })
})

describe('redactSensitiveFields', () => {
  it('redacts default sensitive fields', () => {
    const input = {
      token: 'secret123',
      password: 'mypass',
      data: 'safe',
    }
    const result = redactSensitiveFields(input)
    expect(result.token).toBe('[REDACTED]')
    expect(result.password).toBe('[REDACTED]')
    expect(result.data).toBe('safe')
  })

  it('redacts nested sensitive fields', () => {
    const input = {
      config: {
        apiKey: 'key123',
        name: 'test',
      },
    }
    const result = redactSensitiveFields(input) as {config: {apiKey: string; name: string}}
    expect(result.config.apiKey).toBe('[REDACTED]')
    expect(result.config.name).toBe('test')
  })

  it('redacts fields in arrays', () => {
    const input = {
      items: [{secret: 'hidden', value: 'visible'}],
    }
    const result = redactSensitiveFields(input) as {items: {secret: string; value: string}[]}
    expect(result.items[0]?.secret).toBe('[REDACTED]')
    expect(result.items[0]?.value).toBe('visible')
  })

  it('handles null and undefined values', () => {
    const input = {
      token: null,
      password: undefined,
      data: 'safe',
    }
    const result = redactSensitiveFields(input)
    expect(result.token).toBeNull()
    expect(result.password).toBeUndefined()
    expect(result.data).toBe('safe')
  })

  it('uses custom sensitive fields when provided', () => {
    const input = {
      customSecret: 'hidden',
      token: 'visible',
    }
    const result = redactSensitiveFields(input, ['customSecret'])
    expect(result.customSecret).toBe('[REDACTED]')
    expect(result.token).toBe('visible')
  })

  it('is case-insensitive for field matching', () => {
    const input = {
      TOKEN: 'secret',
      Password: 'secret',
      API_KEY: 'secret',
    }
    const result = redactSensitiveFields(input)
    expect(result.TOKEN).toBe('[REDACTED]')
    expect(result.Password).toBe('[REDACTED]')
    expect(result.API_KEY).toBe('[REDACTED]')
  })

  it('matches partial field names containing sensitive patterns', () => {
    const input = {
      githubToken: 'ghp_xxx',
      userPassword: 'pass123',
      myApiKey: 'key456',
    }
    const result = redactSensitiveFields(input)
    expect(result.githubToken).toBe('[REDACTED]')
    expect(result.userPassword).toBe('[REDACTED]')
    expect(result.myApiKey).toBe('[REDACTED]')
  })

  it('does not mutate the original object', () => {
    const input = {token: 'secret', data: 'safe'}
    const result = redactSensitiveFields(input)
    expect(input.token).toBe('secret')
    expect(result.token).toBe('[REDACTED]')
  })

  it('handles primitive values at root', () => {
    expect(redactSensitiveFields('string')).toBe('string')
    expect(redactSensitiveFields(123)).toBe(123)
    expect(redactSensitiveFields(null)).toBeNull()
  })
})

describe('DEFAULT_SENSITIVE_FIELDS', () => {
  it('includes common sensitive field patterns', () => {
    expect(DEFAULT_SENSITIVE_FIELDS).toContain('token')
    expect(DEFAULT_SENSITIVE_FIELDS).toContain('password')
    expect(DEFAULT_SENSITIVE_FIELDS).toContain('secret')
    expect(DEFAULT_SENSITIVE_FIELDS).toContain('key')
    expect(DEFAULT_SENSITIVE_FIELDS).toContain('auth')
    expect(DEFAULT_SENSITIVE_FIELDS).toContain('credential')
  })
})

describe('createLogger with sensitive field filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redacts sensitive fields in context', () => {
    const logger = createLogger({})
    logger.info('test', {token: 'secret123', data: 'safe'})
    const mockCalls = (core.info as ReturnType<typeof vi.fn>).mock.calls
    const loggedArg = mockCalls[0]?.[0] as string
    const parsed = JSON.parse(loggedArg) as Record<string, unknown>
    expect(parsed.token).toBe('[REDACTED]')
    expect(parsed.data).toBe('safe')
  })

  it('redacts sensitive fields in base context', () => {
    const logger = createLogger({apiKey: 'secret456'})
    logger.info('test')
    const mockCalls = (core.info as ReturnType<typeof vi.fn>).mock.calls
    const loggedArg = mockCalls[0]?.[0] as string
    const parsed = JSON.parse(loggedArg) as Record<string, unknown>
    expect(parsed.apiKey).toBe('[REDACTED]')
  })
})
