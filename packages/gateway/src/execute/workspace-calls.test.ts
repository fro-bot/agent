import type {AppClient} from '../github/app-client.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {
  AppNotInstalledError,
  AuthError,
  AuthTimeoutError,
  INSTALLATION_TOKEN_MINT_TIMEOUT_MS,
  InsufficientPermissionsError,
} from '../github/app-client.js'
import {
  controllableDeadlines,
  createRealAppClient,
  installStalledGitHub,
  settleWithin,
  untilRequests,
} from '../github/test-helpers.js'
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

function makeStalled(options?: {readonly ignoreSignal?: boolean}) {
  const github = installStalledGitHub(options)
  const deadline = controllableDeadlines()
  return {github, deadline, ...makeCalls(vi.fn(createRealAppClient().authForRepo))}
}

// The REAL `authForRepo` over a stubbed `fetch`: the bound under test is the one `authForRepo` itself enforces,
// not a wrapper around it.
describe('createWorkspaceCalls: a stalled GitHub can never hold a workspace call', () => {
  it('update settles when the mint deadline fires, as a retryable failure, and never calls the workspace', async () => {
    // #given GitHub never answers the mint
    const {github, deadline, calls, workspaceClient} = makeStalled()

    // #when
    const pending = calls.update('acme', 'widget', UPDATE_OPTIONS)
    await untilRequests(github, 1)

    // #then it is still waiting while the deadline has not fired, and the deadline is the 30 s ceiling
    expect(deadline.spy).toHaveBeenCalledExactlyOnceWith(INSTALLATION_TOKEN_MINT_TIMEOUT_MS)
    expect(await settleWithin(pending, 50)).toBe('pending')

    // #when the deadline fires
    deadline.fire()
    const result = await settleWithin(pending)

    // #then
    expect(result).toEqual(err({kind: 'network-error', cause: 'timeout'}))
    expect(workspaceClient.update).not.toHaveBeenCalled()
  })

  it('recover settles when the mint deadline fires as token-unavailable and never calls the workspace', async () => {
    // #given
    const {github, deadline, calls, workspaceClient} = makeStalled()

    // #when
    const pending = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    await untilRequests(github, 1)
    expect(await settleWithin(pending, 50)).toBe('pending')
    deadline.fire()

    // #then
    expect(await settleWithin(pending)).toEqual(err({kind: 'token-unavailable', cause: 'timeout'}))
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('a transport that ignores the abort and answers only after the deadline sends neither /update nor /recover', async () => {
    // #given requests that do not honour their signal and are answered after both deadlines have fired
    const {github, deadline, calls, workspaceClient} = makeStalled({ignoreSignal: true})

    // #when both calls hit their deadline, then GitHub finally answers
    const update = calls.update('acme', 'widget', UPDATE_OPTIONS)
    await untilRequests(github, 1)
    deadline.fire(0)
    expect(await settleWithin(update)).toEqual(err({kind: 'network-error', cause: 'timeout'}))
    const recover = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    await vi.waitFor(() => expect(deadline.controllers).toHaveLength(2))
    deadline.fire(1)
    expect(await settleWithin(recover)).toEqual(err({kind: 'token-unavailable', cause: 'timeout'}))
    github.answerLate()
    await new Promise(resolve => setTimeout(resolve, 50))

    // #then the late tokens were never used
    expect(workspaceClient.update).not.toHaveBeenCalled()
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('previewRecovery never mints, so a stalled GitHub cannot affect it', async () => {
    // #given
    const {github, calls, workspaceClient} = makeStalled()

    // #when
    const result = await calls.previewRecovery('acme', 'widget')

    // #then
    expect(result).toEqual(ok({kind: 'no-checkout'}))
    expect(github.seen).toHaveLength(0)
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
    // The mint's own deadline is reported as "timeout" (the cause the diagnostics have always used for a stall).
    ['timeout', new AuthTimeoutError()],
  ])(
    '%s is the retryable network-error, with the class (or "timeout") as cause and never the message',
    async (cause, error) => {
      // #given
      const {calls, logger} = makeCalls(vi.fn().mockResolvedValue(err(error)))

      // #when
      const result = await calls.update('acme', 'widget', UPDATE_OPTIONS)

      // #then
      expect(result).toEqual(err({kind: 'network-error', cause}))
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret detail')
    },
  )

  it('a thrown authForRepo is the retryable network-error with the class as cause, never the message', async () => {
    const {calls, logger} = makeCalls(vi.fn().mockRejectedValue(new TypeError('ghs_secret_in_message')))
    expect(await calls.update('acme', 'widget', UPDATE_OPTIONS)).toEqual(
      err({kind: 'network-error', cause: 'TypeError'}),
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('ghs_secret_in_message')
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
