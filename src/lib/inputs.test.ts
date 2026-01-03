import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {parseActionInputs} from './inputs.js'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
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
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'opencode-model': 'claude-sonnet-4-20250514',
          'session-retention-days': '30',
          'max-comment-length': '65536',
        }
        return inputs[name] ?? ''
      })

      mockGetBooleanInput.mockImplementation((name: string) => {
        const inputs: Record<string, boolean> = {
          'safe-mode': true,
          debug: false,
        }
        return inputs[name] ?? false
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.opencodeModel).toBe('claude-sonnet-4-20250514')
      expect(result.success && result.data.sessionRetentionDays).toBe(30)
      expect(result.success && result.data.maxCommentLength).toBe(65536)
      expect(result.success && result.data.safeMode).toBe(true)
      expect(result.success && result.data.debug).toBe(false)
    })

    it('uses defaults for optional inputs when empty', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
        }
        return inputs[name] ?? ''
      })

      mockGetBooleanInput.mockReturnValue(false)

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.opencodeModel).toBe('claude-sonnet-4-20250514')
      expect(result.success && result.data.sessionRetentionDays).toBe(30)
      expect(result.success && result.data.maxCommentLength).toBe(65536)
    })
  })

  describe('with invalid inputs', () => {
    it('returns error for missing github-token', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockReturnValue('')
      mockGetBooleanInput.mockReturnValue(false)

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('github-token')
    })

    it('returns error for invalid session-retention-days', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'session-retention-days': '-5',
        }
        return inputs[name] ?? ''
      })

      mockGetBooleanInput.mockReturnValue(false)

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('session-retention-days')
    })

    it('returns error for invalid max-comment-length', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'max-comment-length': 'not-a-number',
        }
        return inputs[name] ?? ''
      })

      mockGetBooleanInput.mockReturnValue(false)

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('max-comment-length')
    })

    it('returns error for non-numeric session-retention-days', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'session-retention-days': 'abc',
        }
        return inputs[name] ?? ''
      })

      mockGetBooleanInput.mockReturnValue(false)

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('session-retention-days')
    })
  })

  describe('edge cases', () => {
    it('handles zero as valid for numeric fields', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': 'ghp_test123',
          'session-retention-days': '0',
        }
        return inputs[name] ?? ''
      })

      mockGetBooleanInput.mockReturnValue(false)

      const result = parseActionInputs()

      // Zero is invalid for session-retention-days (must be positive)
      expect(result.success).toBe(false)
    })

    it('trims whitespace from string inputs', () => {
      const mockGetInput = core.getInput as ReturnType<typeof vi.fn>
      const mockGetBooleanInput = core.getBooleanInput as ReturnType<typeof vi.fn>

      mockGetInput.mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          'github-token': '  ghp_test123  ',
          'opencode-model': '  claude-sonnet-4-20250514  ',
        }
        return inputs[name] ?? ''
      })

      mockGetBooleanInput.mockReturnValue(false)

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.opencodeModel).toBe('claude-sonnet-4-20250514')
    })
  })
})
