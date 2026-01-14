import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {getMockEventConfig, getMockToken, isInCI, isMockEventEnabled, parseMockEvent} from './mock.js'

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

describe('isMockEventEnabled', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns false when MOCK_EVENT is not set', () => {
    // #given MOCK_EVENT is not set
    vi.stubEnv('MOCK_EVENT', '')

    // #when checking if mock is enabled
    const result = isMockEventEnabled()

    // #then it should return false
    expect(result).toBe(false)
  })

  it('returns true when MOCK_EVENT is set', () => {
    // #given MOCK_EVENT is set
    vi.stubEnv('MOCK_EVENT', '{"eventName": "issue_comment"}')

    // #when checking if mock is enabled
    const result = isMockEventEnabled()

    // #then it should return true
    expect(result).toBe(true)
  })
})

describe('isInCI', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns true when CI=true', () => {
    // #given CI is set to true
    vi.stubEnv('CI', 'true')

    // #when checking if in CI
    const result = isInCI()

    // #then it should return true
    expect(result).toBe(true)
  })

  it('returns false when CI is not set', () => {
    // #given CI is not set
    vi.stubEnv('CI', '')

    // #when checking if in CI
    const result = isInCI()

    // #then it should return false
    expect(result).toBe(false)
  })
})

describe('getMockToken', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when MOCK_TOKEN is not set', () => {
    // #given MOCK_TOKEN is not set
    vi.stubEnv('MOCK_TOKEN', '')

    // #when getting mock token
    const result = getMockToken()

    // #then it should return null
    expect(result).toBeNull()
  })

  it('returns token when MOCK_TOKEN is set', () => {
    // #given MOCK_TOKEN is set
    vi.stubEnv('MOCK_TOKEN', 'ghp_test123')

    // #when getting mock token
    const result = getMockToken()

    // #then it should return the token
    expect(result).toBe('ghp_test123')
  })
})

describe('parseMockEvent', () => {
  let logger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.unstubAllEnvs()
    logger = createMockLogger()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns null when MOCK_EVENT is not set', () => {
    // #given MOCK_EVENT is not set
    vi.stubEnv('MOCK_EVENT', '')

    // #when parsing mock event
    const result = parseMockEvent(logger)

    // #then it should return null
    expect(result).toBeNull()
  })

  it('parses valid JSON with all fields', () => {
    // #given valid MOCK_EVENT JSON
    vi.stubEnv(
      'MOCK_EVENT',
      JSON.stringify({
        eventName: 'issue_comment',
        owner: 'test-owner',
        repo: 'test-repo',
        ref: 'refs/heads/feature',
        sha: 'abc123',
        runId: 12345,
        actor: 'test-actor',
        payload: {action: 'created'},
      }),
    )

    // #when parsing mock event
    const result = parseMockEvent(logger)

    // #then it should return parsed context
    expect(result).toEqual({
      eventName: 'issue_comment',
      eventType: 'issue_comment',
      repo: {owner: 'test-owner', repo: 'test-repo'},
      ref: 'refs/heads/feature',
      sha: 'abc123',
      runId: 12345,
      actor: 'test-actor',
      payload: {action: 'created'},
    })
  })

  it('uses defaults for missing optional fields', () => {
    // #given MOCK_EVENT with only eventName
    vi.stubEnv('MOCK_EVENT', JSON.stringify({eventName: 'workflow_dispatch'}))

    // #when parsing mock event
    const result = parseMockEvent(logger)

    // #then it should use defaults
    expect(result?.eventName).toBe('workflow_dispatch')
    expect(result?.repo.owner).toBe('mock-owner')
    expect(result?.repo.repo).toBe('mock-repo')
    expect(result?.ref).toBe('refs/heads/main')
  })

  it('returns null for invalid JSON', () => {
    // #given invalid JSON
    vi.stubEnv('MOCK_EVENT', 'not valid json')

    // #when parsing mock event
    const result = parseMockEvent(logger)

    // #then it should return null and log warning
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalledWith('Failed to parse MOCK_EVENT', expect.any(Object))
  })

  it('returns null when eventName is missing', () => {
    // #given JSON without eventName
    vi.stubEnv('MOCK_EVENT', JSON.stringify({repo: 'test'}))

    // #when parsing mock event
    const result = parseMockEvent(logger)

    // #then it should return null
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalledWith('MOCK_EVENT missing eventName')
  })
})

describe('getMockEventConfig', () => {
  let logger: ReturnType<typeof createMockLogger>

  beforeEach(() => {
    vi.unstubAllEnvs()
    logger = createMockLogger()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns disabled when MOCK_EVENT is not set', () => {
    // #given MOCK_EVENT is not set
    vi.stubEnv('MOCK_EVENT', '')

    // #when getting config
    const result = getMockEventConfig(logger)

    // #then it should be disabled
    expect(result.enabled).toBe(false)
  })

  it('returns disabled in CI (local testing only)', () => {
    // #given CI environment
    vi.stubEnv('CI', 'true')
    vi.stubEnv('MOCK_EVENT', JSON.stringify({eventName: 'issue_comment'}))

    // #when getting config
    const result = getMockEventConfig(logger)

    // #then it should be disabled
    expect(result.enabled).toBe(false)
    expect(logger.debug).toHaveBeenCalled()
  })

  it('returns enabled outside CI', () => {
    // #given non-CI environment
    vi.stubEnv('CI', '')
    vi.stubEnv('MOCK_EVENT', JSON.stringify({eventName: 'workflow_dispatch'}))

    // #when getting config
    const result = getMockEventConfig(logger)

    // #then it should be enabled
    expect(result.enabled).toBe(true)
  })
})
