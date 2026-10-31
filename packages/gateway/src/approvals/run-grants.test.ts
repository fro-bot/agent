import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'

import {describe, expect, it, vi} from 'vitest'

import {createRunGrants, replyUpstream, scopeAlwaysToRun, wildcardMatch} from './run-grants.js'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestID: 'per_1',
    sessionID: 'ses_root',
    permission: 'bash',
    patterns: ['rm /tmp/a'],
    alwaysPatterns: ['rm *'],
    title: 'Run command: rm /tmp/a',
    ...overrides,
  }
}

describe('wildcardMatch parity with upstream Wildcard.match', () => {
  // Expected values were produced by running the upstream function on each pair: V2 v2.2.0
  // `packages/core/src/util/wildcard.ts` and V1 1.19.4 `packages/core/src/util/wildcard.ts` (byte-identical bodies,
  // verified equal on every row). Regenerate by running both against this table when the pins move.
  // [input, pattern, upstream result]
  const UPSTREAM_TABLE: readonly (readonly [string, string, boolean])[] = [
    ['rm -rf x', 'rm *', true],
    ['rm', 'rm *', true],
    ['rmdir x', 'rm *', false],
    ['rm', 'rm', true],
    ['rm x', 'rm', false],
    ['anything', '*', true],
    ['', '*', true],
    ['ls -la', 'ls *', true],
    ['ls', 'ls *', true],
    ['lsx', 'ls *', false],
    ['a.b', 'a.b', true],
    ['axb', 'a.b', false],
    ['abc', 'a?c', true],
    ['ac', 'a?c', false],
    ['/tmp/a/b', '/tmp/*', true],
    ['/tmp', '/tmp/*', false],
    ['/tmp/', '/tmp/*', true],
    [String.raw`C:\x\y`, 'C:/x/*', true],
    ['C:/x/y', String.raw`C:\x\*`, true],
    ['rm a\nb', 'rm *', true],
    ['a+b', 'a+b', true],
    ['aab', 'a+b', false],
    ['f(1)', 'f(1)', true],
    ['[x]', '[x]', true],
    ['x', '[x]', false],
    ['$HOME', '$HOME', true],
    ['^a', '^a', true],
    ['a|b', 'a|b', true],
    ['a', 'a|b', false],
    ['git commit -m "x"', 'git commit *', true],
    ['git', 'git *', true],
    ['git ', 'git *', true],
    ['npm run build', 'npm * build', true],
    ['x', ' *', false],
    ['', ' *', true],
    [' x', ' *', true],
    ['RM x', 'rm *', false],
    ['edit', 'edit', true],
    ['bash', 'bash', true],
    ['bashx', 'bash', false],
    ['/a/b/c.ts', '*', true],
    ['/a/b/c.ts', '/a/*/c.ts', true],
    ['/a/c.ts', '/a/*/c.ts', false],
    ['rm  x', 'rm *', true],
    ['{a}', '{a}', true],
  ]

  it.each(UPSTREAM_TABLE)('match(%j, %j) is %s', (input, pattern, expected) => {
    expect(wildcardMatch(input, pattern)).toBe(expected)
  })
})

describe('replyUpstream', () => {
  it('never lets an always reach upstream', () => {
    expect(replyUpstream('always')).toBe('once')
    expect(replyUpstream('once')).toBe('once')
    expect(replyUpstream('reject')).toBe('reject')
  })
})

describe('createRunGrants', () => {
  it('covers a later ask whose every resource matches a stored grant for the same action', () => {
    // #given an operator Always on `rm /tmp/a`, whose upstream save list is `rm *`
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.grant('per_1')

    // #then a different rm in the same action is covered, a different command is not
    expect(grants.covers(makeRequest({requestID: 'per_2', patterns: ['rm -rf /tmp/b']}))).toBe(true)
    expect(grants.covers(makeRequest({requestID: 'per_3', patterns: ['rmdir /tmp/b']}))).toBe(false)
  })

  it('does not cover an ask in a different action, even with a matching resource', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.grant('per_1')

    expect(grants.covers(makeRequest({requestID: 'per_2', permission: 'edit', patterns: ['rm /tmp/b']}))).toBe(false)
  })

  it('still asks when only some of the requested resources match', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.grant('per_1')

    expect(grants.covers(makeRequest({requestID: 'per_2', patterns: ['rm /tmp/b', 'curl http://x']}))).toBe(false)
  })

  it('never covers an ask that requests no resources', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest({alwaysPatterns: ['*']}))
    grants.grant('per_1')

    expect(grants.covers(makeRequest({requestID: 'per_2', patterns: []}))).toBe(false)
  })

  it('stores nothing when the ask carried no patterns to save (upstream would save nothing either)', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest({alwaysPatterns: []}))
    grants.grant('per_1')

    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })

  it('ignores a grant for a request it never saw', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.grant('per_unknown')

    expect(grants.covers(makeRequest())).toBe(false)
  })

  it('matches the action as upstream does: the stored action is the pattern', () => {
    // #given a grant stored under a wildcard-free action
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest({permission: 'external_directory', patterns: ['/x/y'], alwaysPatterns: ['/x/*']}))
    grants.grant('per_1')

    // #then
    expect(
      grants.covers(makeRequest({requestID: 'per_2', permission: 'external_directory', patterns: ['/x/z/w']})),
    ).toBe(true)
    expect(
      grants.covers(makeRequest({requestID: 'per_3', permission: 'external_directory_x', patterns: ['/x/z/w']})),
    ).toBe(false)
  })

  it('drops every grant and refuses new ones afterwards', () => {
    // #given a grant in force
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.grant('per_1')
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(true)

    // #when
    grants.drop()

    // #then nothing is covered, and a late grant cannot resurrect the set
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
    grants.noteAsked(makeRequest({requestID: 'per_9'}))
    grants.grant('per_9')
    expect(grants.covers(makeRequest({requestID: 'per_10'}))).toBe(false)
    expect(grants.isDropped()).toBe(true)
  })

  it('keeps one run’s grants out of another run’s set', () => {
    // #given two runs sharing nothing but a workspace
    const runB = createRunGrants({logger: makeLogger(), runId: 'run_b'})
    const runC = createRunGrants({logger: makeLogger(), runId: 'run_c'})
    runB.noteAsked(makeRequest())
    runB.grant('per_1')

    // #then
    expect(runB.covers(makeRequest({requestID: 'per_2'}))).toBe(true)
    expect(runC.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })
})

function setup(postResult: {ok: boolean; error?: string} = {ok: true}) {
  const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
  const inner = vi.fn().mockResolvedValue(postResult)
  const factory = vi.fn().mockReturnValue(inner)
  const scoped = scopeAlwaysToRun(factory, grants)
  return {grants, inner, factory, scoped}
}

describe('scopeAlwaysToRun', () => {
  it('records the grant once the Always reply lands, and passes the decision on for the factory to downgrade', async () => {
    // #given
    const {grants, inner, scoped} = setup()
    grants.noteAsked(makeRequest())

    // #when
    const result = await scoped('ses_root')('per_1', '/d', 'always')

    // #then
    expect(result).toEqual({ok: true})
    expect(inner).toHaveBeenCalledWith('per_1', '/d', 'always')
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(true)
  })

  it('records nothing when the Always reply fails', async () => {
    const {grants, scoped} = setup({ok: false, error: 'http 500'})
    grants.noteAsked(makeRequest())

    const result = await scoped('ses_root')('per_1', '/d', 'always')

    expect(result).toEqual({ok: false, error: 'http 500'})
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })

  it.each(['once', 'reject'] as const)('records nothing for %s', async decision => {
    const {grants, inner, scoped} = setup()
    grants.noteAsked(makeRequest())

    await scoped('ses_root')('per_1', '/d', decision)

    expect(inner).toHaveBeenCalledWith('per_1', '/d', decision)
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })

  it('does not record a grant after the set was dropped while the reply was in flight', async () => {
    // #given an Always reply that is still in flight when the run ends
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    let release: (value: {ok: boolean}) => void = () => {}
    const inner = vi.fn().mockReturnValue(
      new Promise<{ok: boolean}>(resolve => {
        release = resolve
      }),
    )
    const scoped = scopeAlwaysToRun(() => inner, grants)
    grants.noteAsked(makeRequest())

    // #when
    const pending = scoped('ses_root')('per_1', '/d', 'always')
    grants.drop()
    release({ok: true})
    await pending

    // #then
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })
})

describe('createRunGrants: pending Always and the reply echo', () => {
  it('records the grant from the echo when the Always reply’s response is lost', () => {
    // #given an Always reply sent whose HTTP response never came
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.beginAlways('per_1')

    // #when OpenCode's permission.replied echo arrives
    grants.confirm('per_1', 'once')

    // #then the grant is in force
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(true)
  })

  it('records one grant when both the success and the echo arrive, in either order', () => {
    const listener = vi.fn()
    for (const order of ['success-first', 'echo-first'] as const) {
      const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
      grants.onGranted(listener)
      grants.noteAsked(makeRequest())
      grants.beginAlways('per_1')
      if (order === 'success-first') {
        grants.grant('per_1')
        grants.confirm('per_1', 'once')
      } else {
        grants.confirm('per_1', 'once')
        grants.grant('per_1')
      }
    }
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('tells the listener which request produced the grant', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    const listener = vi.fn()
    grants.onGranted(listener)
    grants.noteAsked(makeRequest())
    grants.beginAlways('per_1')
    grants.confirm('per_1', 'once')
    expect(listener).toHaveBeenCalledExactlyOnceWith('per_1')
  })

  it('records nothing from an echo after the set was dropped', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.beginAlways('per_1')
    grants.drop()

    grants.confirm('per_1', 'once')

    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })

  it('records nothing from the echo of an ask whose Always was never sent', () => {
    // #given an ask the operator answered once (or another surface did)
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())

    // #when its echo arrives
    grants.confirm('per_1', 'once')

    // #then nothing is granted
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })

  it('records nothing from a reject echo, and forgets the pending Always', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.beginAlways('per_1')

    grants.confirm('per_1', 'reject')
    grants.confirm('per_1', 'once')

    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })

  it('forgets a pending Always that was released (a retry with another decision)', () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    grants.noteAsked(makeRequest())
    grants.beginAlways('per_1')
    grants.releaseAlways('per_1')

    grants.confirm('per_1', 'once')

    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })
})

describe('scopeAlwaysToRun: pending Always', () => {
  it('keeps the Always pending across an ambiguous failure, so the echo can still confirm it', async () => {
    // #given an Always reply that threw (the request may have landed)
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    const scoped = scopeAlwaysToRun(() => async () => ({ok: false, error: 'threw'}), grants)
    grants.noteAsked(makeRequest())

    // #when
    const result = await scoped('ses_root')('per_1', '/d', 'always')
    grants.confirm('per_1', 'once')

    // #then the echo recorded the grant
    expect(result.ok).toBe(false)
    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(true)
  })

  it('records the grant from the echo that lands while the response is still in flight', async () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    let finish: (value: {ok: boolean}) => void = () => {}
    const scoped = scopeAlwaysToRun(
      () => async () =>
        new Promise<{ok: boolean}>(resolve => {
          finish = resolve
        }),
      grants,
    )
    grants.noteAsked(makeRequest())
    const pending = scoped('ses_root')('per_1', '/d', 'always')

    grants.confirm('per_1', 'once')

    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(true)
    finish({ok: true})
    await pending
  })

  it.each(['http 404', 'auth 401'])('forgets the Always after a definite failure (%s)', async error => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    const scoped = scopeAlwaysToRun(() => async () => ({ok: false, error}), grants)
    grants.noteAsked(makeRequest())

    await scoped('ses_root')('per_1', '/d', 'always')
    grants.confirm('per_1', 'once')

    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })

  it('forgets the Always when the operator retries with another decision', async () => {
    const grants = createRunGrants({logger: makeLogger(), runId: 'run_1'})
    const scoped = scopeAlwaysToRun(() => async () => ({ok: false, error: 'threw'}), grants)
    grants.noteAsked(makeRequest())
    await scoped('ses_root')('per_1', '/d', 'always')

    await scoped('ses_root')('per_1', '/d', 'reject')
    grants.confirm('per_1', 'once')

    expect(grants.covers(makeRequest({requestID: 'per_2'}))).toBe(false)
  })
})
