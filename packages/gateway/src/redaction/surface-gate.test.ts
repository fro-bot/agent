/**
 * surface-gate.test.ts — Tests for the gateway redaction bridge.
 *
 * Covers:
 * 1. resolveRunRepoKey: resolves a run's entity_ref → binding → deny keys.
 * 2. projectRunStatus: per-run projection helper (null = denied/omitted).
 * 3. filterDeniedRecords: working-set-filter-first helper.
 *
 * Security invariants tested:
 * - A run whose binding has deny keys matching the denylist → omitted (null).
 * - A run whose binding is missing → omitted (fail closed).
 * - A run whose binding has no deny keys (legacy) → omitted (fail closed).
 * - filterDeniedRecords: denied records excluded BEFORE any per-repo callback runs.
 * - R4: a repo that passes authz but is denylisted is still omitted.
 *
 * BDD comments: #given / #when / #then.
 */

import type {RunState} from '@fro-bot/runtime'
import type {RepoBinding} from '../bindings/types.js'
import type {RepoKey} from './denylist.js'
import type {BindingsLookup} from './surface-gate.js'

import {describe, expect, it, vi} from 'vitest'
import {filterDeniedRecords, projectRunStatus, resolveRunRepoKey} from './surface-gate.js'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_NOW_MS = 2_000_000
const STALE_THRESHOLD_MS = 60_000

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: 'run-test-001',
    surface: 'github',
    thread_id: 'thread-001',
    entity_ref: 'acme/widget#1',
    phase: 'EXECUTING',
    started_at: '2024-01-01T00:00:00.000Z',
    last_heartbeat: new Date(BASE_NOW_MS - 1000).toISOString(),
    holder_id: 'holder-001',
    details: {},
    ...overrides,
  }
}

function makeBinding(overrides: Partial<RepoBinding> = {}): RepoBinding {
  return {
    owner: 'acme',
    repo: 'widget',
    channelId: 'channel-001',
    channelName: 'general',
    workspacePath: '/workspace/acme/widget',
    createdAt: '2024-01-01T00:00:00.000Z',
    createdByDiscordId: 'user-001',
    databaseId: 42,
    nodeId: 'MDEwOlJlcG9zaXRvcnk0Mg==',
    ...overrides,
  }
}

/** A fake BindingsLookup that returns the given binding for any owner/repo. */
function fakeBindingsLookup(binding: RepoBinding | null): BindingsLookup {
  return {
    getBindingByRepo: vi
      .fn()
      .mockResolvedValue(binding === null ? {success: true, data: null} : {success: true, data: binding}),
  }
}

/** A fake BindingsLookup that returns a store error. */
function fakeErrorBindingsLookup(): BindingsLookup {
  return {
    getBindingByRepo: vi.fn().mockResolvedValue({success: false, error: new Error('store error')}),
  }
}

/** isRepoDenied that denies a specific databaseId. */
function makeDenyById(deniedId: number): (key: RepoKey) => boolean {
  return key => key.databaseId !== null && key.databaseId === deniedId
}

/** isRepoDenied that denies null/null keys (fail-closed). */
const denyMissingKey: (key: RepoKey) => boolean = key => key.databaseId === null && key.nodeId === null

/** isRepoDenied that allows everything. */
const allowAll: (key: RepoKey) => boolean = () => false

// ---------------------------------------------------------------------------
// resolveRunRepoKey
// ---------------------------------------------------------------------------

describe('resolveRunRepoKey', () => {
  it('resolves a run entity_ref to the binding deny keys', async () => {
    // #given a run with entity_ref 'acme/widget#1' and a binding with deny keys
    const binding = makeBinding({databaseId: 42, nodeId: 'MDEwOlJlcG9zaXRvcnk0Mg=='})
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when resolving the repo key
    const result = await resolveRunRepoKey(runState, lookup)

    // #then the deny keys from the binding are returned
    expect(result).toEqual({databaseId: 42, nodeId: 'MDEwOlJlcG9zaXRvcnk0Mg=='})
  })

  it('returns null/null when the binding is missing (fail closed)', async () => {
    // #given a run whose binding does not exist in the store
    const lookup = fakeBindingsLookup(null)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when resolving the repo key
    const result = await resolveRunRepoKey(runState, lookup)

    // #then null/null is returned (no usable deny key → fail closed)
    expect(result).toEqual({databaseId: null, nodeId: null})
  })

  it('returns null/null when the binding has no deny keys (legacy binding)', async () => {
    // #given a legacy binding without databaseId or nodeId
    const binding = makeBinding({databaseId: undefined, nodeId: undefined})
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when resolving the repo key
    const result = await resolveRunRepoKey(runState, lookup)

    // #then null/null is returned (no usable deny key → fail closed)
    expect(result).toEqual({databaseId: null, nodeId: null})
  })

  it('returns null/null when the binding store returns an error (fail closed)', async () => {
    // #given a binding store that returns an error
    const lookup = fakeErrorBindingsLookup()
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when resolving the repo key
    const result = await resolveRunRepoKey(runState, lookup)

    // #then null/null is returned (store error → fail closed)
    expect(result).toEqual({databaseId: null, nodeId: null})
  })

  it('does NOT call the GitHub API to resolve repo identity (keys come from the binding)', async () => {
    // #given a binding with deny keys already stored
    const binding = makeBinding({databaseId: 99, nodeId: 'MDEwOlJlcG9zaXRvcnk5OQ=='})
    const getBindingByRepo = vi.fn().mockResolvedValue({success: true, data: binding})
    const lookup: BindingsLookup = {getBindingByRepo}
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when resolving the repo key
    await resolveRunRepoKey(runState, lookup)

    // #then only the binding store was called — no GitHub API call
    // (the test asserts the binding lookup was called exactly once with the parsed owner/repo)
    expect(getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
  })
})

// ---------------------------------------------------------------------------
// projectRunStatus
// ---------------------------------------------------------------------------

describe('projectRunStatus', () => {
  it('returns a populated status for a non-denied run', async () => {
    // #given a run with a binding that has deny keys not on the denylist
    const binding = makeBinding({databaseId: 42, nodeId: 'MDEwOlJlcG9zaXRvcnk0Mg=='})
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when projected with a predicate that allows this databaseId
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: allowAll,
    })

    // #then a populated status is returned
    expect(result).not.toBeNull()
    expect(result?.runId).toBe('run-test-001')
    expect(result?.entityRef).toBe('acme/widget#1')
  })

  it('returns null for a run whose binding deny keys match the denylist', async () => {
    // #given a run with a binding whose databaseId is on the denylist
    const binding = makeBinding({databaseId: 42, nodeId: 'MDEwOlJlcG9zaXRvcnk0Mg=='})
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when projected with a predicate that denies databaseId 42
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: makeDenyById(42),
    })

    // #then the run is omitted (null)
    expect(result).toBeNull()
  })

  it('returns null when the binding is missing (fail closed)', async () => {
    // #given a run whose binding does not exist
    const lookup = fakeBindingsLookup(null)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when projected (predicate denies null/null keys)
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: denyMissingKey,
    })

    // #then the run is omitted (fail closed — no usable deny key)
    expect(result).toBeNull()
  })

  it('returns null when the binding has no deny keys (legacy — fail closed)', async () => {
    // #given a legacy binding without deny keys
    const binding = makeBinding({databaseId: undefined, nodeId: undefined})
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when projected (predicate denies null/null keys)
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: denyMissingKey,
    })

    // #then the run is omitted (fail closed)
    expect(result).toBeNull()
  })

  it('(r4) a run that passes authz but is denylisted is still omitted', async () => {
    // #given a run that would pass authz (caller has already checked)
    // but whose binding deny keys are on the denylist
    const binding = makeBinding({databaseId: 100, nodeId: 'MDEwOlJlcG9zaXRvcnkxMDA='})
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'visible-but-redacted/repo#10'})

    // #when projected with a predicate that denies databaseId 100
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: makeDenyById(100),
    })

    // #then the run is omitted — redaction wins regardless of authz
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// filterDeniedRecords
// ---------------------------------------------------------------------------

describe('filterDeniedRecords', () => {
  it('returns only non-denied records', () => {
    // #given a set of records with repo keys, some denied
    const records = [
      {id: 'a', repoKey: {databaseId: 1, nodeId: 'node-1'}},
      {id: 'b', repoKey: {databaseId: 2, nodeId: 'node-2'}},
      {id: 'c', repoKey: {databaseId: 3, nodeId: 'node-3'}},
    ]
    const deniedIds = new Set([2])
    const isRepoDenied = (key: RepoKey) => key.databaseId !== null && deniedIds.has(key.databaseId)

    // #when filtering
    const result = filterDeniedRecords(records, r => r.repoKey, isRepoDenied)

    // #then only non-denied records are returned
    expect(result.map(r => r.id)).toEqual(['a', 'c'])
  })

  it('excludes denied records BEFORE any per-repo callback runs', () => {
    // #given a set of records, one denied
    const perRepoCallback = vi.fn()
    const records = [
      {id: 'allowed', repoKey: {databaseId: 1, nodeId: 'node-1'}},
      {id: 'denied', repoKey: {databaseId: 2, nodeId: 'node-2'}},
    ]
    const isRepoDenied = (key: RepoKey) => key.databaseId === 2

    // #when filtering and then calling the per-repo callback on results
    const allowed = filterDeniedRecords(records, r => r.repoKey, isRepoDenied)
    for (const r of allowed) {
      perRepoCallback(r.id)
    }

    // #then the per-repo callback was NOT called for the denied record
    expect(perRepoCallback).toHaveBeenCalledExactlyOnceWith('allowed')
    expect(perRepoCallback).not.toHaveBeenCalledWith('denied')
  })

  it('returns an empty array when all records are denied', () => {
    // #given all records are denied
    const records = [
      {id: 'a', repoKey: {databaseId: 1, nodeId: 'node-1'}},
      {id: 'b', repoKey: {databaseId: 2, nodeId: 'node-2'}},
    ]

    // #when filtering with a predicate that denies everything
    const result = filterDeniedRecords(
      records,
      r => r.repoKey,
      () => true,
    )

    // #then no records are returned
    expect(result).toHaveLength(0)
  })

  it('returns all records when none are denied', () => {
    // #given no records are denied
    const records = [
      {id: 'a', repoKey: {databaseId: 1, nodeId: 'node-1'}},
      {id: 'b', repoKey: {databaseId: 2, nodeId: 'node-2'}},
    ]

    // #when filtering with a predicate that allows everything
    const result = filterDeniedRecords(
      records,
      r => r.repoKey,
      () => false,
    )

    // #then all records are returned
    expect(result).toHaveLength(2)
  })

  it('excludes records with null/null repoKey (fail closed on missing deny key)', () => {
    // #given a record with no deny keys (legacy / unbackfilled)
    const records = [
      {id: 'legacy', repoKey: {databaseId: null, nodeId: null}},
      {id: 'known', repoKey: {databaseId: 5, nodeId: 'node-5'}},
    ]

    // #when filtering with a fail-closed predicate
    const result = filterDeniedRecords(records, r => r.repoKey, denyMissingKey)

    // #then the legacy record is excluded
    expect(result.map(r => r.id)).toEqual(['known'])
  })

  it('returns an empty array for an empty input', () => {
    // #given an empty record set
    // #when filtering
    const result = filterDeniedRecords([], (r: {repoKey: RepoKey}) => r.repoKey, allowAll)

    // #then an empty array is returned
    expect(result).toHaveLength(0)
  })
})
