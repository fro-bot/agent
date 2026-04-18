import type {BootstrapPhaseResult} from './bootstrap.js'
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

    expect(result).toBeNull()
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith({
      sessionId: null,
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      duration: expect.any(Number),
    })
    expect(vi.mocked(collectAgentContext)).not.toHaveBeenCalled()
    expect(vi.mocked(getRepositoryPermission)).not.toHaveBeenCalled()
  })
})
