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

const NETWORK = (cause: string) => err({kind: 'network-error' as const, cause})
const UNAUTHORIZED = err({kind: 'http-error' as const, status: 401 as const, cause: 'AppNotInstalledError'})

function makeUpdate(mintToken: ReturnType<typeof vi.fn>, mintTimeoutMs?: number) {
  const workspaceClient = {update: vi.fn().mockResolvedValue(ok(READY))}
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const update = createUpdateWorkspaceCall({
    workspaceClient,
    mintToken: mintToken as unknown as MintWorkspaceToken,
    logger,
    ...(mintTimeoutMs === undefined ? {} : {mintTimeoutMs}),
  })
  return {update, workspaceClient, logger}
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
    ['a permanent installation failure', UNAUTHORIZED],
    ['a retryable mint failure', NETWORK('AuthError')],
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
    expect(await pending).toEqual(NETWORK('timeout'))
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
    expect(result).toEqual(NETWORK('timeout'))
    expect(workspaceClient.update).not.toHaveBeenCalled()
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
    const {update} = makeUpdate(mint, 50)
    // #when
    const pending = update('acme', 'widget', OPTIONS)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    rejectMint(new Error('late boom'))
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()

    // #then the rejection arrived after the result was settled, so it changes nothing
    expect(result).toEqual(NETWORK('timeout'))
  })

  it('a mint that throws is handled as a transient failure and /update is never sent', async () => {
    const {update, workspaceClient} = makeUpdate(vi.fn().mockRejectedValue(new Error('boom')))
    expect(await update('acme', 'widget', OPTIONS)).toEqual(NETWORK('Error'))
    expect(workspaceClient.update).not.toHaveBeenCalled()
  })

  it("passes through /update's own failures untouched (a workspace timeout is not a mint timeout)", async () => {
    const {update, workspaceClient} = makeUpdate(vi.fn().mockResolvedValue(ok('ghs_minted')))
    workspaceClient.update.mockResolvedValue(err({kind: 'timeout'}))
    expect(await update('acme', 'widget', OPTIONS)).toEqual(err({kind: 'timeout'}))
  })

  describe('mint diagnostics', () => {
    const MESSAGE = 'ghs_secret_token_in_message'

    it('logs ONE warning per mint failure: owner, repo, cause and, for a 401, the status', async () => {
      // #given
      const {update, logger} = makeUpdate(vi.fn().mockResolvedValue(UNAUTHORIZED))

      // #when
      await update('acme', 'widget', OPTIONS)

      // #then
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        {owner: 'acme', repo: 'widget', cause: 'AppNotInstalledError', status: 401},
        'run: installation token mint failed before update',
      )
    })

    it('a retryable failure carries no status field', async () => {
      const {update, logger} = makeUpdate(vi.fn().mockResolvedValue(NETWORK('AuthError')))
      await update('acme', 'widget', OPTIONS)
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        {owner: 'acme', repo: 'widget', cause: 'AuthError'},
        'run: installation token mint failed before update',
      )
    })

    it('a stalled mint is logged with the cause "timeout"', async () => {
      // #given
      vi.useFakeTimers()
      const {update, logger} = makeUpdate(vi.fn().mockReturnValue(new Promise(() => {})), 50)

      // #when
      const pending = update('acme', 'widget', OPTIONS)
      await vi.advanceTimersByTimeAsync(50)
      await pending

      // #then
      expect(logger.warn).toHaveBeenCalledOnce()
      expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({cause: 'timeout'})
    })

    it('a thrown TypeError surfaces its class name and never its message', async () => {
      // #given
      const {update, logger} = makeUpdate(vi.fn().mockRejectedValue(new TypeError(MESSAGE)))

      // #when
      await update('acme', 'widget', OPTIONS)

      // #then
      expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({cause: 'TypeError'})
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(MESSAGE)
    })

    it('logs nothing when the mint succeeds', async () => {
      const {update, logger} = makeUpdate(vi.fn().mockResolvedValue(ok('ghs_minted')))
      await update('acme', 'widget', OPTIONS)
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it("does not log /update's own failures as mint failures", async () => {
      const {update, workspaceClient, logger} = makeUpdate(vi.fn().mockResolvedValue(ok('ghs_minted')))
      workspaceClient.update.mockResolvedValue(err({kind: 'timeout'}))
      await update('acme', 'widget', OPTIONS)
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })
})
