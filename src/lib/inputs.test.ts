import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {parseActionInputs, parseModelInput} from './inputs.js'

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

  describe('RFC-013 SDK execution inputs', () => {
    it('parses agent input with default value', () => {
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
      expect(result.success && result.data.agent).toBe('sisyphus')
    })

    it('parses custom agent input', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          agent: 'CustomAgent',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.agent).toBe('CustomAgent')
    })

    it('parses model input correctly', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          model: 'anthropic/claude-sonnet-4-20250514',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.model).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-20250514',
      })
    })

    it('returns null model when not specified', () => {
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
      expect(result.success && result.data.model).toBeNull()
    })

    it('parses timeout input with default value', () => {
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
      expect(result.success && result.data.timeoutMs).toBe(1800000)
    })

    it('parses custom timeout input', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          timeout: '300000',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.timeoutMs).toBe(300000)
    })

    it('accepts zero timeout for no limit', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          timeout: '0',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.timeoutMs).toBe(0)
    })

    it('returns error for invalid model format (no slash)', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
          model: 'invalid-model',
        }
        return inputs[name] ?? ''
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('Invalid model format')
    })
  })
})

describe('parseModelInput', () => {
  it('parses valid provider/model format', () => {
    const result = parseModelInput('anthropic/claude-sonnet-4-20250514')

    expect(result).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-20250514',
    })
  })

  it('handles model IDs with multiple slashes', () => {
    const result = parseModelInput('openai/gpt-4/turbo')

    expect(result).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4/turbo',
    })
  })

  it('trims whitespace from input', () => {
    const result = parseModelInput('  anthropic/claude-sonnet-4-20250514  ')

    expect(result).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-20250514',
    })
  })

  it('throws error for input without slash', () => {
    expect(() => parseModelInput('no-slash')).toThrow('Invalid model format')
    expect(() => parseModelInput('no-slash')).toThrow('provider/model')
  })

  it('throws error for empty provider', () => {
    expect(() => parseModelInput('/claude-sonnet')).toThrow('Provider cannot be empty')
  })

  it('throws error for empty model ID', () => {
    expect(() => parseModelInput('anthropic/')).toThrow('Model ID cannot be empty')
  })

  it('throws error for empty string', () => {
    expect(() => parseModelInput('')).toThrow('Invalid model format')
  })

  it('throws error for whitespace-only string', () => {
    expect(() => parseModelInput('   ')).toThrow('Invalid model format')
  })
})
