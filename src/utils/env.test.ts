import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  getGitHubRefName,
  getGitHubRepository,
  getGitHubRunId,
  getOpenCodeAuthPath,
  getOpenCodeStoragePath,
  getRunnerOS,
  getXdgDataHome,
} from './env.js'

describe('getXdgDataHome', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns XDG_DATA_HOME when set', () => {
    process.env.XDG_DATA_HOME = '/custom/data'
    expect(getXdgDataHome()).toBe('/custom/data')
  })

  it('returns default path when XDG_DATA_HOME is not set', () => {
    delete process.env.XDG_DATA_HOME
    const result = getXdgDataHome()
    expect(result).toMatch(/\.local\/share$/)
  })

  it('returns default path when XDG_DATA_HOME is empty string', () => {
    process.env.XDG_DATA_HOME = ''
    const result = getXdgDataHome()
    expect(result).toMatch(/\.local\/share$/)
  })
})

describe('getOpenCodeStoragePath', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns storage path under XDG_DATA_HOME', () => {
    process.env.XDG_DATA_HOME = '/custom/data'
    expect(getOpenCodeStoragePath()).toBe('/custom/data/opencode/storage')
  })

  it('returns storage path under default data home', () => {
    delete process.env.XDG_DATA_HOME
    const result = getOpenCodeStoragePath()
    expect(result).toMatch(/\.local\/share\/opencode\/storage$/)
  })
})

describe('getOpenCodeAuthPath', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns auth.json path under XDG_DATA_HOME', () => {
    process.env.XDG_DATA_HOME = '/custom/data'
    expect(getOpenCodeAuthPath()).toBe('/custom/data/opencode/auth.json')
  })

  it('returns auth.json path under default data home', () => {
    delete process.env.XDG_DATA_HOME
    const result = getOpenCodeAuthPath()
    expect(result).toMatch(/\.local\/share\/opencode\/auth\.json$/)
  })
})

describe('getRunnerOS', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns RUNNER_OS when set', () => {
    process.env.RUNNER_OS = 'Linux'
    expect(getRunnerOS()).toBe('Linux')
  })

  it('returns RUNNER_OS Windows when set', () => {
    process.env.RUNNER_OS = 'Windows'
    expect(getRunnerOS()).toBe('Windows')
  })

  it('returns RUNNER_OS macOS when set', () => {
    process.env.RUNNER_OS = 'macOS'
    expect(getRunnerOS()).toBe('macOS')
  })

  it('returns fallback based on platform when RUNNER_OS not set', () => {
    delete process.env.RUNNER_OS
    const result = getRunnerOS()
    // Should return one of the valid OS types based on platform
    expect(['Linux', 'macOS', 'Windows']).toContain(result)
  })

  it('returns fallback when RUNNER_OS is empty string', () => {
    process.env.RUNNER_OS = ''
    const result = getRunnerOS()
    expect(['Linux', 'macOS', 'Windows']).toContain(result)
  })
})

describe('getGitHubRepository', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns GITHUB_REPOSITORY when set', () => {
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    expect(getGitHubRepository()).toBe('owner/repo')
  })

  it('returns default when GITHUB_REPOSITORY not set', () => {
    delete process.env.GITHUB_REPOSITORY
    expect(getGitHubRepository()).toBe('unknown/unknown')
  })

  it('returns default when GITHUB_REPOSITORY is empty', () => {
    process.env.GITHUB_REPOSITORY = ''
    expect(getGitHubRepository()).toBe('unknown/unknown')
  })
})

describe('getGitHubRefName', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns GITHUB_REF_NAME when set', () => {
    process.env.GITHUB_REF_NAME = 'feature-branch'
    expect(getGitHubRefName()).toBe('feature-branch')
  })

  it('returns default when GITHUB_REF_NAME not set', () => {
    delete process.env.GITHUB_REF_NAME
    expect(getGitHubRefName()).toBe('main')
  })

  it('returns default when GITHUB_REF_NAME is empty', () => {
    process.env.GITHUB_REF_NAME = ''
    expect(getGitHubRefName()).toBe('main')
  })
})

describe('getGitHubRunId', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns GITHUB_RUN_ID as number when set', () => {
    process.env.GITHUB_RUN_ID = '12345678'
    expect(getGitHubRunId()).toBe(12345678)
  })

  it('returns 0 when GITHUB_RUN_ID not set', () => {
    delete process.env.GITHUB_RUN_ID
    expect(getGitHubRunId()).toBe(0)
  })

  it('returns 0 when GITHUB_RUN_ID is empty', () => {
    process.env.GITHUB_RUN_ID = ''
    expect(getGitHubRunId()).toBe(0)
  })
})
