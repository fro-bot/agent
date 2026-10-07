import type {BootstrapPhaseResult} from './bootstrap.js'
import * as core from '@actions/core'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {collectAgentContext} from '../../features/agent/index.js'
import {routeEvent} from '../../features/triggers/index.js'
import {getRepositoryPermission} from '../../services/github/api.js'
import {createClient, getBotLogin, parseGitHubContext} from '../../services/github/index.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {setActionOutputs} from '../config/outputs.js'
import {runRouting} from './routing.js'

vi.mock('@actions/core', () => ({
  saveState: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
}))

vi.mock('../../features/agent/index.js', () => ({
  collectAgentContext: vi.fn(),
}))

vi.mock('../../features/triggers/index.js', () => ({
  routeEvent: vi.fn(),
}))

vi.mock('../../services/github/api.js', () => ({
  getRepositoryPermission: vi.fn(),
}))

vi.mock('../../services/github/index.js', () => ({
  createClient: vi.fn(),
  getBotLogin: vi.fn(),
  parseGitHubContext: vi.fn(),
}))

vi.mock('../config/outputs.js', () => ({
  setActionOutputs: vi.fn(),
}))

describe('runRouting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits empty resolved-output-mode when routing skips processing', async () => {
    const bootstrap = {
      inputs: {
        githubToken: 'ghp_test123',
        prompt: 'test prompt',
      },
      logger: createMockLogger(),
      opencodeResult: {path: '/tmp/opencode', version: '1.0.0', didSetup: false},
    } as BootstrapPhaseResult

    vi.mocked(parseGitHubContext).mockReturnValue({
      eventName: 'push',
      eventType: 'unsupported',
      repo: {owner: 'fro-bot', repo: 'agent'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 123,
      actor: 'mrbrown',
      payload: {},
      event: {type: 'unsupported'},
    })
    vi.mocked(createClient).mockReturnValue({} as never)
    vi.mocked(getBotLogin).mockResolvedValue('fro-bot[bot]')
    vi.mocked(routeEvent).mockReturnValue({
      shouldProcess: false,
      skipReason: 'unsupported_event',
      skipMessage: 'Unsupported event',
      context: {
        eventType: 'unsupported',
        eventName: 'push',
        repo: {owner: 'fro-bot', repo: 'agent'},
        ref: 'refs/heads/main',
        sha: 'abc123',
        runId: 123,
        actor: 'mrbrown',
        action: null,
        author: null,
        target: null,
        commentBody: null,
        commentId: null,
        hasMention: false,
        command: null,
        isBotReviewRequested: false,
        raw: {
          eventName: 'push',
          eventType: 'unsupported',
          repo: {owner: 'fro-bot', repo: 'agent'},
          ref: 'refs/heads/main',
          sha: 'abc123',
          runId: 123,
          actor: 'mrbrown',
          payload: {},
          event: {type: 'unsupported'},
        },
      },
    })

    const result = await runRouting(bootstrap, 100)

    expect(result).toEqual({
      skipped: true,
      skipReason: 'unsupported_event',
      skipMessage: 'Unsupported event',
    })
    expect(vi.mocked(setActionOutputs)).not.toHaveBeenCalled()
    expect(vi.mocked(collectAgentContext)).not.toHaveBeenCalled()
    expect(vi.mocked(getRepositoryPermission)).not.toHaveBeenCalled()
  })

  it('threads the parsed reviewSkipLabel input into the TriggerConfig passed to routeEvent', async () => {
    // #given bootstrap inputs carrying a parsed reviewSkipLabel
    const bootstrap = {
      inputs: {
        githubToken: 'ghp_test123',
        prompt: 'test prompt',
        reviewSkipLabel: 'skip-agent-review',
      },
      logger: createMockLogger(),
      opencodeResult: {path: '/tmp/opencode', version: '1.0.0', didSetup: false},
    } as BootstrapPhaseResult

    vi.mocked(parseGitHubContext).mockReturnValue({
      eventName: 'pull_request',
      eventType: 'pull_request',
      repo: {owner: 'fro-bot', repo: 'agent'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 123,
      actor: 'mrbrown',
      payload: {},
      event: {type: 'pull_request', action: 'synchronize'} as never,
    })
    vi.mocked(createClient).mockReturnValue({} as never)
    vi.mocked(getBotLogin).mockResolvedValue('fro-bot[bot]')
    vi.mocked(routeEvent).mockReturnValue({
      shouldProcess: false,
      skipReason: 'review_skip_label',
      skipMessage: "Pull request has the opt-out label 'skip-agent-review'",
      context: {
        eventType: 'pull_request',
        eventName: 'pull_request',
        repo: {owner: 'fro-bot', repo: 'agent'},
        ref: 'refs/heads/main',
        sha: 'abc123',
        runId: 123,
        actor: 'mrbrown',
        action: 'synchronize',
        author: null,
        target: null,
        commentBody: null,
        commentId: null,
        hasMention: false,
        command: null,
        isBotReviewRequested: false,
        raw: {
          eventName: 'pull_request',
          eventType: 'pull_request',
          repo: {owner: 'fro-bot', repo: 'agent'},
          ref: 'refs/heads/main',
          sha: 'abc123',
          runId: 123,
          actor: 'mrbrown',
          payload: {},
          event: {type: 'pull_request', action: 'synchronize'},
        },
      },
    })

    const result = await runRouting(bootstrap, 100)

    // #then routeEvent receives the parsed reviewSkipLabel and the phase returns null
    // before collectAgentContext (no acknowledgement/token spend)
    expect(vi.mocked(routeEvent)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({reviewSkipLabel: 'skip-agent-review'}),
    )
    expect(result).toEqual({
      skipped: true,
      skipReason: 'review_skip_label',
      skipMessage: "Pull request has the opt-out label 'skip-agent-review'",
    })
    expect(vi.mocked(collectAgentContext)).not.toHaveBeenCalled()
  })

  it('emits exactly one notice carrying the skip reason and no other annotation', async () => {
    // #given routing declines an unauthorized pull request author
    const bootstrap = {
      inputs: {githubToken: 'ghp_test123', prompt: 'test prompt'},
      logger: createMockLogger(),
      opencodeResult: {path: '/tmp/opencode', version: '1.0.0', didSetup: false},
    } as BootstrapPhaseResult

    vi.mocked(parseGitHubContext).mockReturnValue({
      eventName: 'pull_request',
      eventType: 'pull_request',
      repo: {owner: 'fro-bot', repo: 'agent'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 123,
      actor: 'contrib',
      payload: {},
      event: {type: 'pull_request', action: 'opened'} as never,
    })
    vi.mocked(createClient).mockReturnValue({} as never)
    vi.mocked(getBotLogin).mockResolvedValue('fro-bot[bot]')
    vi.mocked(routeEvent).mockReturnValue({
      shouldProcess: false,
      skipReason: 'unauthorized_author',
      skipMessage: "Author association 'CONTRIBUTOR' is not authorized",
      context: {} as never,
    })

    // #when routing runs
    await runRouting(bootstrap, 100)

    // #then a single notice names the reason, with no warning or error annotation
    expect(vi.mocked(core.notice)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(core.notice)).toHaveBeenCalledWith(
      "Fro Bot skipped this event (unauthorized_author): Author association 'CONTRIBUTOR' is not authorized",
      expect.anything(),
    )
    expect(vi.mocked(core.warning)).not.toHaveBeenCalled()
    expect(vi.mocked(core.error)).not.toHaveBeenCalled()
  })

  it('still returns the skip when the notice cannot be emitted', async () => {
    // #given core.notice throws
    const bootstrap = {
      inputs: {githubToken: 'ghp_test123', prompt: 'test prompt'},
      logger: createMockLogger(),
      opencodeResult: {path: '/tmp/opencode', version: '1.0.0', didSetup: false},
    } as BootstrapPhaseResult

    vi.mocked(parseGitHubContext).mockReturnValue({
      eventName: 'push',
      eventType: 'unsupported',
      repo: {owner: 'fro-bot', repo: 'agent'},
      ref: 'refs/heads/main',
      sha: 'abc123',
      runId: 123,
      actor: 'mrbrown',
      payload: {},
      event: {type: 'unsupported'},
    })
    vi.mocked(createClient).mockReturnValue({} as never)
    vi.mocked(getBotLogin).mockResolvedValue('fro-bot[bot]')
    vi.mocked(routeEvent).mockReturnValue({
      shouldProcess: false,
      skipReason: 'unsupported_event',
      skipMessage: 'Unsupported event type: push',
      context: {} as never,
    })
    vi.mocked(core.notice).mockImplementationOnce(() => {
      throw new Error('annotation failed')
    })

    // #when routing runs
    const result = await runRouting(bootstrap, 100)

    // #then the skip is still reported to the caller
    expect(result).toEqual({
      skipped: true,
      skipReason: 'unsupported_event',
      skipMessage: 'Unsupported event type: push',
    })
  })
})
