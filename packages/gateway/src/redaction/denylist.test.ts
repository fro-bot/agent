/**
 * Tests for the denylist cache + isRepoDenied predicate.
 *
 * All tests inject a fake MetadataReader and a deterministic `now()` clock —
 * no real GitHub API calls, no real timers.
 *
 * BDD comments: #given / #when / #then.
 */

import type {MetadataReader} from './metadata-reader.js'

import {describe, expect, it, vi} from 'vitest'

import {createDenylistCache} from './denylist.js'

// ---------------------------------------------------------------------------
// Test-double helpers
// ---------------------------------------------------------------------------

/** Silent logger that records error calls for alarm assertions. */
function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/** Build a minimal valid repos.yaml string with the given redacted entries. */
function makeYaml(redactedEntries: {node_id?: string; database_id?: number}[]): string {
  if (redactedEntries.length === 0) {
    return 'version: 1\nrepos: []\n'
  }
  const lines = ['version: 1', 'repos:']
  for (const entry of redactedEntries) {
    lines.push('  -')
    lines.push('    owner: "[REDACTED]"')
    lines.push('    name: "[REDACTED]"')
    lines.push('    private: true')
    if (entry.node_id !== undefined) {
      lines.push(`    node_id: "${entry.node_id}"`)
    }
    if (entry.database_id !== undefined) {
      lines.push(`    database_id: ${entry.database_id}`)
    }
  }
  return lines.join('\n')
}

/** A fake reader that returns the given YAML string. */
function fakeOkReader(yaml: string): MetadataReader {
  return async (_path: string, _ref: string): Promise<string> => yaml
}

/** A fake reader that always throws a transport error. */
function fakeErrReader(message = 'network error'): MetadataReader {
  return async (_path: string, _ref: string): Promise<string> => {
    throw new Error(message)
  }
}

/**
 * A reader that returns different YAML on successive calls.
 * Repeats the last entry indefinitely once the sequence is exhausted.
 */
function fakeSequenceReader(yamls: string[]): MetadataReader {
  let callIndex = 0
  return async (_path: string, _ref: string): Promise<string> => {
    const yaml = yamls[Math.min(callIndex, yamls.length - 1)]
    if (yaml === undefined) {
      throw new Error('sequence exhausted — empty yamls array')
    }
    callIndex++
    return yaml
  }
}

// ---------------------------------------------------------------------------
// Fixture denylist YAML
// ---------------------------------------------------------------------------

const REDACTED_DB_ID = 42
const REDACTED_NODE_ID = 'MDEwOlJlcG9zaXRvcnkxODY5MTU0'
const ALLOWED_DB_ID = 99
const ALLOWED_NODE_ID = 'MDEwOlJlcG9zaXRvcnkx'

const DENYLIST_YAML = makeYaml([{node_id: REDACTED_NODE_ID, database_id: REDACTED_DB_ID}])

// ---------------------------------------------------------------------------
// Default timing constants for tests
// ---------------------------------------------------------------------------

const TTL_MS = 1000
const GRACE_MS = 3000

// ---------------------------------------------------------------------------
// isRepoDenied — match semantics (after a successful load)
// ---------------------------------------------------------------------------

describe('isRepoDenied — match semantics', () => {
  it('denies a repoKey whose databaseId is in the denylist', async () => {
    // #given — cache loaded with a denylist containing REDACTED_DB_ID
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when — force a load then check
    await cache.getDenylistState()
    const result = cache.isRepoDenied({databaseId: REDACTED_DB_ID, nodeId: null})

    // #then
    expect(result).toBe(true)
  })

  it('denies a repoKey whose nodeId is in the denylist', async () => {
    // #given
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when
    await cache.getDenylistState()
    const result = cache.isRepoDenied({databaseId: null, nodeId: REDACTED_NODE_ID})

    // #then
    expect(result).toBe(true)
  })

  it('allows a repoKey whose databaseId and nodeId are not in the denylist', async () => {
    // #given
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when
    await cache.getDenylistState()
    const result = cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})

    // #then
    expect(result).toBe(false)
  })

  it('allows a repoKey with a non-matching databaseId even if nodeId is null', async () => {
    // #given
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when
    await cache.getDenylistState()
    const result = cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: null})

    // #then
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isRepoDenied — missing key (fail closed)
// ---------------------------------------------------------------------------

describe('isRepoDenied — missing key (fail closed)', () => {
  it('denies a repoKey with both databaseId:null and nodeId:null', async () => {
    // #given — even with a loaded denylist, null/null is always denied
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when
    await cache.getDenylistState()
    const result = cache.isRepoDenied({databaseId: null, nodeId: null})

    // #then — fail closed on missing key
    expect(result).toBe(true)
  })

  it('denies a repoKey with both databaseId:null and nodeId:null before any load', () => {
    // #given — cold start, no load attempted
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when — synchronous check before any getDenylistState() call
    const result = cache.isRepoDenied({databaseId: null, nodeId: null})

    // #then
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cold start — deny all before any successful load
// ---------------------------------------------------------------------------

describe('cold start — deny all before any successful load', () => {
  it('denies everything when the reader fails on the first call (no last-known-good)', async () => {
    // #given — reader always fails; no prior good load
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeErrReader(),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when — attempt a load (will fail)
    await cache.getDenylistState()

    // #then — deny all: both a "known-allowed" key and a null/null key are denied
    expect(cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})).toBe(true)
    expect(cache.isRepoDenied({databaseId: null, nodeId: null})).toBe(true)
  })

  it('denies everything synchronously before getDenylistState() is ever called', () => {
    // #given — cache freshly created, no load triggered
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when / #then — synchronous check before any async load
    expect(cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})).toBe(true)
    expect(cache.isRepoDenied({databaseId: REDACTED_DB_ID, nodeId: null})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Happy path — first successful load
// ---------------------------------------------------------------------------

describe('happy path — first successful load', () => {
  it('serves the denylist after a successful load: allowed repo is allowed, redacted is denied', async () => {
    // #given
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: fakeOkReader(DENYLIST_YAML),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when
    await cache.getDenylistState()

    // #then
    expect(cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})).toBe(false)
    expect(cache.isRepoDenied({databaseId: REDACTED_DB_ID, nodeId: null})).toBe(true)
    expect(cache.isRepoDenied({databaseId: null, nodeId: REDACTED_NODE_ID})).toBe(true)
  })

  it('does not re-fetch within the TTL window', async () => {
    // #given — reader is a spy so we can count calls
    const readerSpy = vi.fn().mockResolvedValue(DENYLIST_YAML)
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: readerSpy as MetadataReader,
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when — two getDenylistState() calls within TTL
    await cache.getDenylistState()
    await cache.getDenylistState()

    // #then — reader called only once
    expect(readerSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// TTL refresh — picks up updated denylist after TTL
// ---------------------------------------------------------------------------

describe('TTL refresh — picks up updated denylist after TTL', () => {
  it('re-fetches after TTL and serves the updated denylist', async () => {
    // #given — first load has no redacted entries; second load adds one
    const NEWLY_REDACTED_DB_ID = 77
    const yaml1 = makeYaml([]) // empty denylist
    const yaml2 = makeYaml([{node_id: REDACTED_NODE_ID, database_id: NEWLY_REDACTED_DB_ID}])

    let nowMs = 0
    const now = vi.fn().mockImplementation(() => nowMs)
    const cache = createDenylistCache({
      reader: fakeSequenceReader([yaml1, yaml2]),
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when — first load at t=0
    await cache.getDenylistState()
    expect(cache.isRepoDenied({databaseId: NEWLY_REDACTED_DB_ID, nodeId: null})).toBe(false)

    // advance past TTL
    nowMs = TTL_MS + 1

    // #when — second getDenylistState() triggers a refresh
    await cache.getDenylistState()

    // #then — newly-redacted repo is now denied
    expect(cache.isRepoDenied({databaseId: NEWLY_REDACTED_DB_ID, nodeId: null})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Grace window — serves last-known-good on refresh failure, then deny-all
// ---------------------------------------------------------------------------

describe('grace window — bounded last-known-good on refresh failure', () => {
  it('serves last-known-good within the grace window when refresh fails', async () => {
    // #given — first load succeeds; subsequent loads fail
    let nowMs = 0
    const now = vi.fn().mockImplementation(() => nowMs)
    const logger = makeLogger()
    let readerCallCount = 0
    const onceOkThenFail: MetadataReader = async () => {
      readerCallCount++
      if (readerCallCount === 1) return DENYLIST_YAML
      throw new Error('refresh failure')
    }
    const cache = createDenylistCache({
      reader: onceOkThenFail,
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger,
    })

    // #when — initial load at t=0
    await cache.getDenylistState()
    expect(cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})).toBe(false)

    // advance past TTL but within grace (lastGoodAt=0, graceMs=3000, now=1001)
    nowMs = TTL_MS + 1
    await cache.getDenylistState() // triggers refresh → fails → grace applies

    // #then — still serves last-known-good within grace
    expect(cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})).toBe(false)
    expect(cache.isRepoDenied({databaseId: REDACTED_DB_ID, nodeId: null})).toBe(true)
  })

  it('denies all after the grace window expires without a successful refresh', async () => {
    // #given — first load succeeds; all subsequent loads fail
    let nowMs = 0
    const now = vi.fn().mockImplementation(() => nowMs)
    const logger = makeLogger()
    let readerCallCount = 0
    const onceOkThenFail: MetadataReader = async () => {
      readerCallCount++
      if (readerCallCount === 1) return DENYLIST_YAML
      throw new Error('refresh failure')
    }
    const cache = createDenylistCache({
      reader: onceOkThenFail,
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger,
    })

    // #when — initial load at t=0
    await cache.getDenylistState()
    expect(cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})).toBe(false)

    // advance past TTL + grace window (lastGoodAt=0, graceMs=3000, now=3001)
    nowMs = GRACE_MS + 1
    await cache.getDenylistState() // triggers refresh → fails → past grace → deny all

    // #then — deny all (even the previously-allowed repo)
    expect(cache.isRepoDenied({databaseId: ALLOWED_DB_ID, nodeId: ALLOWED_NODE_ID})).toBe(true)
    expect(cache.isRepoDenied({databaseId: REDACTED_DB_ID, nodeId: null})).toBe(true)
  })

  it('emits a logger.error alarm on each failed refresh during the grace window', async () => {
    // #given
    let nowMs = 0
    const now = vi.fn().mockImplementation(() => nowMs)
    const logger = makeLogger()
    let readerCallCount = 0
    const onceOkThenFail: MetadataReader = async () => {
      readerCallCount++
      if (readerCallCount === 1) return DENYLIST_YAML
      throw new Error('refresh failure')
    }
    const cache = createDenylistCache({
      reader: onceOkThenFail,
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger,
    })

    // #when — initial load
    await cache.getDenylistState()

    // advance past TTL, within grace
    nowMs = TTL_MS + 1
    await cache.getDenylistState() // refresh fails → alarm

    // #then — logger.error was called (hard alarm)
    expect(logger.error).toHaveBeenCalled()
  })

  it('emits a logger.error alarm when grace window expires and deny-all kicks in', async () => {
    // #given
    let nowMs = 0
    const now = vi.fn().mockImplementation(() => nowMs)
    const logger = makeLogger()
    let readerCallCount = 0
    const onceOkThenFail: MetadataReader = async () => {
      readerCallCount++
      if (readerCallCount === 1) return DENYLIST_YAML
      throw new Error('refresh failure')
    }
    const cache = createDenylistCache({
      reader: onceOkThenFail,
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger,
    })

    // #when — initial load
    await cache.getDenylistState()

    // advance past grace window
    nowMs = GRACE_MS + 1
    await cache.getDenylistState() // refresh fails → past grace → deny all + alarm

    // #then — logger.error was called
    expect(logger.error).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Concurrent refresh — only one in-flight refresh at a time
// ---------------------------------------------------------------------------

describe('concurrent refresh — single in-flight refresh', () => {
  it('does not issue multiple concurrent reader calls when getDenylistState is called in parallel', async () => {
    // #given
    const readerSpy = vi.fn().mockResolvedValue(DENYLIST_YAML)
    const now = vi.fn().mockReturnValue(0)
    const cache = createDenylistCache({
      reader: readerSpy as MetadataReader,
      ttlMs: TTL_MS,
      graceMs: GRACE_MS,
      now,
      logger: makeLogger(),
    })

    // #when — fire two concurrent getDenylistState() calls
    await Promise.all([cache.getDenylistState(), cache.getDenylistState()])

    // #then — reader called only once (deduplication)
    expect(readerSpy).toHaveBeenCalledTimes(1)
  })
})
