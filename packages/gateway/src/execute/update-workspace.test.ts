import type {MintWorkspaceToken} from './workspace-token.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createUpdateWorkspaceCall} from './update-workspace.js'

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

function makeUpdate(mintToken: ReturnType<typeof vi.fn>) {
  const workspaceClient = {update: vi.fn().mockResolvedValue(ok(READY))}
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const update = createUpdateWorkspaceCall({
    workspaceClient,
    mintToken: mintToken as unknown as MintWorkspaceToken,
    logger,
  })
  return {update, workspaceClient, logger}
}

describe('createUpdateWorkspaceCall', () => {
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

  it("passes through /update's own failures untouched (a workspace timeout is not a mint timeout)", async () => {
    const {update, workspaceClient} = makeUpdate(vi.fn().mockResolvedValue(ok('ghs_minted')))
    workspaceClient.update.mockResolvedValue(err({kind: 'timeout'}))
    expect(await update('acme', 'widget', OPTIONS)).toEqual(err({kind: 'timeout'}))
  })

  describe('mint diagnostics', () => {
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
