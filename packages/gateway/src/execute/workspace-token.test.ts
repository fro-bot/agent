import type {MintWorkspaceToken} from './workspace-token.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS, mintBounded} from './workspace-token.js'

type MintResult = Awaited<ReturnType<MintWorkspaceToken>>

const NETWORK_ERROR = err({kind: 'network-error' as const, cause: 'AuthError'})
const NOT_INSTALLED = err({kind: 'http-error' as const, status: 401 as const, cause: 'AppNotInstalledError'})
const TIMED_OUT = err({kind: 'network-error' as const, cause: 'timeout'})

async function never(): ReturnType<MintWorkspaceToken> {
  return new Promise(() => {})
}

describe('mintBounded', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the minted token and passes owner and repo through', async () => {
    // #given
    const mint = vi.fn().mockResolvedValue(ok('ghs_minted'))

    // #when
    const result = await mintBounded(mint, 'acme', 'widget', 1_000)

    // #then
    expect(result).toEqual(ok('ghs_minted'))
    expect(mint).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
  })

  it.each([
    ['a permanent installation failure keeps its 401 and its cause', NOT_INSTALLED],
    ['a retryable mint failure keeps its network-error and its cause', NETWORK_ERROR],
  ])('%s', async (_label, failure) => {
    expect(await mintBounded(vi.fn().mockResolvedValue(failure), 'acme', 'widget', 1_000)).toEqual(failure)
  })

  it('a mint that never settles gives up at the ceiling, not before, as a transient network-error', async () => {
    // #given
    vi.useFakeTimers()

    // #when
    const pending = mintBounded(vi.fn().mockReturnValue(never()), 'acme', 'widget', 1_000)
    let settled = false
    const tracked = pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(999)
    const settledEarly = settled
    await vi.advanceTimersByTimeAsync(1)

    // #then a timeout is transient: it is never reported as the permanent 401
    expect(settledEarly).toBe(false)
    expect(await pending).toEqual(TIMED_OUT)
    await tracked
  })

  it('a mint that throws is a transient network-error whose cause is the error class, never its message', async () => {
    // #when / #then
    const result = await mintBounded(
      vi.fn().mockRejectedValue(new TypeError('secret detail in the message')),
      'acme',
      'widget',
      1_000,
    )
    expect(result).toEqual(err({kind: 'network-error', cause: 'TypeError'}))
    expect(JSON.stringify(result)).not.toContain('secret detail')
  })

  it('a thrown value that is not an Error has the cause "threw"', async () => {
    expect(await mintBounded(vi.fn().mockRejectedValue('just a string'), 'acme', 'widget', 1_000)).toEqual(
      err({kind: 'network-error', cause: 'threw'}),
    )
  })

  it('a mint that throws SYNCHRONOUSLY (a non-async mint) is handled the same way and leaves no timer behind', async () => {
    // #given
    vi.useFakeTimers()
    const mint = vi.fn().mockImplementation(() => {
      throw new RangeError('sync boom')
    })

    // #when
    const result = await mintBounded(mint, 'acme', 'widget', 1_000)

    // #then
    expect(result).toEqual(err({kind: 'network-error', cause: 'RangeError'}))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a mint that answers after the ceiling cannot change the result', async () => {
    // #given
    vi.useFakeTimers()
    let resolveMint: (value: MintResult) => void = () => {}
    const mint = vi.fn().mockReturnValue(
      new Promise<MintResult>(resolve => {
        resolveMint = resolve
      }),
    )

    // #when
    const pending = mintBounded(mint, 'acme', 'widget', 50)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    resolveMint(ok('ghs_late'))
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(result).toEqual(TIMED_OUT)
  })

  it('a mint that rejects after the ceiling changes nothing', async () => {
    // #given
    vi.useFakeTimers()
    let rejectMint: (reason: Error) => void = () => {}
    const mint = vi.fn().mockReturnValue(
      new Promise<MintResult>((_resolve, reject) => {
        rejectMint = reject
      }),
    )
    // #when
    const pending = mintBounded(mint, 'acme', 'widget', 50)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    rejectMint(new Error('late boom'))
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()

    // #then the rejection arrived after the result was settled, so it changes nothing
    expect(result).toEqual(TIMED_OUT)
  })

  it('clears its timer once the mint answers', async () => {
    vi.useFakeTimers()
    await mintBounded(vi.fn().mockResolvedValue(ok('ghs_minted')), 'acme', 'widget', 1_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('INSTALLATION_TOKEN_MINT_TIMEOUT_MS', () => {
  it('is 30 s, pinned to the literal rather than to the alias it was copied from', () => {
    expect(INSTALLATION_TOKEN_MINT_TIMEOUT_MS).toBe(30_000)
  })
})
