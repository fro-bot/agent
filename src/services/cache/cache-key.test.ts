import {describe, expect, it} from 'vitest'
import {buildPrimaryCacheKey, buildRestoreKeys, buildSaveCacheKey, type CacheKeyComponents} from './cache-key.js'

describe('buildPrimaryCacheKey', () => {
  it('generates correct key format with all components', () => {
    // #given standard cache key components
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }

    // #when building the primary cache key
    const key = buildPrimaryCacheKey(components)

    // #then the key follows the expected pattern with sanitized repo
    expect(key).toBe('opencode-storage-github-owner-repo-main-Linux')
  })

  it('sanitizes repo name by replacing slashes with dashes', () => {
    // #given a repo with organization/repo format
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'my-org/my-repo',
      ref: 'feature/branch',
      os: 'macOS',
    }

    // #when building the primary cache key
    const key = buildPrimaryCacheKey(components)

    // #then slashes in repo name are replaced with dashes
    expect(key).toBe('opencode-storage-github-my-org-my-repo-feature/branch-macOS')
  })

  it('handles nested repo paths with multiple slashes', () => {
    // #given a repo path with multiple slashes (edge case)
    const components: CacheKeyComponents = {
      agentIdentity: 'discord',
      repo: 'org/nested/repo',
      ref: 'main',
      os: 'Windows',
    }

    // #when building the primary cache key
    const key = buildPrimaryCacheKey(components)

    // #then all slashes in repo are replaced
    expect(key).toContain('org-nested-repo')
    expect(key).toBe('opencode-storage-discord-org-nested-repo-main-Windows')
  })

  it('uses discord agent identity correctly', () => {
    // #given discord as agent identity
    const components: CacheKeyComponents = {
      agentIdentity: 'discord',
      repo: 'owner/repo',
      ref: 'develop',
      os: 'Linux',
    }

    // #when building the primary cache key
    const key = buildPrimaryCacheKey(components)

    // #then the key includes discord identity
    expect(key).toBe('opencode-storage-discord-owner-repo-develop-Linux')
  })
})

describe('buildRestoreKeys', () => {
  it('returns keys in most-to-least specific order', () => {
    // #given standard components
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }

    // #when building restore keys
    const keys = buildRestoreKeys(components)

    // #then returns exactly 2 fallback keys
    expect(keys).toHaveLength(2)
  })

  it('first key is branch-scoped (includes ref)', () => {
    // #given components with specific ref
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'feature-branch',
      os: 'Linux',
    }

    // #when building restore keys
    const keys = buildRestoreKeys(components)

    // #then first key includes the ref
    expect(keys[0]).toContain('feature-branch')
    expect(keys[0]).toBe('opencode-storage-github-owner-repo-feature-branch-')
  })

  it('second key is repo-scoped (no ref)', () => {
    // #given components
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }

    // #when building restore keys
    const keys = buildRestoreKeys(components)

    // #then second key does not include ref
    expect(keys[1]).not.toContain('main')
    expect(keys[1]).toBe('opencode-storage-github-owner-repo-')
  })

  it('sanitizes repo name in restore keys', () => {
    // #given repo with slash
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'my-org/my-repo',
      ref: 'main',
      os: 'Linux',
    }

    // #when building restore keys
    const keys = buildRestoreKeys(components)

    // #then repo is sanitized in all keys
    expect(keys[0]).toContain('my-org-my-repo')
    expect(keys[1]).toContain('my-org-my-repo')
  })
})

describe('buildSaveCacheKey', () => {
  it('appends run ID to primary key', () => {
    // #given components and a run ID
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }
    const runId = 12345678

    // #when building save cache key
    const key = buildSaveCacheKey(components, runId)

    // #then run ID is appended to primary key
    expect(key).toBe('opencode-storage-github-owner-repo-main-Linux-12345678')
  })

  it('handles large run IDs', () => {
    // #given a large run ID (realistic GitHub run ID)
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }
    const runId = 9876543210

    // #when building save cache key
    const key = buildSaveCacheKey(components, runId)

    // #then key includes full run ID
    expect(key).toContain('9876543210')
  })
})
