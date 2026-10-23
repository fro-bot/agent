import type {AppClient} from '../github/app-client.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  AppNotInstalledError,
  AuthError,
  AuthTimeoutError,
  INSTALLATION_TOKEN_MINT_TIMEOUT_MS,
  InsufficientPermissionsError,
} from '../github/app-client.js'
import {createWorkspaceCalls} from './workspace-calls.js'

const INSTALL_URL = 'https://github.com/apps/fro-bot-agent/installations/new'
const UPDATE_OPTIONS = {remainingBudgetMs: 90_000}
const RECOVER_OPTIONS = {fingerprint: 'fp-1', runId: 'run-1'}
const READY = {
  kind: 'ready',
  change: 'unchanged',
  branch: 'main',
  sha: 'a'.repeat(40),
  checkedAt: '2026-01-01T00:00:00.000Z',
}

function makeCalls(authForRepo: ReturnType<typeof vi.fn>) {
  const appClient = {authForRepo} as unknown as AppClient
  const workspaceClient = {
    update: vi.fn().mockResolvedValue(ok(READY)),
    previewRecovery: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
    recover: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
  }
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const calls = createWorkspaceCalls({appClient, workspaceClient, logger})
  return {calls, workspaceClient, logger, authForRepo}
}

const NEVER = () => vi.fn().mockReturnValue(new Promise(() => {}))

describe('createWorkspaceCalls: a stalled authForRepo can never hold a workspace call', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('update settles at the mint bound, as a retryable failure, and never calls the workspace', async () => {
    // #given GitHub never answers the mint
    vi.useFakeTimers()
    const {calls, workspaceClient} = makeCalls(NEVER())

    // #when
    const pending = calls.update('acme', 'widget', UPDATE_OPTIONS)
    let settled = false
    const tracked = pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(INSTALLATION_TOKEN_MINT_TIMEOUT_MS - 1)
    const settledEarly = settled
    await vi.advanceTimersByTimeAsync(1)

    // #then
    expect(settledEarly).toBe(false)
    expect(await pending).toEqual(err({kind: 'network-error', cause: 'timeout'}))
    await tracked
    expect(workspaceClient.update).not.toHaveBeenCalled()
  })

  it('recover settles at the mint bound as token-unavailable and never calls the workspace', async () => {
    // #given
    vi.useFakeTimers()
    const {calls, workspaceClient} = makeCalls(NEVER())

    // #when
    const pending = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    await vi.advanceTimersByTimeAsync(INSTALLATION_TOKEN_MINT_TIMEOUT_MS)

    // #then
    expect(await pending).toEqual(err({kind: 'token-unavailable', cause: 'timeout'}))
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('a mint that succeeds only after the bound sends neither /update nor /recover', async () => {
    // #given
    vi.useFakeTimers()
    let resolveAuth: (value: unknown) => void = () => {}
    const authForRepo = vi.fn().mockImplementation(
      async () =>
        new Promise(resolve => {
          resolveAuth = resolve
        }),
    )
    const {calls, workspaceClient} = makeCalls(authForRepo)

    // #when both calls expire, then the late tokens arrive
    const update = calls.update('acme', 'widget', UPDATE_OPTIONS)
    await vi.advanceTimersByTimeAsync(INSTALLATION_TOKEN_MINT_TIMEOUT_MS)
    await update
    resolveAuth(ok({token: 'ghs_late'}))
    const recover = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    await vi.advanceTimersByTimeAsync(INSTALLATION_TOKEN_MINT_TIMEOUT_MS)
    await recover
    resolveAuth(ok({token: 'ghs_late'}))
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(workspaceClient.update).not.toHaveBeenCalled()
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('previewRecovery never mints, so a stalled authForRepo cannot affect it', async () => {
    // #given
    const {calls, workspaceClient, authForRepo} = makeCalls(NEVER())

    // #when
    const result = await calls.previewRecovery('acme', 'widget')

    // #then
    expect(result).toEqual(ok({kind: 'no-checkout'}))
    expect(authForRepo).not.toHaveBeenCalled()
    expect(workspaceClient.previewRecovery).toHaveBeenCalledExactlyOnceWith({owner: 'acme', repo: 'widget'})
  })
})

describe('createWorkspaceCalls: authForRepo results map to the failures run.ts already understands', () => {
  it.each([
    ['AppNotInstalledError', new AppNotInstalledError('acme', 'widget', INSTALL_URL), 401],
    ['InsufficientPermissionsError', new InsufficientPermissionsError(['contents'], INSTALL_URL), 401],
  ])('%s is the permanent 401 and keeps its class as the cause', async (cause, error, status) => {
    // #given
    const {calls, workspaceClient} = makeCalls(vi.fn().mockResolvedValue(err(error)))

    // #when
    const result = await calls.update('acme', 'widget', UPDATE_OPTIONS)

    // #then
    expect(result).toEqual(err({kind: 'http-error', status, cause}))
    expect(workspaceClient.update).not.toHaveBeenCalled()
  })

  it.each([
    ['AuthError', new AuthError('GitHub API returned 503: secret detail')],
    ['AuthTimeoutError', new AuthTimeoutError()],
  ])('%s is the retryable network-error, with the class as cause and never the message', async (cause, error) => {
    // #given
    const {calls, logger} = makeCalls(vi.fn().mockResolvedValue(err(error)))

    // #when
    const result = await calls.update('acme', 'widget', UPDATE_OPTIONS)

    // #then
    expect(result).toEqual(err({kind: 'network-error', cause}))
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret detail')
  })

  it('a thrown authForRepo is the retryable network-error with the class as cause', async () => {
    const {calls} = makeCalls(vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    expect(await calls.update('acme', 'widget', UPDATE_OPTIONS)).toEqual(
      err({kind: 'network-error', cause: 'TypeError'}),
    )
  })

  it('a minted token reaches /update and /recover', async () => {
    // #given
    const {calls, workspaceClient} = makeCalls(vi.fn().mockResolvedValue(ok({token: 'ghs_minted'})))

    // #when
    await calls.update('acme', 'widget', UPDATE_OPTIONS)
    await calls.recover('acme', 'widget', RECOVER_OPTIONS)

    // #then
    expect(workspaceClient.update).toHaveBeenCalledExactlyOnceWith(
      {owner: 'acme', repo: 'widget', token: 'ghs_minted'},
      UPDATE_OPTIONS,
    )
    expect(workspaceClient.recover).toHaveBeenCalledExactlyOnceWith({
      owner: 'acme',
      repo: 'widget',
      token: 'ghs_minted',
      ...RECOVER_OPTIONS,
    })
  })

  it('logs a mint failure before update (owner, repo, cause) through the injected logger', async () => {
    // #given
    const {calls, logger} = makeCalls(vi.fn().mockResolvedValue(err(new AuthError('x'))))

    // #when
    await calls.update('acme', 'widget', UPDATE_OPTIONS)

    // #then
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      {owner: 'acme', repo: 'widget', cause: 'AuthError'},
      'run: installation token mint failed before update',
    )
  })
})
