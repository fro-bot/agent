import type {Octokit} from '@octokit/core'
import type {AppClient} from './app-client.js'

import {ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'

import {AppNotInstalledError, InsufficientPermissionsError} from './app-client.js'
import {createWorkflowDispatcher} from './dispatch.js'

const INSTALL_URL = 'https://github.com/apps/fro-bot-agent/installations/new'

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeAppClient(request: ReturnType<typeof vi.fn>): AppClient {
  return {
    authForRepo: vi.fn(),
    authForWorkflowDispatch: vi
      .fn()
      .mockResolvedValue(ok({octokit: {request} as unknown as Octokit, installationId: 99, token: 'ghs-test-token'})),
    getRepoIdentity: vi.fn(),
    invalidateCache: vi.fn(),
  }
}

function makeRepoResponse(defaultBranch = 'main') {
  return {status: 200, data: {default_branch: defaultBranch}}
}

function makeWorkflowResponse() {
  return {status: 200, data: {workflow_run: {id: 1234, html_url: 'https://github.com/acme/widget/actions/runs/1234'}}}
}

interface RequestOptions {
  readonly request?: {readonly signal?: AbortSignal}
}

function makeAbortedTimeout(): {readonly signal: AbortSignal; readonly restore: () => void} {
  const controller = new AbortController()
  controller.abort(new Error('workflow dispatch timeout'))
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  return {signal: controller.signal, restore: () => timeoutSpy.mockRestore()}
}

describe('createWorkflowDispatcher', () => {
  it('returns accepted with the run link and dispatches the resolved default branch', async () => {
    // #given — repository metadata and a current workflow-run response
    const request = vi
      .fn()
      .mockResolvedValueOnce(makeRepoResponse('trunk'))
      .mockResolvedValueOnce(makeWorkflowResponse())
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run the checks')

    // #then
    expect(result).toEqual({
      outcome: 'accepted',
      owner: 'acme',
      repo: 'widget',
      runId: 1234,
      runUrl: 'https://github.com/acme/widget/actions/runs/1234',
    })
    expect(request).toHaveBeenNthCalledWith(
      1,
      'GET /repos/{owner}/{repo}',
      expect.objectContaining({
        owner: 'acme',
        repo: 'widget',
        headers: {'X-GitHub-Api-Version': '2026-03-10'},
      }),
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
      expect.objectContaining({
        owner: 'acme',
        repo: 'widget',
        workflow_id: '.github/workflows/fro-bot.yaml',
        ref: 'trunk',
        return_run_details: true,
        inputs: {prompt: 'run the checks'},
        headers: {'X-GitHub-Api-Version': '2026-03-10'},
      }),
    )
    const dispatchOptions = request.mock.calls[1]?.[1] as {
      readonly inputs: Record<string, string>
      readonly return_run_details: boolean
    }
    expect(dispatchOptions.return_run_details).toBe(true)
    expect(dispatchOptions.inputs).toEqual({prompt: 'run the checks'})
  })

  it('returns accepted without run details when GitHub accepts with a 204 empty response', async () => {
    // #given — GitHub accepts the dispatch but returns no response body
    const request = vi.fn().mockResolvedValueOnce(makeRepoResponse()).mockResolvedValueOnce({status: 204})
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then — acceptance is established by the 2xx status, not response details
    expect(result).toEqual({outcome: 'accepted', owner: 'acme', repo: 'widget'})
  })

  it('returns invalid-task without making a GitHub request for whitespace-only task text', async () => {
    // #given
    const request = vi.fn()
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', '  \n\t  ')

    // #then
    expect(result).toEqual({outcome: 'invalid-task'})
    expect(request).not.toHaveBeenCalled()
  })

  it('returns repo-not-found when repository metadata is not found', async () => {
    // #given
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), {status: 404}))
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'missing', 'run it')

    // #then
    expect(result).toEqual({outcome: 'repo-not-found', owner: 'acme', repo: 'missing'})
  })

  it('returns github-unavailable when a successful repository response has malformed default-branch metadata', async () => {
    // #given — GitHub returned 200 but violated the expected repository response shape
    const request = vi.fn().mockResolvedValue({status: 200, data: {default_branch: 42}})
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then — malformed metadata is not reported as a missing repository
    expect(result).toEqual({outcome: 'github-unavailable', owner: 'acme', repo: 'widget'})
  })

  it('returns workflow-not-found when the fixed workflow is absent', async () => {
    // #given
    const request = vi
      .fn()
      .mockResolvedValueOnce(makeRepoResponse())
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), {status: 404}))
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then
    expect(result).toEqual({outcome: 'workflow-not-found', owner: 'acme', repo: 'widget'})
  })

  it('returns github-unavailable when default-branch lookup is aborted', async () => {
    // #given — the repository lookup receives an already-aborted timeout signal
    const timeout = makeAbortedTimeout()
    const request = vi.fn().mockImplementation(async (_route: string, options: RequestOptions) => {
      if (options.request?.signal !== timeout.signal) return Promise.reject(new Error('missing timeout signal'))
      return Promise.reject(timeout.signal.reason)
    })
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then
    expect(result).toEqual({outcome: 'github-unavailable', owner: 'acme', repo: 'widget'})
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}',
      expect.objectContaining({request: {signal: timeout.signal}}),
    )
    timeout.restore()
  })

  it('returns github-unavailable when workflow dispatch POST is aborted', async () => {
    // #given — repository lookup succeeds but the dispatch POST receives an aborted timeout signal
    const timeout = makeAbortedTimeout()
    const request = vi.fn().mockImplementation(async (route: string, options: RequestOptions) => {
      if (route.startsWith('GET ')) return Promise.resolve(makeRepoResponse())
      if (options.request?.signal !== timeout.signal) return Promise.reject(new Error('missing timeout signal'))
      return Promise.reject(timeout.signal.reason)
    })
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then
    expect(result).toEqual({outcome: 'github-unavailable', owner: 'acme', repo: 'widget'})
    expect(request).toHaveBeenNthCalledWith(
      2,
      'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
      expect.objectContaining({request: {signal: timeout.signal}}),
    )
    timeout.restore()
  })

  it('returns app-not-installed with the install URL', async () => {
    // #given
    const appClient = makeAppClient(vi.fn())
    vi.mocked(appClient.authForWorkflowDispatch).mockResolvedValueOnce(
      Object.assign({success: false as const}, {error: new AppNotInstalledError('acme', 'widget', INSTALL_URL)}),
    )
    const dispatch = createWorkflowDispatcher({appClient, logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then
    expect(result).toEqual({outcome: 'app-not-installed', owner: 'acme', repo: 'widget', installUrl: INSTALL_URL})
  })

  it('returns missing-actions-permission with the install URL', async () => {
    // #given
    const appClient = makeAppClient(vi.fn())
    vi.mocked(appClient.authForWorkflowDispatch).mockResolvedValueOnce(
      Object.assign(
        {success: false as const},
        {error: new InsufficientPermissionsError(['actions: write'], INSTALL_URL)},
      ),
    )
    const dispatch = createWorkflowDispatcher({appClient, logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then
    expect(result).toEqual({
      outcome: 'missing-actions-permission',
      owner: 'acme',
      repo: 'widget',
      installUrl: INSTALL_URL,
    })
  })

  it('returns missing-permissions with the install URL for non-actions permission failures', async () => {
    // #given — the App lacks a deterministic non-actions permission
    const appClient = makeAppClient(vi.fn())
    vi.mocked(appClient.authForWorkflowDispatch).mockResolvedValueOnce(
      Object.assign(
        {success: false as const},
        {error: new InsufficientPermissionsError(['contents: read'], INSTALL_URL)},
      ),
    )
    const dispatch = createWorkflowDispatcher({appClient, logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then — configuration failure is actionable, not a transient outage
    expect(result).toEqual({
      outcome: 'missing-permissions',
      owner: 'acme',
      repo: 'widget',
      missingPermissions: ['contents: read'],
      installUrl: INSTALL_URL,
    })
  })

  it('returns github-unavailable for GitHub 5xx responses', async () => {
    // #given
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('GitHub unavailable'), {status: 503}))
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then
    expect(result).toEqual({outcome: 'github-unavailable', owner: 'acme', repo: 'widget'})
  })

  it('returns dispatch-rejected for a non-success dispatch response', async () => {
    // #given
    const request = vi.fn().mockResolvedValueOnce(makeRepoResponse()).mockResolvedValueOnce({status: 400, data: {}})
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then
    expect(result).toEqual({outcome: 'dispatch-rejected', owner: 'acme', repo: 'widget'})
  })

  it('returns accepted without run details for a malformed workflow_run response', async () => {
    // #given
    const request = vi.fn().mockResolvedValueOnce(makeRepoResponse()).mockResolvedValueOnce({status: 200, data: {}})
    const dispatch = createWorkflowDispatcher({appClient: makeAppClient(request), logger: makeLogger()})

    // #when
    const result = await dispatch('acme', 'widget', 'run it')

    // #then — a successful status still establishes acceptance
    expect(result).toEqual({outcome: 'accepted', owner: 'acme', repo: 'widget'})
  })
})
