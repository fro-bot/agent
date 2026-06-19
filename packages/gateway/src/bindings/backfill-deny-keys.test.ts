/**
 * Tests for the offline/admin active-binding deny-key backfill.
 *
 * Uses vitest with BDD-style comments (#given, #when, #then).
 * All external I/O is injected — no real network or store connections.
 */

import type {BindingsStore} from './store.js'
import type {RepoBinding} from './types.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {backfillActiveBindingDenyKeys} from './backfill-deny-keys.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBinding(overrides: Partial<RepoBinding> = {}): RepoBinding {
  return {
    owner: 'testowner',
    repo: 'testrepo',
    channelId: 'ch-123',
    channelName: 'testrepo',
    workspacePath: '/workspace/repos/testowner/testrepo',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdByDiscordId: 'user-1',
    ...overrides,
  }
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeBindingsStore(overrides?: {listBindings?: ReturnType<typeof vi.fn>}): BindingsStore {
  return {
    getBindingByRepo: vi.fn().mockResolvedValue(ok(null)),
    getBindingByChannelId: vi.fn().mockResolvedValue(ok(null)),
    listBindings: overrides?.listBindings ?? vi.fn().mockResolvedValue(ok([])),
    createBinding: vi.fn().mockResolvedValue(ok({primaryEtag: 'e1', indexEtag: 'e2'})),
  } as unknown as BindingsStore
}

function makeGetRepoIdentity(
  result: {databaseId: number; nodeId: string} | Error = {databaseId: 42, nodeId: 'node-1'},
) {
  if (result instanceof Error) {
    return vi.fn().mockResolvedValue(err(result))
  }
  return vi.fn().mockResolvedValue(ok(result))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfillActiveBindingDenyKeys', () => {
  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  it('happy path: active binding missing deny keys gets databaseId and nodeId populated', async () => {
    // #given — one binding with no deny keys
    const binding = makeBinding()
    const listBindings = vi.fn().mockResolvedValue(ok([binding]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = makeGetRepoIdentity({databaseId: 123456789, nodeId: 'MDEwOlJlcG9zaXRvcnkx'})
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then — succeeded
    expect(result.success).toBe(true)
    // #and — getRepoIdentity was called for the binding
    expect(getRepoIdentity).toHaveBeenCalledWith('testowner', 'testrepo')
    // #and — writeBinding was called with the deny keys merged in
    expect(writeBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'testowner',
        repo: 'testrepo',
        databaseId: 123456789,
        nodeId: 'MDEwOlJlcG9zaXRvcnkx',
      }),
    )
    // #and — result reports counts
    if (result.success === false) return
    expect(result.data.total).toBe(1)
    expect(result.data.updated).toBe(1)
    expect(result.data.skipped).toBe(0)
    expect(result.data.failed).toBe(0)
  })

  it('happy path: binding that already has both deny keys is skipped (no write call)', async () => {
    // #given — binding already has databaseId and nodeId
    const binding = makeBinding({databaseId: 999, nodeId: 'existing-node-id'})
    const listBindings = vi.fn().mockResolvedValue(ok([binding]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = makeGetRepoIdentity()
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then — skipped (no write)
    expect(result.success).toBe(true)
    expect(writeBinding).not.toHaveBeenCalled()
    expect(getRepoIdentity).not.toHaveBeenCalled()
    if (result.success === false) return
    expect(result.data.total).toBe(1)
    expect(result.data.updated).toBe(0)
    expect(result.data.skipped).toBe(1)
    expect(result.data.failed).toBe(0)
  })

  it('happy path: binding with only databaseId is skipped (already has primary deny key)', async () => {
    // #given — binding has databaseId but no nodeId
    const binding = makeBinding({databaseId: 42})
    const listBindings = vi.fn().mockResolvedValue(ok([binding]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = makeGetRepoIdentity()
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then — skipped (primary deny key already present)
    expect(result.success).toBe(true)
    expect(writeBinding).not.toHaveBeenCalled()
    expect(getRepoIdentity).not.toHaveBeenCalled()
    if (result.success === false) return
    expect(result.data.skipped).toBe(1)
  })

  it('happy path: empty binding list → no updates, no errors', async () => {
    // #given — no bindings
    const listBindings = vi.fn().mockResolvedValue(ok([]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = makeGetRepoIdentity()
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then
    expect(result.success).toBe(true)
    expect(writeBinding).not.toHaveBeenCalled()
    expect(getRepoIdentity).not.toHaveBeenCalled()
    if (result.success === false) return
    expect(result.data.total).toBe(0)
    expect(result.data.updated).toBe(0)
    expect(result.data.skipped).toBe(0)
    expect(result.data.failed).toBe(0)
  })

  it('happy path: multiple bindings — some missing keys, some already have keys', async () => {
    // #given — three bindings: one missing keys, one with keys, one missing keys
    const bindingA = makeBinding({owner: 'org', repo: 'alpha'})
    const bindingB = makeBinding({owner: 'org', repo: 'beta', databaseId: 1, nodeId: 'node-b'})
    const bindingC = makeBinding({owner: 'org', repo: 'gamma'})
    const listBindings = vi.fn().mockResolvedValue(ok([bindingA, bindingB, bindingC]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = vi
      .fn()
      .mockResolvedValueOnce(ok({databaseId: 10, nodeId: 'node-a'}))
      .mockResolvedValueOnce(ok({databaseId: 30, nodeId: 'node-c'}))
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.total).toBe(3)
    expect(result.data.updated).toBe(2)
    expect(result.data.skipped).toBe(1)
    expect(result.data.failed).toBe(0)
    // getRepoIdentity called only for bindings missing keys
    expect(getRepoIdentity).toHaveBeenCalledTimes(2)
    expect(getRepoIdentity).toHaveBeenCalledWith('org', 'alpha')
    expect(getRepoIdentity).toHaveBeenCalledWith('org', 'gamma')
    // writeBinding called for alpha and gamma
    expect(writeBinding).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // Error paths: per-binding failure is non-fatal
  // -------------------------------------------------------------------------

  it('per-binding getRepoIdentity failure is logged and does not abort the backfill', async () => {
    // #given — two bindings; first identity call fails, second succeeds
    const bindingA = makeBinding({owner: 'org', repo: 'alpha'})
    const bindingB = makeBinding({owner: 'org', repo: 'beta'})
    const listBindings = vi.fn().mockResolvedValue(ok([bindingA, bindingB]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = vi
      .fn()
      .mockResolvedValueOnce(err(new Error('API timeout')))
      .mockResolvedValueOnce(ok({databaseId: 20, nodeId: 'node-b'}))
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then — backfill completed (not aborted)
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.total).toBe(2)
    expect(result.data.updated).toBe(1)
    expect(result.data.failed).toBe(1)
    // #and — error was logged for the failed binding
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('identity'),
      expect.objectContaining({owner: 'org', repo: 'alpha'}),
    )
    // #and — second binding was still updated
    expect(writeBinding).toHaveBeenCalledTimes(1)
    expect(writeBinding).toHaveBeenCalledWith(expect.objectContaining({repo: 'beta', databaseId: 20}))
  })

  it('per-binding writeBinding failure is logged and does not abort the backfill', async () => {
    // #given — two bindings; first write fails, second succeeds
    const bindingA = makeBinding({owner: 'org', repo: 'alpha'})
    const bindingB = makeBinding({owner: 'org', repo: 'beta'})
    const listBindings = vi.fn().mockResolvedValue(ok([bindingA, bindingB]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = vi
      .fn()
      .mockResolvedValueOnce(ok({databaseId: 10, nodeId: 'node-a'}))
      .mockResolvedValueOnce(ok({databaseId: 20, nodeId: 'node-b'}))
    let writeCallCount = 0
    const writeBinding = vi.fn().mockImplementation(async () => {
      writeCallCount++
      if (writeCallCount === 1) return err(new Error('S3 write failed'))
      return ok(undefined)
    })
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then — backfill completed (not aborted)
    expect(result.success).toBe(true)
    if (result.success === false) return
    expect(result.data.total).toBe(2)
    expect(result.data.updated).toBe(1)
    expect(result.data.failed).toBe(1)
    // #and — error was logged for the failed write
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('update'),
      expect.objectContaining({owner: 'org', repo: 'alpha'}),
    )
  })

  it('listBindings failure → returns err (whole backfill fails, not per-binding)', async () => {
    // #given — listBindings fails
    const listBindings = vi.fn().mockResolvedValue(err(new Error('S3 unavailable')))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = makeGetRepoIdentity()
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then — whole backfill fails
    expect(result.success).toBe(false)
    expect(getRepoIdentity).not.toHaveBeenCalled()
    expect(writeBinding).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Security: not wired into any request path
  // -------------------------------------------------------------------------

  it('backfill is a standalone function (not exported from any request handler module)', async () => {
    // #given — the backfill function is importable directly
    // This test asserts the function exists and is callable as a standalone admin entrypoint.
    // It does NOT test that it is absent from request handlers (that is a structural constraint
    // enforced by code review and the plan's scope boundary).
    const listBindings = vi.fn().mockResolvedValue(ok([]))
    const store = makeBindingsStore({listBindings})
    const getRepoIdentity = makeGetRepoIdentity()
    const writeBinding = vi.fn().mockResolvedValue(ok(undefined))
    const logger = makeLogger()

    // #when — called directly (not via any request handler)
    const result = await backfillActiveBindingDenyKeys({
      bindingsStore: store,
      getRepoIdentity,
      writeBinding,
      logger,
    })

    // #then — resolves without error
    expect(result.success).toBe(true)
  })
})
