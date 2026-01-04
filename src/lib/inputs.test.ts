import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {parseActionInputs} from './inputs.js'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
}))

describe('parseActionInputs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('with valid inputs', () => {
    it('parses all required inputs correctly', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          prompt: 'Custom prompt',
          'session-retention': '100',
          's3-backup': 'true',
          's3-bucket': 'my-bucket',
          'aws-region': 'us-east-1',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.authJson).toBe('{"anthropic":{"type":"api","key":"sk-ant-test"}}')
      expect(result.success && result.data.prompt).toBe('Custom prompt')
      expect(result.success && result.data.sessionRetention).toBe(100)
      expect(result.success && result.data.s3Backup).toBe(true)
      expect(result.success && result.data.s3Bucket).toBe('my-bucket')
      expect(result.success && result.data.awsRegion).toBe('us-east-1')
    })

    it('uses defaults for optional inputs when empty', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.sessionRetention).toBe(50) // DEFAULT_SESSION_RETENTION
      expect(result.success && result.data.prompt).toBeNull()
      expect(result.success && result.data.s3Backup).toBe(false)
      expect(result.success && result.data.s3Bucket).toBeNull()
      expect(result.success && result.data.awsRegion).toBeNull()
    })
  })

  describe('with invalid inputs', () => {
    it('returns error for missing github-token', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('github-token')
    })

    it('returns error for missing auth-json', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('auth-json')
    })

    it('returns error for invalid auth-json (not valid JSON)', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': 'not-valid-json',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('auth-json')
      expect(!result.success && result.error.message).toContain('valid JSON')
    })

    it('returns error for invalid session-retention (negative)', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          'session-retention': '-5',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('session-retention')
    })

    it('returns error for invalid session-retention (not a number)', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          'session-retention': 'abc',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('session-retention')
    })
  })

  describe('edge cases', () => {
    it('rejects zero for session-retention (must be positive)', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          'session-retention': '0',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
    })

    it('trims whitespace from string inputs', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': '  ghp_test123  ',
          'auth-json': '  {"anthropic":{"type":"api","key":"sk-ant-test"}}  ',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.authJson).toBe('{"anthropic":{"type":"api","key":"sk-ant-test"}}')
    })

    it('handles s3-backup case insensitivity', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          's3-backup': 'TRUE',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.s3Backup).toBe(true)
    })
  })
})
