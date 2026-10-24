/**
 * surface-gate.test.ts — Tests for the gateway redaction bridge.
 *
 * Covers:
 * 1. resolveRunRepoKey: resolves a run's entity_ref → binding → deny keys.
 * 2. projectRunStatus: per-run projection helper (null = denied/omitted/unreadable).
 *    projectRunStatusWithKey: the same sequence with the resolved key and a three-way result.
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
import {
  bindingToRepoKey,
  filterDeniedRecords,
  lookupBindingDenyKeys,
  projectRunStatus,
  projectRunStatusWithKey,
  resolveRunRepoKey,
} from './surface-gate.js'

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

/** isRepoDenied that denies a specific nodeId. */
function makeDenyByNodeId(deniedNodeId: string): (key: RepoKey) => boolean {
  return key => key.nodeId !== null && key.nodeId === deniedNodeId
}

/** isRepoDenied that denies null/null or empty-nodeId keys (fail-closed). */
const denyMissingKey: (key: RepoKey) => boolean = key =>
  key.databaseId === null && (key.nodeId === null || key.nodeId === '')

/** isRepoDenied that allows everything. */
const allowAll: (key: RepoKey) => boolean = () => false

// ---------------------------------------------------------------------------
// resolveRunRepoKey
// ---------------------------------------------------------------------------

describe('lookupBindingDenyKeys — case (D1)', () => {
  it.each([
    ['Acme', 'Widget'],
    ['ACME', 'WIDGET'],
    ['acme', 'widget'],
  ])('reads the lowercase key for %s/%s, the only key bindings are stored under', async (owner, repo) => {
    // #given
    const lookup = fakeBindingsLookup(makeBinding())

    // #when
    const result = await lookupBindingDenyKeys(owner, repo, lookup)

    // #then
    expect(lookup.getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
    expect(result).toMatchObject({kind: 'resolved', binding: {owner: 'acme', repo: 'widget'}})
  })

  it('the run-status projection follows the same rule: a mixed-case entity_ref resolves the lowercase binding', async () => {
    // #given a legacy run record whose entity_ref kept the repo's GitHub spelling
    const binding = makeBinding({databaseId: 42, nodeId: 'R_node_42'})
    const lookup = fakeBindingsLookup(binding)

    // #when
    const key = await resolveRunRepoKey(makeRunState({entity_ref: 'Acme/Widget#1'}), lookup)

    // #then it finds the binding instead of failing closed on a spelling difference
    expect(lookup.getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
    expect(key).toEqual({databaseId: 42, nodeId: 'R_node_42'})
  })
})

describe('the access gate and the run-status projection resolve a mixed-case repo alike', () => {
  it('finds the same binding, by the same lowercase key, for one mixed-case spelling', async () => {
    // #given one store and a legacy run whose entity_ref carries the GitHub spelling
    const binding = makeBinding({databaseId: 42, nodeId: 'R_node_42'})
    const gateLookup = fakeBindingsLookup(binding)
    const projectionLookup = fakeBindingsLookup(binding)

    // #when the access-gate primitive and the run-status resolver each read it
    const gate = await lookupBindingDenyKeys('Acme', 'Widget', gateLookup)
    const projection = await resolveRunRepoKey(makeRunState({entity_ref: 'Acme/Widget#1'}), projectionLookup)

    // #then both read the same key and reach the same deny key
    expect(vi.mocked(gateLookup.getBindingByRepo).mock.calls).toEqual(
      vi.mocked(projectionLookup.getBindingByRepo).mock.calls,
    )
    expect(gate).toMatchObject({kind: 'resolved', repoKey: projection})
  })
})

describe('resolveRunRepoKey', () => {
  it('preserves nodeId when databaseId is null', () => {
    // #given — an identity whose numeric id is not representable exactly
    const bindingKey = bindingToRepoKey({databaseId: null, nodeId: 'R_unsafe-id'})

    // #then — nodeId remains available as an independent deny key
    expect(bindingKey).toEqual({databaseId: null, nodeId: 'R_unsafe-id'})
  })

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

  it('denies a null databaseId when the binding nodeId is denylisted', async () => {
    // #given — the numeric key is unusable, but the nodeId is denylisted
    const binding = {...makeBinding({nodeId: 'denied-node-id'}), databaseId: null} as unknown as RepoBinding
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when projected through the real binding → predicate path
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: makeDenyByNodeId('denied-node-id'),
    })

    // #then — nodeId still enforces denial when databaseId is unusable
    expect(result).toBeNull()
  })

  it('allows a null databaseId when the binding nodeId is not denylisted', async () => {
    // #given — the numeric key is unusable, but the nodeId is allowed
    const binding = {...makeBinding({nodeId: 'allowed-node-id'}), databaseId: null} as unknown as RepoBinding
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when projected through the real binding → predicate path
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: makeDenyByNodeId('denied-node-id'),
    })

    // #then — an allowed nodeId remains visible
    expect(result).not.toBeNull()
  })

  it('denies a binding when neither databaseId nor nodeId is usable', async () => {
    // #given — both deny keys are unusable
    const binding = {...makeBinding({nodeId: ''}), databaseId: null} as unknown as RepoBinding
    const lookup = fakeBindingsLookup(binding)
    const runState = makeRunState({entity_ref: 'acme/widget#1'})

    // #when projected through the real binding → predicate path
    const result = await projectRunStatus(runState, {
      nowMs: BASE_NOW_MS,
      staleThresholdMs: STALE_THRESHOLD_MS,
      bindingsLookup: lookup,
      isRepoDenied: denyMissingKey,
    })

    // #then — no usable deny key fails closed
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
// projectRunStatus — store errors fail closed
// ---------------------------------------------------------------------------

describe('projectRunStatus — binding store errors', () => {
  const opts = (bindingsLookup: BindingsLookup) => ({
    nowMs: BASE_NOW_MS,
    staleThresholdMs: STALE_THRESHOLD_MS,
    bindingsLookup,
    isRepoDenied: allowAll,
  })

  it('returns null when the binding store returns an error (fail closed)', async () => {
    // #given a store that reports an error, and a denylist that would allow the repo
    // #when projecting
    const result = await projectRunStatus(makeRunState(), opts(fakeErrorBindingsLookup()))

    // #then the run is omitted
    expect(result).toBeNull()
  })

  it('returns null when the binding store throws (fail closed)', async () => {
    // #given a store that throws
    const lookup: BindingsLookup = {getBindingByRepo: vi.fn().mockRejectedValue(new Error('network down'))}

    // #when projecting
    const result = await projectRunStatus(makeRunState(), opts(lookup))

    // #then the run is omitted
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// projectRunStatusWithKey
// ---------------------------------------------------------------------------

describe('projectRunStatusWithKey', () => {
  const resolvedKey = {databaseId: 42, nodeId: 'MDEwOlJlcG9zaXRvcnk0Mg=='}
  const opts = (bindingsLookup: BindingsLookup, isRepoDenied: (key: RepoKey) => boolean = allowAll) => ({
    nowMs: BASE_NOW_MS,
    staleThresholdMs: STALE_THRESHOLD_MS,
    bindingsLookup,
    isRepoDenied,
  })

  it('returns the closed status and the resolved key after exactly one binding lookup', async () => {
    // #given a bound, allowed repository
    const getBindingByRepo = vi.fn().mockResolvedValue({success: true, data: makeBinding()})

    // #when projecting
    const result = await projectRunStatusWithKey(makeRunState(), opts({getBindingByRepo}))

    // #then it is projected with the key the binding resolved
    expect(result).toMatchObject({
      kind: 'projected',
      status: {runId: 'run-test-001', status: 'running', stale: false},
      repoKey: resolvedKey,
    })
    expect(getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
  })

  it('hands the resolved key to the denylist predicate', async () => {
    // #given a predicate that records its argument
    const isRepoDenied = vi.fn(() => false)

    // #when projecting
    await projectRunStatusWithKey(makeRunState(), opts(fakeBindingsLookup(makeBinding()), isRepoDenied))

    // #then it saw the resolved key
    expect(isRepoDenied).toHaveBeenCalledExactlyOnceWith(resolvedKey)
  })

  it('is denied when the denylist matches', async () => {
    // #when the binding's key is on the denylist
    const result = await projectRunStatusWithKey(
      makeRunState(),
      opts(fakeBindingsLookup(makeBinding()), makeDenyById(42)),
    )

    // #then nothing is surfaced, not even the key
    expect(result).toEqual({kind: 'denied'})
  })

  it('is denied when there is no binding, or it has no deny keys (fail closed)', async () => {
    // #when the binding is missing, or legacy without keys
    const missing = await projectRunStatusWithKey(makeRunState(), opts(fakeBindingsLookup(null), denyMissingKey))
    const legacy = await projectRunStatusWithKey(
      makeRunState(),
      opts(fakeBindingsLookup(makeBinding({databaseId: undefined, nodeId: undefined})), denyMissingKey),
    )

    // #then both are denied
    expect(missing).toEqual({kind: 'denied'})
    expect(legacy).toEqual({kind: 'denied'})
  })

  it('is denied when the entity_ref cannot be parsed, without a binding lookup', async () => {
    // #given a run whose entity_ref has no owner/repo
    const getBindingByRepo = vi.fn()

    // #when projecting
    const result = await projectRunStatusWithKey(
      makeRunState({entity_ref: 'garbage'}),
      opts({getBindingByRepo}, denyMissingKey),
    )

    // #then it is denied and the store was never read
    expect(result).toEqual({kind: 'denied'})
    expect(getBindingByRepo).not.toHaveBeenCalled()
  })

  it.each(['acme/widget/x', 'acme/widget/x#1', 'acme/widget/'])(
    'treats the extra-segment entity_ref %j as unparseable: denied, with no binding read (D4)',
    async entityRef => {
      // #given a corrupted run record whose entity_ref has more than owner/repo. It used to be read as repo
      // `widget/x` and sent to the store, whose key builder rejected it, which surfaced as `unavailable`.
      const getBindingByRepo = vi.fn()

      // #when projecting
      const result = await projectRunStatusWithKey(
        makeRunState({entity_ref: entityRef}),
        opts({getBindingByRepo}, denyMissingKey),
      )

      // #then it fails closed at the parse, like any other unparseable ref
      expect(result).toEqual({kind: 'denied'})
      expect(getBindingByRepo).not.toHaveBeenCalled()
    },
  )

  it('resolves the deny key of an extra-segment entity_ref to null/null without a binding read', async () => {
    const getBindingByRepo = vi.fn()

    const result = await resolveRunRepoKey(makeRunState({entity_ref: 'acme/widget/x'}), {getBindingByRepo})

    expect(result).toEqual({databaseId: null, nodeId: null})
    expect(getBindingByRepo).not.toHaveBeenCalled()
  })

  it('is unavailable — not denied — when the binding store errors or throws, and never consults the denylist', async () => {
    // #given a denylist spy and two failing stores
    const isRepoDenied = vi.fn(() => true)
    const thrown: BindingsLookup = {getBindingByRepo: vi.fn().mockRejectedValue(new Error('network down'))}

    // #when projecting through each
    const errored = await projectRunStatusWithKey(makeRunState(), opts(fakeErrorBindingsLookup(), isRepoDenied))
    const threw = await projectRunStatusWithKey(makeRunState(), opts(thrown, isRepoDenied))

    // #then both report unavailable and no deny decision was made
    expect(errored).toEqual({kind: 'unavailable'})
    expect(threw).toEqual({kind: 'unavailable'})
    expect(isRepoDenied).not.toHaveBeenCalled()
  })

  it('never applies a waiting overlay', async () => {
    // #given a running discord run
    // #when projecting
    const result = await projectRunStatusWithKey(
      makeRunState({surface: 'discord', thread_id: 'T'}),
      opts(fakeBindingsLookup(makeBinding())),
    )

    // #then the status is the plain base status
    expect(result.kind === 'projected' && result.status.status).toBe('running')
  })

  it.each([
    ['PENDING', 'queued'],
    ['ACKNOWLEDGED', 'running'],
    ['EXECUTING', 'running'],
    ['COMPLETED', 'succeeded'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'cancelled'],
  ] as const)('maps %s to %s', async (phase, expected) => {
    // #when projecting a run in the phase
    const result = await projectRunStatusWithKey(makeRunState({phase}), opts(fakeBindingsLookup(makeBinding())))

    // #then the base status matches
    expect(result.kind === 'projected' && result.status.status).toBe(expected)
  })

  it('copies only contract fields — run details and holder data never reach the output', async () => {
    // #given a run whose details carry sensitive internal data
    const runState = makeRunState({
      holder_id: 'holder-secret',
      thread_id: 'thread-secret',
      details: {
        rawOutput: 'secret tool output',
        workspacePath: '/home/runner/workspace/acme/widget',
        toolArgs: ['--token', 'ghp_supersecret'],
        internalUrl: 'http://internal.corp/api',
      },
    })

    // #when projecting
    const result = await projectRunStatusWithKey(runState, opts(fakeBindingsLookup(makeBinding())))

    // #then the output has exactly the contract fields and none of the sensitive values
    if (result.kind !== 'projected') throw new Error('expected a projected status')
    expect(Object.keys(result.status).sort()).toEqual(
      ['entityRef', 'phase', 'runId', 'stale', 'startedAt', 'status', 'surface'].sort(),
    )
    const serialized = JSON.stringify(result)
    for (const leaked of ['secret tool output', '/home/runner/workspace', 'ghp_supersecret', 'http://internal.corp']) {
      expect(serialized).not.toContain(leaked)
    }
    expect(serialized).not.toContain('holder-secret')
    expect(serialized).not.toContain('thread-secret')
  })

  it('omits failureKind and checkout keys when absent, carries them when present', async () => {
    // #given a plain run, and a failed run with a failure kind and both checkout records
    const provenance = {
      kind: 'observed',
      observation: {
        head: {kind: 'attached', branch: 'main', sha: 'a'.repeat(40)},
        worktree: {kind: 'clean'},
        operationInProgress: 'none',
        observedAt: '2026-01-01T00:00:00.000Z',
      },
      remote: {kind: 'not-checked'},
    }
    const preparation = {outcome: 'refused', reason: 'dirty', changedPaths: ['src/index.ts']}
    const plain = await projectRunStatusWithKey(makeRunState(), opts(fakeBindingsLookup(makeBinding())))
    const full = await projectRunStatusWithKey(
      makeRunState({
        phase: 'FAILED',
        details: {failureKind: 'inactivity-timeout', checkoutProvenance: provenance, checkoutPreparation: preparation},
      }),
      opts(fakeBindingsLookup(makeBinding())),
    )

    // #then absent fields are not keys at all; present fields round-trip
    if (plain.kind !== 'projected' || full.kind !== 'projected') throw new Error('expected projected statuses')
    for (const key of ['failureKind', 'checkoutProvenance', 'checkoutPreparation']) {
      expect(Object.prototype.hasOwnProperty.call(plain.status, key)).toBe(false)
    }
    expect(full.status).toMatchObject({
      status: 'failed',
      failureKind: 'inactivity-timeout',
      checkoutProvenance: provenance,
      checkoutPreparation: preparation,
    })
  })
})

describe('projectRunStatusWithKey — providerFailureReason (1.12.0)', () => {
  it('carries the reason through the closed-status copy for a FAILED session-error run, and drops tampered ones', async () => {
    // #given a FAILED provider failure, an out-of-gate reason, and a bogus one
    const failed = makeRunState({
      phase: 'FAILED',
      details: {failureKind: 'session-error', providerFailureReason: 'model-not-available'},
    })
    const running = makeRunState({
      details: {failureKind: 'session-error', providerFailureReason: 'model-not-available'},
    })
    const bogus = makeRunState({
      phase: 'FAILED',
      details: {failureKind: 'session-error', providerFailureReason: 'model not available'},
    })

    // #when projecting through the real gate
    const [a, b, c] = await Promise.all(
      [failed, running, bogus].map(async state =>
        projectRunStatusWithKey(state, {
          nowMs: BASE_NOW_MS,
          staleThresholdMs: STALE_THRESHOLD_MS,
          bindingsLookup: fakeBindingsLookup(makeBinding()),
          isRepoDenied: allowAll,
        }),
      ),
    )

    // #then only the in-gate value is a key; the rows are kept
    if (a?.kind !== 'projected' || b?.kind !== 'projected' || c?.kind !== 'projected') {
      throw new Error('expected projected statuses')
    }
    expect(a.status.providerFailureReason).toBe('model-not-available')
    expect(b.status).not.toHaveProperty('providerFailureReason')
    expect(c.status).not.toHaveProperty('providerFailureReason')
  })

  it('carries provider-quota-exceeded (1.13.0) and drops its internal spelling', async () => {
    // #given a FAILED provider failure stored with the new wire value, and one stored with the internal spelling
    const wire = makeRunState({
      phase: 'FAILED',
      details: {failureKind: 'session-error', providerFailureReason: 'provider-quota-exceeded'},
    })
    const internal = makeRunState({
      phase: 'FAILED',
      details: {failureKind: 'session-error', providerFailureReason: 'provider quota exceeded'},
    })

    // #when projecting through the real gate
    const [a, b] = await Promise.all(
      [wire, internal].map(async state =>
        projectRunStatusWithKey(state, {
          nowMs: BASE_NOW_MS,
          staleThresholdMs: STALE_THRESHOLD_MS,
          bindingsLookup: fakeBindingsLookup(makeBinding()),
          isRepoDenied: allowAll,
        }),
      ),
    )

    // #then the wire value is a key; the internal spelling is omitted and the row is kept
    if (a?.kind !== 'projected' || b?.kind !== 'projected') {
      throw new Error('expected projected statuses')
    }
    expect(a.status.providerFailureReason).toBe('provider-quota-exceeded')
    expect(b.status).not.toHaveProperty('providerFailureReason')
  })
})

// ---------------------------------------------------------------------------
// lookupBindingDenyKeys — one read: deny keys AND the binding, store error kept distinct
// ---------------------------------------------------------------------------

describe('lookupBindingDenyKeys', () => {
  it('returns the binding and its deny keys from a single read', async () => {
    // #given a bound repo
    const binding = makeBinding({databaseId: 42, nodeId: 'R_node_42'})
    const getBindingByRepo = vi.fn(async () => ({success: true as const, data: binding}))

    // #when
    const result = await lookupBindingDenyKeys('acme', 'widget', {getBindingByRepo})

    // #then — the caller gets the very binding it read, and exactly one store call was made
    expect(result).toEqual({kind: 'resolved', repoKey: {databaseId: 42, nodeId: 'R_node_42'}, binding})
    expect(getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
  })

  it('reports a missing binding as resolved with a null/null key and a null binding', async () => {
    const result = await lookupBindingDenyKeys('acme', 'widget', {
      getBindingByRepo: async () => ({success: true as const, data: null}),
    })
    expect(result).toEqual({kind: 'resolved', repoKey: {databaseId: null, nodeId: null}, binding: null})
  })

  it('reports a binding with no deny keys as resolved with a null/null key (fail-closed at the denylist)', async () => {
    const binding = makeBinding({databaseId: undefined, nodeId: undefined})
    const result = await lookupBindingDenyKeys('acme', 'widget', {
      getBindingByRepo: async () => ({success: true as const, data: binding}),
    })
    expect(result).toEqual({kind: 'resolved', repoKey: {databaseId: null, nodeId: null}, binding})
  })

  it('reports a store error result as unavailable, distinct from a missing binding', async () => {
    const result = await lookupBindingDenyKeys('acme', 'widget', {
      getBindingByRepo: async () => ({success: false as const, error: new Error('s3 down')}),
    })
    expect(result).toEqual({kind: 'unavailable'})
  })

  it('reports a throwing store as unavailable and never throws', async () => {
    const result = await lookupBindingDenyKeys('acme', 'widget', {
      getBindingByRepo: async () => {
        throw new Error('boom')
      },
    })
    expect(result).toEqual({kind: 'unavailable'})
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
