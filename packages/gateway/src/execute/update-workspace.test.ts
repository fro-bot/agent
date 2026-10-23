import type {MintWorkspaceToken} from './workspace-token.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createUpdateWorkspaceCall} from './update-workspace.js'
import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS} from './workspace-token.js'

type MintResult = Awaited<ReturnType<MintWorkspaceToken>>

const OPTIONS = {remainingBudgetMs: 90_000}
const READY = {
  kind: 'ready',
  change: 'unchanged',
  branch: 'main',
  sha: 'a'.repeat(40),
  checkedAt: '2026-01-01T00:00:00.000Z',
}

function makeUpdate(mintToken: ReturnType<typeof vi.fn>, mintTimeoutMs?: number) {
  const workspaceClient = {update: vi.fn().mockResolvedValue(ok(READY))}
  const update = createUpdateWorkspaceCall({
    workspaceClient,
    mintToken: mintToken as unknown as MintWorkspaceToken,
    ...(mintTimeoutMs === undefined ? {} : {mintTimeoutMs}),
  })
  return {update, workspaceClient}
}

describe('createUpdateWorkspaceCall', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('mints a token for the repo and sends it with the run budget to /update', async () => {
    // #given
    const mint = vi.fn().mockResolvedValue(ok('ghs_minted'))
    const {update, workspaceClient} = makeUpdate(mint)

    // #when
    const result = await update('acme', 'widget', OPTIONS)

    // #then
    expect(result).toEqual(ok(READY))
    expect(mint).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
    expect(workspaceClient.update).toHaveBeenCalledExactlyOnceWith(
      {owner: 'acme', repo: 'widget', token: 'ghs_minted'},
      OPTIONS,
    )
  })

  it.each([
    ['a permanent installation failure', err({kind: 'http-error' as const, status: 401 as const})],
    ['a retryable mint failure', err({kind: 'network-error' as const})],
  ])('%s is returned unchanged (the mapping run.ts already applies) and /update is never sent', async (_l, failure) => {
    const {update, workspaceClient} = makeUpdate(vi.fn().mockResolvedValue(failure))
    expect(await update('acme', 'widget', OPTIONS)).toEqual(failure)
    expect(workspaceClient.update).not.toHaveBeenCalled()
  })

  it('a mint that never settles gives up at the ceiling and /update is never sent', async () => {
    // #given
    vi.useFakeTimers()
    const {update, workspaceClient} = makeUpdate(vi.fn().mockReturnValue(new Promise(() => {})))

    // #when
    const pending = update('acme', 'widget', OPTIONS)
    let settled = false
    const tracked = pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(INSTALLATION_TOKEN_MINT_TIMEOUT_MS - 1)
    const settledEarly = settled
    await vi.advanceTimersByTimeAsync(1)

    // #then a transient failure (retryable), not the permanent 401 and not an update timeout
    expect(settledEarly).toBe(false)
    expect(await pending).toEqual(err({kind: 'network-error'}))
    await tracked
    expect(workspaceClient.update).not.toHaveBeenCalled()
  })

  it('a mint that succeeds only AFTER the ceiling does not send /update', async () => {
    // #given
    vi.useFakeTimers()
    let resolveMint: (value: MintResult) => void = () => {}
    const mint = vi.fn().mockReturnValue(
      new Promise<MintResult>(resolve => {
        resolveMint = resolve
      }),
    )
    const {update, workspaceClient} = makeUpdate(mint, 50)

    // #when
    const pending = update('acme', 'widget', OPTIONS)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    resolveMint(ok('ghs_late'))
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(result).toEqual(err({kind: 'network-error'}))
    expect(workspaceClient.update).not.toHaveBeenCalled()
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
    const {update} = makeUpdate(mint, 50)
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)

    try {
      // #when
      const pending = update('acme', 'widget', OPTIONS)
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

  it('a mint that throws is handled as a transient failure and /update is never sent', async () => {
    const {update, workspaceClient} = makeUpdate(vi.fn().mockRejectedValue(new Error('boom')))
    expect(await update('acme', 'widget', OPTIONS)).toEqual(err({kind: 'network-error'}))
    expect(workspaceClient.update).not.toHaveBeenCalled()
  })

  it("passes through /update's own failures untouched (a workspace timeout is not a mint timeout)", async () => {
    const {update, workspaceClient} = makeUpdate(vi.fn().mockResolvedValue(ok('ghs_minted')))
    workspaceClient.update.mockResolvedValue(err({kind: 'timeout'}))
    expect(await update('acme', 'widget', OPTIONS)).toEqual(err({kind: 'timeout'}))
  })
})
