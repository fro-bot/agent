import {describe, expect, it} from 'vitest'
import {
  buildPrimaryCacheKey,
  buildRestoreKeys,
  buildRestoreTiers,
  buildSaveCacheKey,
  classifyRestoreHit,
  resolveSessionGeneration,
  type CacheKeyComponents,
} from './cache-key.js'

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
    const key = buildSaveCacheKey(components, runId, runAttempt, null)

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
    const key = buildSaveCacheKey(components, runId, 1, null)

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
    const attempt1Key = buildSaveCacheKey(components, runId, 1, null)
    const attempt2Key = buildSaveCacheKey(components, runId, 2, null)

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
    const key = buildSaveCacheKey(components, 12345678, 1, null)

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
    const saveKey = buildSaveCacheKey(components, 12345678, 2, null)

    // #when building the restore keys for the same components
    const [refScoped, repoScoped] = buildRestoreKeys(components)

    // #then both restore-key prefixes still match the save key regardless of run ID or run
    // attempt, since neither prefix includes either
    expect(refScoped).toBeDefined()
    expect(repoScoped).toBeDefined()
    expect(saveKey.startsWith(refScoped as string)).toBe(true)
    expect(saveKey.startsWith(repoScoped as string)).toBe(true)
  })

  describe('invocation identity (job / matrix leg)', () => {
    const components: CacheKeyComponents = {
      agentIdentity: 'github',
      repo: 'fro-bot/.github',
      ref: 'main',
      os: 'Linux',
    }
    const runId = 38026680860

    it('appends the identity after run ID and run attempt', () => {
      // #given a job identity
      // #when building the save key
      const key = buildSaveCacheKey(components, runId, 1, 'fro-bot-remediate')

      // #then the identity is the last segment
      expect(key).toBe('opencode-storage-github-fro-bot-.github-main-Linux-38026680860-1-fro-bot-remediate')
    })

    it('gives two jobs in the same run and attempt distinct save keys (the Remediate/Observe collision)', () => {
      // #given two needs:-chained jobs of one run, same attempt
      // #when each builds its save key
      const remediate = buildSaveCacheKey(components, runId, 1, 'fro-bot-remediate')
      const observe = buildSaveCacheKey(components, runId, 1, 'fro-bot-observe')

      // #then they differ, so Observe's save can never be blocked by Remediate's reservation
      expect(remediate).not.toBe(observe)
    })

    it('re-run of the same job (attempt 2): distinct key from attempt 1, so the re-run can save', () => {
      // #given the same job in attempt 1 and its re-run attempt 2
      const attempt1 = buildSaveCacheKey(components, runId, 1, 'fro-bot-observe')
      const attempt2 = buildSaveCacheKey(components, runId, 2, 'fro-bot-observe')

      // #then distinct (attempt 2 does not hit attempt 1's reservation) and same job suffix
      expect(attempt2).not.toBe(attempt1)
      expect(attempt1).toBe('opencode-storage-github-fro-bot-.github-main-Linux-38026680860-1-fro-bot-observe')
      expect(attempt2).toBe('opencode-storage-github-fro-bot-.github-main-Linux-38026680860-2-fro-bot-observe')
    })

    it('restore prefixes match new identity-qualified keys AND old keys without an identity suffix', () => {
      // #given a new-format key, and an old-format key written before the identity suffix existed
      const newKey = buildSaveCacheKey(components, runId, 2, 'fro-bot-observe')
      const oldKey = 'opencode-storage-github-fro-bot-.github-main-Linux-38026680860-1'
      const [refScoped, repoScoped] = buildRestoreKeys(components)

      // #then both restore-key prefixes match both formats
      for (const key of [newKey, oldKey]) {
        expect(key.startsWith(refScoped as string)).toBe(true)
        expect(key.startsWith(repoScoped as string)).toBe(true)
      }
    })
  })
})

describe('resolveSessionGeneration', () => {
  it.each(['2.2.0', 'v2.2.0', '10.0.1', '2.0.0-beta.1'])('selects V2 for major 2 or above (%s)', version => {
    // #given a V2 version #when resolving #then V2
    expect(resolveSessionGeneration(version)).toBe('v2')
  })

  it.each(['1.19.4', '1.19.4+harness.5bde2635', '0.9.0', 'latest', ''])('selects V1 for %j', version => {
    // #given a V1 or unparseable version #when resolving #then V1
    expect(resolveSessionGeneration(version)).toBe('v1')
  })

  it.each([null, undefined])('treats a missing version (%s) as V1', version => {
    // #given no OPENCODE_VERSION state #when resolving #then V1, so a missing key never selects V2
    expect(resolveSessionGeneration(version)).toBe('v1')
  })
})

describe('V2 cache keys', () => {
  const components: CacheKeyComponents = {
    agentIdentity: 'github',
    repo: 'owner/repo',
    ref: 'main',
    os: 'Linux',
  }

  it('builds the primary key under the opencode-v2-storage prefix', () => {
    // #given standard components #when building the V2 primary key
    const key = buildPrimaryCacheKey(components, 'v2')

    // #then it uses the V2 prefix
    expect(key).toBe('opencode-v2-storage-github-owner-repo-main-Linux')
  })

  it('builds branch-scoped then repo-scoped V2 restore keys', () => {
    // #given standard components #when building the V2 restore keys
    const keys = buildRestoreKeys(components, 'v2')

    // #then the order is the same as V1's, under the V2 prefix
    expect(keys).toEqual(['opencode-v2-storage-github-owner-repo-main-', 'opencode-v2-storage-github-owner-repo-'])
  })

  it('builds the save key with run, attempt and identity suffixes', () => {
    // #given a run, an attempt and a job identity #when building the V2 save key
    const key = buildSaveCacheKey(components, 42, 2, 'fro-bot-observe', 'v2')

    // #then it is the V2 primary key plus the same suffixes V1 uses
    expect(key).toBe('opencode-v2-storage-github-owner-repo-main-Linux-42-2-fro-bot-observe')
  })

  it('leaves V1 key builders byte-identical when no generation is given', () => {
    // #given the V1 default #when building each key
    // #then the output is unchanged
    expect(buildPrimaryCacheKey(components)).toBe('opencode-storage-github-owner-repo-main-Linux')
    expect(buildPrimaryCacheKey(components, 'v1')).toBe(buildPrimaryCacheKey(components))
    expect(buildRestoreKeys(components)).toEqual([
      'opencode-storage-github-owner-repo-main-',
      'opencode-storage-github-owner-repo-',
    ])
    expect(buildRestoreKeys(components, 'v1')).toEqual(buildRestoreKeys(components))
    expect(buildSaveCacheKey(components, 42, 2, null)).toBe('opencode-storage-github-owner-repo-main-Linux-42-2')
    expect(buildSaveCacheKey(components, 42, 2, null, 'v1')).toBe(buildSaveCacheKey(components, 42, 2, null))
  })

  it('never matches a V2 key with a V1 restore-key prefix, nor a V1 key with a V2 prefix', () => {
    // #given a V1 and a V2 save key for the same run, and both generations' restore keys
    const v1Save = buildSaveCacheKey(components, 42, 1, null, 'v1')
    const v2Save = buildSaveCacheKey(components, 42, 1, null, 'v2')
    const v1Restore = buildRestoreKeys(components, 'v1')
    const v2Restore = buildRestoreKeys(components, 'v2')

    // #then neither generation's prefixes match the other's keys
    for (const prefix of v1Restore) {
      expect(v2Save.startsWith(prefix)).toBe(false)
      expect(v1Save.startsWith(prefix)).toBe(true)
    }
    for (const prefix of v2Restore) {
      expect(v1Save.startsWith(prefix)).toBe(false)
      expect(v2Save.startsWith(prefix)).toBe(true)
    }
  })

  it("does not start the V2 prefix with V1's prefix", () => {
    // #given the two generations' repo-scoped prefixes
    const [, v1Repo] = buildRestoreKeys(components, 'v1')
    const [, v2Repo] = buildRestoreKeys(components, 'v2')

    // #then neither is a prefix of the other
    expect(v2Repo?.startsWith(v1Repo as string)).toBe(false)
    expect(v1Repo?.startsWith(v2Repo as string)).toBe(false)
  })
})

describe('buildRestoreTiers', () => {
  const components: CacheKeyComponents = {
    agentIdentity: 'github',
    repo: 'owner/repo',
    ref: 'main',
    os: 'Linux',
  }

  it('orders V2 runs as V2 branch, V1 branch, V2 repo, V1 repo', () => {
    // #given a V2 run #when building the tiers
    const tiers = buildRestoreTiers(components, 'v2')

    // #then V2 is tried before V1 at each scope, and branch before repo
    expect(tiers).toEqual([
      {generation: 'v2', scope: 'branch', key: 'opencode-v2-storage-github-owner-repo-main-'},
      {generation: 'v1', scope: 'branch', key: 'opencode-storage-github-owner-repo-main-'},
      {generation: 'v2', scope: 'repo', key: 'opencode-v2-storage-github-owner-repo-'},
      {generation: 'v1', scope: 'repo', key: 'opencode-storage-github-owner-repo-'},
    ])
  })

  it('lists only the V1 branch and repo tiers for V1 runs', () => {
    // #given a V1 run #when building the tiers
    const tiers = buildRestoreTiers(components, 'v1')

    // #then it is exactly today's restore keys
    expect(tiers.map(tier => tier.key)).toEqual([...buildRestoreKeys(components, 'v1')])
    expect(tiers.every(tier => tier.generation === 'v1')).toBe(true)
  })
})

describe('classifyRestoreHit', () => {
  const components: CacheKeyComponents = {
    agentIdentity: 'github',
    repo: 'owner/repo',
    ref: 'main',
    os: 'Linux',
  }

  it('maps an object-store hit to its generation at repo scope', () => {
    // #given an object-store hit for each generation #when classifying
    // #then store and generation are carried through
    expect(classifyRestoreHit(components, {store: 'object-store', generation: 'v2'})).toEqual({
      store: 'object-store',
      generation: 'v2',
      scope: 'repo',
    })
    expect(classifyRestoreHit(components, {store: 'object-store', generation: 'v1'})).toEqual({
      store: 'object-store',
      generation: 'v1',
      scope: 'repo',
    })
  })

  it.each([
    ['opencode-v2-storage-github-owner-repo-main-Linux', 'v2', 'exact'],
    ['opencode-v2-storage-github-owner-repo-main-Linux-42-1', 'v2', 'branch'],
    ['opencode-v2-storage-github-owner-repo-develop-Linux-42-1', 'v2', 'repo'],
    ['opencode-storage-github-owner-repo-main-Linux', 'v1', 'exact'],
    ['opencode-storage-github-owner-repo-main-Linux-42-1', 'v1', 'branch'],
    ['opencode-storage-github-owner-repo-develop-Linux-42-1', 'v1', 'repo'],
  ] as const)('maps the cache key %s to %s at %s scope', (key, generation, scope) => {
    // #given a restored cache key #when classifying
    // #then generation and scope follow from the prefix that matched
    expect(classifyRestoreHit(components, {store: 'cache', key})).toEqual({store: 'cache', generation, scope})
  })

  it('returns null for a cache key that matches no restore prefix', () => {
    // #given a key outside both generations #when classifying #then it is unrecognised
    expect(classifyRestoreHit(components, {store: 'cache', key: 'something-else-entirely'})).toBeNull()
  })
})
