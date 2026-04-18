import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_S3_PREFIX, DEFAULT_SYSTEMATIC_VERSION} from '../../shared/constants.js'
import {parseActionInputs, parseModelInput} from './inputs.js'

const mocks = vi.hoisted(() => ({
  getInput: vi.fn<(name: string) => string>(),
  setSecret: vi.fn<(value: string) => void>(),
  warning: vi.fn<(message: string) => void>(),
  githubContext: {
    payload: {},
  },
}))

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
  setSecret: mocks.setSecret,
  warning: mocks.warning,
}))

vi.mock('@actions/github', () => ({
  context: mocks.githubContext,
}))

function mockInputs(overrides: Record<string, string>): void {
  const defaults: Record<string, string> = {
    'github-token': 'ghp_test123',
    'auth-json': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
  }

  const inputs = {
    ...defaults,
    ...overrides,
  }

  mocks.getInput.mockImplementation((name: string) => inputs[name] ?? '')
}

function setGitHubPayload(payload: Record<string, unknown>): void {
  mocks.githubContext.payload = payload
}

describe('parseActionInputs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setGitHubPayload({})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  describe('with valid inputs', () => {
    it('parses all required inputs correctly', () => {
      mockInputs({
        prompt: 'Custom prompt',
        'session-retention': '100',
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        'aws-region': 'us-east-1',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.authJson).toBe('{"anthropic":{"type":"api","key":"sk-ant-test"}}')
      expect(result.success && result.data.prompt).toBe('Custom prompt')
      expect(result.success && result.data.sessionRetention).toBe(100)
      expect(result.success && result.data.storeConfig.enabled).toBe(true)
      expect(result.success && result.data.storeConfig.bucket).toBe('my-bucket')
      expect(result.success && result.data.storeConfig.region).toBe('us-east-1')
    })

    it('uses defaults for optional inputs when empty', () => {
      mockInputs({})

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.sessionRetention).toBe(50) // DEFAULT_SESSION_RETENTION
      expect(result.success && result.data.prompt).toBeNull()
      expect(result.success && result.data.storeConfig.enabled).toBe(false)
      expect(result.success && result.data.storeConfig.bucket).toBe('')
      expect(result.success && result.data.storeConfig.region).toBe('')
      expect(result.success && result.data.storeConfig.prefix).toBe(DEFAULT_S3_PREFIX)
    })

    it('parses all S3 inputs into storeConfig', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        'aws-region': 'us-east-1',
        's3-endpoint': 'https://account.r2.cloudflarestorage.com',
        's3-prefix': 'custom-prefix',
        's3-expected-bucket-owner': '123456789012',
        's3-allow-insecure-endpoint': 'true',
        's3-sse-encryption': 'AES256',
        's3-sse-kms-key-id': 'kms-key-123',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig).toEqual({
        enabled: true,
        bucket: 'my-bucket',
        region: 'us-east-1',
        prefix: 'custom-prefix',
        endpoint: 'https://account.r2.cloudflarestorage.com',
        expectedBucketOwner: '123456789012',
        allowInsecureEndpoint: true,
        sseEncryption: 'AES256',
        sseKmsKeyId: 'kms-key-123',
      })
    })

    it('applies the default prefix when s3-prefix is not provided', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        'aws-region': 'us-east-1',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.prefix).toBe(DEFAULT_S3_PREFIX)
    })

    it('passes through a valid custom endpoint', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-endpoint': 'https://account.r2.cloudflarestorage.com',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.endpoint).toBe('https://account.r2.cloudflarestorage.com')
    })

    it('accepts an http endpoint when insecure endpoints are explicitly allowed', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-endpoint': 'http://minio.example.test:9000',
        's3-allow-insecure-endpoint': 'true',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.endpoint).toBe('http://minio.example.test:9000')
      expect(result.success && result.data.storeConfig.allowInsecureEndpoint).toBe(true)
    })

    it('includes expectedBucketOwner when provided', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-expected-bucket-owner': '123456789012',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.expectedBucketOwner).toBe('123456789012')
    })

    it('includes sseEncryption and sseKmsKeyId when provided', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-sse-encryption': 'aws:kms',
        's3-sse-kms-key-id': 'kms-key-123',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.sseEncryption).toBe('aws:kms')
      expect(result.success && result.data.storeConfig.sseKmsKeyId).toBe('kms-key-123')
    })

    it('registers AWS credentials as masked secrets when present', () => {
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIA_TEST_VALUE')
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-test-value')
      mockInputs({})

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(mocks.setSecret).toHaveBeenCalledWith('AKIA_TEST_VALUE')
      expect(mocks.setSecret).toHaveBeenCalledWith('secret-test-value')
      expect(mocks.setSecret).toHaveBeenCalledTimes(2)
    })

    it('forces storeConfig.enabled to false for fork pull requests', () => {
      setGitHubPayload({
        pull_request: {
          head: {
            repo: {
              fork: true,
            },
          },
        },
      })
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.enabled).toBe(false)
      expect(mocks.warning).toHaveBeenCalled()
    })
  })

  describe('with invalid inputs', () => {
    it('returns error for missing github-token', () => {
      mockInputs({
        'github-token': '',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('github-token')
    })

    it('returns error for missing auth-json', () => {
      mockInputs({
        'auth-json': '',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('auth-json')
    })

    it('returns error for invalid auth-json (not valid JSON)', () => {
      mockInputs({
        'auth-json': 'not-valid-json',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('auth-json')
      expect(!result.success && result.error.message).toContain('valid JSON')
    })

    it('returns error for invalid session-retention (negative)', () => {
      mockInputs({
        'session-retention': '-5',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('session-retention')
    })

    it('returns error for invalid session-retention (not a number)', () => {
      mockInputs({
        'session-retention': 'abc',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('session-retention')
    })

    it('returns an error when s3-backup is true and s3-bucket is empty without echoing values', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': '   ',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('s3-bucket')
      expect(!result.success && result.error.message).not.toContain('   ')
      expect(!result.success && result.error.message).not.toContain('true')
    })

    it('rejects an insecure endpoint by default', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-endpoint': 'http://internal',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('https')
    })

    it('rejects a link-local endpoint', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-endpoint': 'https://169.254.169.254',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('cloud instance metadata services')
    })

    it('rejects a non-metadata link-local endpoint', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-endpoint': 'https://169.254.1.1',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('loopback, link-local, or private network addresses')
    })

    it('rejects cloud metadata service endpoints even when insecure endpoints are allowed', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-endpoint': 'http://169.254.169.254',
        's3-allow-insecure-endpoint': 'true',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('cloud instance metadata services')
    })

    it('rejects an invalid prefix', () => {
      mockInputs({
        's3-backup': 'true',
        's3-bucket': 'my-bucket',
        's3-prefix': '../other-repo',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('prefix')
    })
  })

  describe('edge cases', () => {
    it('rejects zero for session-retention (must be positive)', () => {
      mockInputs({
        'session-retention': '0',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
    })

    it('trims whitespace from string inputs', () => {
      mockInputs({
        'github-token': '  ghp_test123  ',
        'auth-json': '  {"anthropic":{"type":"api","key":"sk-ant-test"}}  ',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.githubToken).toBe('ghp_test123')
      expect(result.success && result.data.authJson).toBe('{"anthropic":{"type":"api","key":"sk-ant-test"}}')
    })

    it('handles s3-backup case insensitivity', () => {
      mockInputs({
        's3-backup': 'TRUE',
        's3-bucket': 'my-bucket',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.enabled).toBe(true)
    })

    it('keeps storeConfig disabled when s3-backup is false', () => {
      mockInputs({
        's3-backup': 'false',
        's3-bucket': 'my-bucket',
        's3-endpoint': 'http://internal',
        's3-prefix': '../other-repo',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.storeConfig.enabled).toBe(false)
    })
  })

  describe('RFC-013 SDK execution inputs', () => {
    it('parses agent input with default value', () => {
      mockInputs({})

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.agent).toBe('sisyphus')
    })

    it('parses custom agent input', () => {
      mockInputs({
        agent: 'CustomAgent',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.agent).toBe('CustomAgent')
    })

    it('parses model input correctly', () => {
      mockInputs({
        model: 'anthropic/claude-sonnet-4-20250514',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.model).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-20250514',
      })
    })

    it('returns null model when not specified', () => {
      mockInputs({})

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.model).toBeNull()
    })

    it('parses timeout input with default value', () => {
      mockInputs({})

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.timeoutMs).toBe(1800000)
    })

    it('parses custom timeout input', () => {
      mockInputs({
        timeout: '300000',
      })

      const result = parseActionInputs()
      expect(result.success).toBe(true)
      expect(result.success && result.data.timeoutMs).toBe(300000)
    })

    it('parses systematic-version input with default value', () => {
      mockInputs({})

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.systematicVersion).toBe(DEFAULT_SYSTEMATIC_VERSION)
    })

    it('parses custom systematic-version input', () => {
      mockInputs({
        'systematic-version': '2.2.0',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.systematicVersion).toBe('2.2.0')
    })

    it('accepts zero timeout for no limit', () => {
      mockInputs({
        timeout: '0',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.timeoutMs).toBe(0)
    })

    it('parses dedup-window with default value', () => {
      mockInputs({})

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.dedupWindow).toBe(600000)
    })

    it('parses custom dedup-window', () => {
      mockInputs({
        'dedup-window': '300000',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.dedupWindow).toBe(300000)
    })

    it('accepts zero dedup-window to disable dedup', () => {
      mockInputs({
        'dedup-window': '0',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.dedupWindow).toBe(0)
    })

    it('returns error for invalid dedup-window value', () => {
      mockInputs({
        'dedup-window': 'not-a-number',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('dedup-window')
    })

    it('returns error for invalid model format (no slash)', () => {
      mockInputs({
        model: 'invalid-model',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('Invalid model format')
    })

    it('returns error for invalid opencode-config (not valid JSON)', () => {
      mockInputs({
        'opencode-config': 'not-valid-json',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('opencode-config')
      expect(!result.success && result.error.message).toContain('valid JSON')
    })

    it('returns error when opencode-config is JSON null literal', () => {
      mockInputs({
        'opencode-config': 'null',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('opencode-config')
      expect(!result.success && result.error.message).toContain('JSON object')
    })

    it('returns error when opencode-config is a JSON array', () => {
      mockInputs({
        'opencode-config': '[1,2,3]',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('opencode-config')
      expect(!result.success && result.error.message).toContain('JSON object')
    })

    it('returns error when opencode-config is a JSON string literal', () => {
      mockInputs({
        'opencode-config': '"literal"',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(false)
      expect(!result.success && result.error.message).toContain('opencode-config')
      expect(!result.success && result.error.message).toContain('JSON object')
    })
  })

  describe('with valid opencode-config', () => {
    it('parses valid JSON object in opencode-config', () => {
      mockInputs({
        'opencode-config': '{"model": "claude-opus-4", "temperature": 0.7}',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.opencodeConfig).toBe('{"model": "claude-opus-4", "temperature": 0.7}')
    })

    it('sets opencodeConfig to null when empty string', () => {
      mockInputs({
        'opencode-config': '',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.opencodeConfig).toBe(null)
    })

    it('parses systematic-config when provided', () => {
      mockInputs({
        'systematic-config': '{"mode":"strict"}',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.systematicConfig).toBe('{"mode":"strict"}')
    })

    it('sets systematicConfig to null when empty string', () => {
      mockInputs({
        'systematic-config': '',
      })

      const result = parseActionInputs()

      expect(result.success).toBe(true)
      expect(result.success && result.data.systematicConfig).toBe(null)
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
