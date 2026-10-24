/**
 * Tests for ensureWorkspaceClone helper.
 *
 * Strict TDD: tests were written before the implementation.
 * All tests in this file must pass GREEN after ensure-clone.ts is implemented.
 */

import type {Result} from '@fro-bot/runtime'

import type {AppClient, AppClientAuthResult} from '../github/app-client.js'
import type {WorkspaceClient} from './client.js'
import type {EnsureCloneFailure} from './ensure-clone.js'
import type {CloneSuccess, CloneWorkspaceError} from './types.js'

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
import {workspaceRepoPath} from './client.js'
import {ensureWorkspaceClone} from './ensure-clone.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeAuthResult(token = 'ghs_testtoken'): AppClientAuthResult {
  // Use a minimal Octokit-compatible object — tests only need the token field.
  // Avoid `{} as unknown as Octokit` to keep the type honest.
  const minimalOctokit = {request: vi.fn(), hook: {before: vi.fn(), after: vi.fn(), error: vi.fn(), wrap: vi.fn()}}
  return {
    octokit: minimalOctokit as unknown as AppClientAuthResult['octokit'],
    installationId: 42,
    token,
  }
}

function makeAppClient(
  authResult: Result<AppClientAuthResult, AppNotInstalledError | InsufficientPermissionsError | AuthError> = ok(
    makeAuthResult(),
  ),
): AppClient {
  return {
    authForRepo: vi.fn().mockResolvedValue(authResult),
    authForWorkflowDispatch: vi.fn(),
    getRepoIdentity: vi.fn().mockResolvedValue(ok({databaseId: 1, nodeId: 'node-1'})),
    invalidateCache: vi.fn(),
  }
}

function makeWorkspaceClient(
  cloneResult: Result<CloneSuccess, CloneWorkspaceError> = ok({
    ok: true,
    path: workspaceRepoPath('testowner', 'testrepo'),
    commit: 'abc123',
  }),
): WorkspaceClient {
  return {
    clone: vi.fn().mockResolvedValue(cloneResult),
    readyz: vi.fn(),
    inspect: vi.fn(),
    update: vi.fn(),
    previewRecovery: vi.fn(),
    recover: vi.fn(),
    listBackups: vi.fn(),
    deleteBackup: vi.fn(),
  }
}

/**
 * Assert that a Result is a failure and return the typed error.
 * Eliminates vitest/no-conditional-expect by making the assertion unconditional.
 */
function assertFailure<T, E>(result: Result<T, E>): E {
  expect(result.success).toBe(false)
  if (result.success === false) {
    return result.error
  }
  // Unreachable after the expect above fails the test, but satisfies the type.
  throw new Error('assertFailure: result was not a failure')
}

// ---------------------------------------------------------------------------
// Happy path tests
// ---------------------------------------------------------------------------

// The REAL `authForRepo` over a stalled `fetch`: the bound is the one `authForRepo` enforces itself.
function makeStalledClone(options?: {readonly ignoreSignal?: boolean}) {
  const github = installStalledGitHub(options)
  const deadline = controllableDeadlines()
  const workspaceClient = makeWorkspaceClient()
  const logger = makeLogger()
  const run = ensureWorkspaceClone({
    owner: 'testowner',
    repo: 'testrepo',
    appClient: createRealAppClient(),
    workspaceClient,
    logger,
  })
  return {github, deadline, workspaceClient, logger, run}
}

describe('ensureWorkspaceClone', () => {
  describe('happy path: auth succeeds and clone succeeds', () => {
    it('returns the validated workspace path on successful clone', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const expectedPath = workspaceRepoPath(owner, repo)
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(ok({ok: true, path: expectedPath, commit: 'abc123'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      expect(result).toEqual(ok(expectedPath))
    })

    it('calls authForRepo with the correct owner and repo', async () => {
      // #given
      const owner = 'myorg'
      const repo = 'myrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(
        ok({ok: true, path: workspaceRepoPath(owner, repo), commit: 'def456'}),
      )
      const logger = makeLogger()

      // #when
      await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      expect(appClient.authForRepo).toHaveBeenCalledWith(owner, repo)
    })

    it('calls workspaceClient.clone with owner, repo, and the minted token', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const token = 'ghs_mintedtoken'
      const appClient = makeAppClient(ok(makeAuthResult(token)))
      const workspaceClient = makeWorkspaceClient(
        ok({ok: true, path: workspaceRepoPath(owner, repo), commit: 'abc123'}),
      )
      const logger = makeLogger()

      // #when
      await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      expect(workspaceClient.clone).toHaveBeenCalledWith({owner, repo, token})
    })
  })

  describe('happy path: auth succeeds and clone returns repo-exists', () => {
    it('returns workspaceRepoPath(owner, repo) when clone returns repo-exists', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'clone-error', code: 'repo-exists'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then — repo-exists is a successful recovery signal
      expect(result).toEqual(ok(workspaceRepoPath(owner, repo)))
    })

    it('does not log an error when clone returns repo-exists', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'clone-error', code: 'repo-exists'}))
      const logger = makeLogger()

      // #when
      await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      expect(logger.error).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Error path: auth failure
  // ---------------------------------------------------------------------------

  describe('error path: GitHub App auth fails', () => {
    it('returns auth-failure and does not call clone when authForRepo fails with AuthError', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient(err(new AuthError('token mint failed')))
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure.kind).toBe('auth-failure')
      expect(workspaceClient.clone).not.toHaveBeenCalled()
    })

    it('returns auth-failure with reason auth-error when authForRepo fails with AuthError', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient(err(new AuthError('token mint failed')))
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'auth-failure', reason: 'auth-error'})
    })

    it('returns auth-failure and does not call clone when authForRepo fails with AppNotInstalledError', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient(
        err(new AppNotInstalledError(owner, repo, 'https://github.com/apps/fro-bot-agent/installations/new')),
      )
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure.kind).toBe('auth-failure')
      expect(workspaceClient.clone).not.toHaveBeenCalled()
    })

    it('positive evidence — AppNotInstalledError classifies as reason "not-installed" (permanent, operator-side)', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient(
        err(new AppNotInstalledError(owner, repo, 'https://github.com/apps/fro-bot-agent/installations/new')),
      )
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'auth-failure', reason: 'not-installed'})
    })

    it('positive evidence — InsufficientPermissionsError classifies as reason "insufficient-permissions" (permanent, operator-side)', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient(
        err(
          new InsufficientPermissionsError(
            ['contents:read'],
            'https://github.com/apps/fro-bot-agent/installations/new',
          ),
        ),
      )
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'auth-failure', reason: 'insufficient-permissions'})
    })

    it('an AuthTimeoutError from the source deadline keeps the reason "timeout" the clone path always reported for a stall', async () => {
      // #given authForRepo now aborts its own requests at the deadline and returns this typed AuthError
      const appClient = makeAppClient(err(new AuthTimeoutError()))

      // #when
      const result = await ensureWorkspaceClone({
        owner: 'testowner',
        repo: 'testrepo',
        appClient,
        workspaceClient: makeWorkspaceClient(),
        logger: makeLogger(),
      })

      // #then
      expect(assertFailure(result)).toMatchObject({kind: 'auth-failure', reason: 'timeout'})
    })

    it('no positive evidence — a plain AuthError (e.g. discovery 5xx/network/rate-limit) stays reason "auth-error" (transient default)', async () => {
      // #given — simulates a discovery-stage AuthError that is NOT AppNotInstalledError/
      // InsufficientPermissionsError (e.g. a GitHub 5xx or network failure during discovery)
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient(err(new AuthError('GitHub API returned 503')))
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then — no positive evidence of permanence → defaults to transient, never to permanent
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'auth-failure', reason: 'auth-error'})
    })
  })

  // ---------------------------------------------------------------------------
  // Error path: clone timeout/network/HTTP/parse failure — structured details
  // ---------------------------------------------------------------------------

  describe('error path: clone timeout/network/HTTP/parse failure', () => {
    it('returns workspace-failure with workspaceKind timeout when clone returns timeout', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'timeout'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'timeout'})
    })

    it('returns workspace-failure with workspaceKind network-error when clone returns network-error', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'network-error'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'network-error'})
    })

    it('returns workspace-failure with workspaceKind http-error and status when clone returns http-error', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'http-error', status: 503}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'http-error', status: 503})
    })

    it('returns workspace-failure with workspaceKind parse-error when clone returns parse-error', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'parse-error'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'parse-error'})
    })

    it('returns workspace-failure with workspaceKind clone-error and code when clone returns a non-repo-exists clone-error', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'clone-error', code: 'clone-failed'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'clone-error', code: 'clone-failed'})
    })

    it('preserves clone-error code for ops/automation (enospc)', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'clone-error', code: 'enospc'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'clone-error', code: 'enospc'})
    })
  })

  // ---------------------------------------------------------------------------
  // Error path: clone response mismatch — structured detail
  // ---------------------------------------------------------------------------

  describe('error path: clone response mismatch', () => {
    it('returns workspace-failure with workspaceKind response-mismatch and does not synthesize a path', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'response-mismatch'}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then — must fail closed; no path synthesis from bad response
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'response-mismatch'})
    })

    it('logs an error on response-mismatch (security signal)', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'response-mismatch'}))
      const logger = makeLogger()

      // #when
      await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      expect(logger.error).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Unexpected error path
  // ---------------------------------------------------------------------------

  describe('error path: unexpected thrown error', () => {
    it('returns unexpected-error when authForRepo throws synchronously', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient: AppClient = {
        authForRepo: vi.fn().mockRejectedValue(new Error('unexpected crash')),
        authForWorkflowDispatch: vi.fn(),
        getRepoIdentity: vi.fn().mockResolvedValue(ok({databaseId: 1, nodeId: 'node-1'})),
        invalidateCache: vi.fn(),
      }
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then
      const failure = assertFailure(result)
      expect(failure.kind).toBe('unexpected-error')
      expect(workspaceClient.clone).not.toHaveBeenCalled()
    })

    it('unexpected-error carries no raw message (stays coarse)', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient: AppClient = {
        authForRepo: vi.fn().mockRejectedValue(new Error('sensitive internal detail')),
        authForWorkflowDispatch: vi.fn(),
        getRepoIdentity: vi.fn().mockResolvedValue(ok({databaseId: 1, nodeId: 'node-1'})),
        invalidateCache: vi.fn(),
      }
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then — no raw message on the returned error
      const failure = assertFailure(result)
      expect(failure.kind).toBe('unexpected-error')
      // The error object must not carry any message property
      expect(Object.keys(failure)).toEqual(['kind'])
    })
  })

  // ---------------------------------------------------------------------------
  // Auth timeout path
  // ---------------------------------------------------------------------------

  describe('error path: auth timeout', () => {
    it('returns auth-failure with reason timeout when GitHub never answers and the mint deadline fires', async () => {
      // #given GitHub never answers
      const {github, deadline, workspaceClient, logger, run} = makeStalledClone()
      await untilRequests(github, 1)

      // #then it is still waiting before the deadline, and the deadline is the 30 s source ceiling
      expect(deadline.spy).toHaveBeenCalledExactlyOnceWith(INSTALLATION_TOKEN_MINT_TIMEOUT_MS)
      expect(await settleWithin(run, 50)).toBe('pending')

      // #when the deadline fires
      deadline.fire()
      const result = await settleWithin(run)

      // #then it is the same auth-failure the clone path has always reported for a stall, nothing was cloned,
      // and the warning names the class and the reason, never a message
      expect(result).not.toBe('pending')
      if (result === 'pending') return
      expect(assertFailure(result)).toEqual({kind: 'auth-failure', reason: 'timeout'})
      expect(workspaceClient.clone).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith('ensure-clone: app auth failed', {
        owner: 'testowner',
        repo: 'testrepo',
        errorKind: 'AuthTimeoutError',
        reason: 'timeout',
      })
    })

    it('a transport that ignores the abort and answers only after the deadline never clones', async () => {
      // #given requests that do not honour their signal
      const {github, deadline, workspaceClient, run} = makeStalledClone({ignoreSignal: true})
      await untilRequests(github, 1)

      // #when the deadline fires, then GitHub finally answers
      deadline.fire()
      const result = await settleWithin(run)
      github.answerLate()
      await new Promise(resolve => setTimeout(resolve, 50))

      // #then the call ended at the deadline and the late token was never used
      expect(result).not.toBe('pending')
      if (result === 'pending') return
      expect(assertFailure(result)).toEqual({kind: 'auth-failure', reason: 'timeout'})
      expect(workspaceClient.clone).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Type-level: EnsureCloneFailure discriminated union
  // ---------------------------------------------------------------------------

  describe('EnsureCloneFailure type coverage', () => {
    it('failure result carries the expected kind discriminant', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient(err(new AuthError('fail')))
      const workspaceClient = makeWorkspaceClient()
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then — TypeScript discriminated union narrows correctly
      const failure = assertFailure(result)
      const typedFailure: EnsureCloneFailure = failure
      // Runtime assertion: kind must be one of the three valid discriminants.
      expect(typedFailure.kind).toMatch(/^(auth-failure|workspace-failure|unexpected-error)$/)
      // Exhaustive compile-time check — the default branch is unreachable if the union is complete.
      const assertExhaustive = (f: EnsureCloneFailure): void => {
        switch (f.kind) {
          case 'auth-failure':
          case 'workspace-failure':
          case 'unexpected-error':
            break
          default: {
            const exhaustiveCheck: never = f
            throw new Error(`Unhandled failure kind: ${JSON.stringify(exhaustiveCheck)}`)
          }
        }
      }
      assertExhaustive(typedFailure)
    })

    it('workspace-failure carries workspaceKind for ops/automation', async () => {
      // #given
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'http-error', status: 502}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then — workspace-failure exposes workspaceKind and status for structured ops/automation use
      const failure = assertFailure(result)
      expect(failure).toMatchObject({kind: 'workspace-failure', workspaceKind: 'http-error', status: 502})
    })

    it('callers can reply generically using only error.kind (coarse Discord reply still works)', async () => {
      // #given — simulate a caller that only reads error.kind
      const owner = 'testowner'
      const repo = 'testrepo'
      const appClient = makeAppClient()
      const workspaceClient = makeWorkspaceClient(err({kind: 'http-error', status: 503}))
      const logger = makeLogger()

      // #when
      const result = await ensureWorkspaceClone({owner, repo, appClient, workspaceClient, logger})

      // #then — kind alone is sufficient for a coarse reply
      const failure = assertFailure(result)
      // This is the only field a Discord reply handler needs to read
      const replyMessage =
        failure.kind === 'auth-failure'
          ? 'workspace auth failed'
          : failure.kind === 'workspace-failure'
            ? 'workspace unavailable'
            : 'unexpected error'
      expect(replyMessage).toBe('workspace unavailable')
    })
  })
})
