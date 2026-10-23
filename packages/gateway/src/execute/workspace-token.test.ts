import type {MintWorkspaceToken} from './workspace-token.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS} from '../workspace-api/ensure-clone.js'
import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS, mintBounded} from './workspace-token.js'

type MintResult = Awaited<ReturnType<MintWorkspaceToken>>

const NETWORK_ERROR = err({kind: 'network-error' as const})
const NOT_INSTALLED = err({kind: 'http-error' as const, status: 401 as const})

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
    ['a permanent installation failure keeps its 401', NOT_INSTALLED],
    ['a retryable mint failure keeps its network-error', NETWORK_ERROR],
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
    expect(await pending).toEqual(NETWORK_ERROR)
    await tracked
  })

  it('a mint that throws is handled as a transient network-error', async () => {
    expect(await mintBounded(vi.fn().mockRejectedValue(new Error('boom')), 'acme', 'widget', 1_000)).toEqual(
      NETWORK_ERROR,
    )
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
    expect(result).toEqual(NETWORK_ERROR)
  })

  it('a mint that rejects after the ceiling raises no unhandled rejection', async () => {
    // #given
    vi.useFakeTimers()
    let rejectMint: (reason: Error) => void = () => {}
    const mint = vi.fn().mockReturnValue(
      new Promise<MintResult>((_resolve, reject) => {
        rejectMint = reject
      }),
    )
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      // #when
      const pending = mintBounded(mint, 'acme', 'widget', 50)
      await vi.advanceTimersByTimeAsync(50)
      await pending
      rejectMint(new Error('late boom'))
      await vi.advanceTimersByTimeAsync(1_000)
      await Promise.resolve()

      // #then
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('clears its timer once the mint answers', async () => {
    vi.useFakeTimers()
    await mintBounded(vi.fn().mockResolvedValue(ok('ghs_minted')), 'acme', 'widget', 1_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('INSTALLATION_TOKEN_MINT_TIMEOUT_MS', () => {
  it('is the 30 s the same authForRepo call already gets when a clone is ensured: one number, not two', () => {
    expect(INSTALLATION_TOKEN_MINT_TIMEOUT_MS).toBe(DEFAULT_ENSURE_CLONE_AUTH_TIMEOUT_MS)
    expect(INSTALLATION_TOKEN_MINT_TIMEOUT_MS).toBe(30_000)
  })
})
