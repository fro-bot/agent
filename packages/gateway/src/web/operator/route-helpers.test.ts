/**
 * Tests for resolveRepoAccess — the single bindings-only repo-access predicate.
 *
 * Decision table under test:
 *   malformed name        → denied, zero object-store calls
 *   found, not denied     → allowed (carries the binding), exactly one binding read
 *   found, denied/unprimed→ denied
 *   not found             → denied
 *   store error or throw  → unavailable
 *
 * BDD comments: #given / #when / #then.
 */

import type {RepoKey} from '../../redaction/denylist.js'
import type {RepoAccessDeps} from './route-helpers.js'
import {describe, expect, it, vi} from 'vitest'
import {resolveRepoAccess} from './route-helpers.js'

interface TestBinding {
  readonly owner: string
  readonly repo: string
  readonly databaseId?: number
  readonly nodeId?: string
}

const BINDING: TestBinding = {owner: 'acme', repo: 'widget', databaseId: 42, nodeId: 'R_node_42'}

type Lookup = Awaited<ReturnType<RepoAccessDeps<TestBinding>['bindingsLookup']['getBindingByRepo']>>

function makeDeps(
  result: Lookup | 'throws' = {success: true, data: BINDING},
  denied: boolean | ((key: RepoKey) => boolean) = false,
) {
  const getBindingByRepo = vi.fn(async (_owner: string, _repo: string) => {
    if (result === 'throws') throw new Error('boom')
    return result
  })
  const isRepoDenied = vi.fn((key: RepoKey) => (typeof denied === 'function' ? denied(key) : denied))
  const getDenylistState = vi.fn(async () => undefined)
  const deps: RepoAccessDeps<TestBinding> = {
    bindingsLookup: {getBindingByRepo},
    denylistCache: {getDenylistState, isRepoDenied},
  }
  return {deps, getBindingByRepo, isRepoDenied, getDenylistState}
}

describe('resolveRepoAccess — allowed', () => {
  it('returns allowed with the binding after exactly one getBindingByRepo call', async () => {
    // #given a bound, non-denylisted repo
    const {deps, getBindingByRepo, getDenylistState, isRepoDenied} = makeDeps()

    // #when
    const access = await resolveRepoAccess('acme', 'widget', deps)

    // #then
    expect(access).toEqual({kind: 'allowed', binding: BINDING})
    expect(getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
    expect(getDenylistState).toHaveBeenCalledOnce()
    expect(isRepoDenied).toHaveBeenCalledExactlyOnceWith({databaseId: 42, nodeId: 'R_node_42'})
  })

  it('primes the denylist before consulting it', async () => {
    // #given
    const order: string[] = []
    const {deps} = makeDeps()
    vi.mocked(deps.denylistCache.getDenylistState).mockImplementation(async () => {
      order.push('prime')
    })
    vi.mocked(deps.denylistCache.isRepoDenied).mockImplementation(() => {
      order.push('check')
      return false
    })

    // #when
    await resolveRepoAccess('acme', 'widget', deps)

    // #then
    expect(order).toEqual(['prime', 'check'])
  })

  it.each(['a', 'acme-corp', 'A1', 'a'.repeat(39)])('accepts the valid owner %j', async owner => {
    const {deps, getBindingByRepo} = makeDeps()
    expect((await resolveRepoAccess(owner, 'widget', deps)).kind).toBe('allowed')
    expect(getBindingByRepo).toHaveBeenCalledOnce()
  })

  it.each(['widget', 'my.repo', 'my_repo-2', '.github', 'r'.repeat(100)])('accepts the valid repo %j', async repo => {
    const {deps, getBindingByRepo} = makeDeps()
    expect((await resolveRepoAccess('acme', repo, deps)).kind).toBe('allowed')
    expect(getBindingByRepo).toHaveBeenCalledOnce()
  })
})

describe('resolveRepoAccess — case (D1)', () => {
  it.each([
    ['Acme', 'Widget'],
    ['ACME', 'WIDGET'],
    ['acme', 'Widget'],
    ['Acme', 'widget'],
  ])(
    'finds the binding stored as acme/widget for the request %s/%s, reading the lowercase key',
    async (owner, repo) => {
      // #given a binding stored under the lowercase key, as add-project always writes it
      const {deps, getBindingByRepo} = makeDeps()

      // #when a client sends the slug in another case
      const access = await resolveRepoAccess(owner, repo, deps)

      // #then the lookup is by the canonical (lowercase) key, once, and returns the stored binding as it is
      expect(access).toEqual({kind: 'allowed', binding: BINDING})
      expect(getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
    },
  )

  it('still validates the names as sent: a malformed mixed-case name makes zero store calls', async () => {
    const {deps, getBindingByRepo} = makeDeps()

    const access = await resolveRepoAccess('-Acme', 'Widget', deps)

    expect(access).toEqual({kind: 'denied'})
    expect(getBindingByRepo).not.toHaveBeenCalled()
  })

  it('denies a mixed-case request for an unbound repo exactly like a lowercase one', async () => {
    const {deps} = makeDeps({success: true, data: null})

    expect(await resolveRepoAccess('Acme', 'Widget', deps)).toEqual({kind: 'denied'})
  })
})

describe('resolveRepoAccess — denied', () => {
  it('denies an unbound repo', async () => {
    const {deps, getDenylistState} = makeDeps({success: true, data: null})
    expect(await resolveRepoAccess('acme', 'widget', deps)).toEqual({kind: 'denied'})
    // the denylist is never consulted for a repo that is not bound
    expect(getDenylistState).not.toHaveBeenCalled()
  })

  it('denies a denylisted repo', async () => {
    const {deps} = makeDeps(undefined, true)
    expect(await resolveRepoAccess('acme', 'widget', deps)).toEqual({kind: 'denied'})
  })

  it('denies when the denylist is unprimed (the real predicate denies everything)', async () => {
    const {deps} = makeDeps(undefined, () => true)
    expect((await resolveRepoAccess('acme', 'widget', deps)).kind).toBe('denied')
  })

  it('denies a binding with no deny keys (fail-closed null/null key)', async () => {
    // #given the denylist predicate denies a null/null key, as the real cache does
    const keyless = {owner: 'acme', repo: 'widget'}
    const {deps, isRepoDenied} = makeDeps(
      {success: true, data: keyless},
      key => key.databaseId === null && key.nodeId === null,
    )

    // #when
    const access = await resolveRepoAccess('acme', 'widget', deps)

    // #then
    expect(access).toEqual({kind: 'denied'})
    expect(isRepoDenied).toHaveBeenCalledExactlyOnceWith({databaseId: null, nodeId: null})
  })

  it.each([
    ['empty owner', '', 'widget'],
    ['empty repo', 'acme', ''],
    ['dot repo', 'acme', '.'],
    ['dotdot repo', 'acme', '..'],
    ['dot owner', '.', 'widget'],
    ['dotdot owner', '..', 'widget'],
    ['slash in owner', 'a/b', 'widget'],
    ['slash in repo', 'acme', 'a/b'],
    ['NUL in owner', 'ac\u0000me', 'widget'],
    ['NUL in repo', 'acme', 'wid\u0000get'],
    ['space in repo', 'acme', 'a b'],
    ['over-length owner', 'o'.repeat(40), 'widget'],
    ['over-length repo', 'acme', 'r'.repeat(101)],
    ['leading-hyphen owner', '-acme', 'widget'],
    ['trailing-hyphen owner', 'acme-', 'widget'],
    ['percent-encoded traversal', 'acme', '%2e%2e'],
    ['backslash', 'acme', String.raw`a\b`],
  ])('denies a malformed name (%s) with ZERO binding reads', async (_label, owner, repo) => {
    // #given
    const {deps, getBindingByRepo, getDenylistState} = makeDeps()

    // #when
    const access = await resolveRepoAccess(owner, repo, deps)

    // #then
    expect(access).toEqual({kind: 'denied'})
    expect(getBindingByRepo).not.toHaveBeenCalled()
    expect(getDenylistState).not.toHaveBeenCalled()
  })
})

describe('resolveRepoAccess — unavailable', () => {
  it('returns unavailable when the binding read returns an error result', async () => {
    const {deps, getDenylistState} = makeDeps({success: false, error: new Error('s3 down')})
    expect(await resolveRepoAccess('acme', 'widget', deps)).toEqual({kind: 'unavailable'})
    expect(getDenylistState).not.toHaveBeenCalled()
  })

  it('returns unavailable when the binding read throws', async () => {
    const {deps} = makeDeps('throws')
    expect(await resolveRepoAccess('acme', 'widget', deps)).toEqual({kind: 'unavailable'})
  })

  it('returns unavailable (never throws) when priming the denylist throws', async () => {
    const {deps} = makeDeps()
    vi.mocked(deps.denylistCache.getDenylistState).mockRejectedValue(new Error('cache down'))
    expect(await resolveRepoAccess('acme', 'widget', deps)).toEqual({kind: 'unavailable'})
  })

  it('returns unavailable (never throws) when the denylist predicate throws', async () => {
    const {deps} = makeDeps()
    vi.mocked(deps.denylistCache.isRepoDenied).mockImplementation(() => {
      throw new Error('predicate down')
    })
    expect(await resolveRepoAccess('acme', 'widget', deps)).toEqual({kind: 'unavailable'})
  })
})
