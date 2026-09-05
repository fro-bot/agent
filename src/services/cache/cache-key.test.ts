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
  it('appends run ID and run attempt to primary key', () => {
    // #given components, a run ID, and a run attempt
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }
    const runId = 12345678
    const runAttempt = 1

    // #when building save cache key
    const key = buildSaveCacheKey(components, runId, runAttempt)

    // #then run ID and run attempt are appended to primary key, in that order
    expect(key).toBe('opencode-storage-github-owner-repo-main-Linux-12345678-1')
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
    const key = buildSaveCacheKey(components, runId, 1)

    // #then key includes full run ID
    expect(key).toContain('9876543210')
  })

  it('produces distinct keys for two attempts of the same run, so a re-run attempt does not collide with attempt 1', () => {
    // #given the same run ID (GITHUB_RUN_ID does not change across a re-run attempt) but
    // two different run attempts
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }
    const runId = 12345678

    // #when building the save key for attempt 1 and attempt 2 of the same run
    const attempt1Key = buildSaveCacheKey(components, runId, 1)
    const attempt2Key = buildSaveCacheKey(components, runId, 2)

    // #then the keys are distinct -- without this, attempt 2's save would collide with
    // attempt 1's entry, throw "already exists", fold into 'persisted', and the post hook
    // would skip the retry, silently losing attempt 2's session state
    expect(attempt1Key).not.toBe(attempt2Key)
    expect(attempt1Key).toBe('opencode-storage-github-owner-repo-main-Linux-12345678-1')
    expect(attempt2Key).toBe('opencode-storage-github-owner-repo-main-Linux-12345678-2')
  })

  it('an unset run attempt (the getGitHubRunAttempt default) produces a key ending in -1', () => {
    // #given the default run attempt when GITHUB_RUN_ATTEMPT is unset or invalid
    // (getGitHubRunAttempt, src/shared/env.ts, mirrors getGitHubRunId's own
    // parse-or-default pattern and defaults to 1)
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }

    // #when building the save key with that default
    const key = buildSaveCacheKey(components, 12345678, 1)

    // #then the key ends in the literal suffix produced by the default attempt value
    expect(key.endsWith('-1')).toBe(true)
  })

  it('restore keys remain unaffected by the run-attempt suffix: they are prefixes that stop before any run ID or run attempt', () => {
    // #given the same components used to build a save key with a specific run attempt
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'owner/repo',
      ref: 'main',
      os: 'Linux',
    }
    const saveKey = buildSaveCacheKey(components, 12345678, 2)

    // #when building the restore keys for the same components
    const [refScoped, repoScoped] = buildRestoreKeys(components)

    // #then both restore-key prefixes still match the save key regardless of run ID or run
    // attempt, since neither prefix includes either
    expect(refScoped).toBeDefined()
    expect(repoScoped).toBeDefined()
    expect(saveKey.startsWith(refScoped as string)).toBe(true)
    expect(saveKey.startsWith(repoScoped as string)).toBe(true)
  })
})
