import type {GitHubContext} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import {beforeEach, describe, expect, it} from 'vitest'
import {classifyEventType, normalizeEvent} from '../../services/github/context.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {routeEvent} from './router.js'

function createMockGitHubContext(eventName: string, payload: unknown = {}): GitHubContext {
  const eventType = classifyEventType(eventName)
  return {
    eventName,
    eventType,
    repo: {owner: 'owner', repo: 'repo'},
    ref: 'refs/heads/main',
    sha: 'abc123',
    runId: 12345,
    actor: 'actor',
    payload,
    event: normalizeEvent(eventType, payload),
  }
}

describe('pull_request ready_for_review routing', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('routes pull_request.ready_for_review event', () => {
    // #given a pull_request.ready_for_review event from an authorized author
    const payload = {
      action: 'ready_for_review',
      pull_request: {
        number: 99,
        title: 'feat: finish implementation',
        body: 'This PR is now ready for review',
        locked: false,
        draft: false,
        author_association: 'MEMBER',
      },
      sender: {login: 'contributor'},
    }
    const ghContext = createMockGitHubContext('pull_request', payload)

    // #when routing the event
    const result = routeEvent(ghContext, logger, {botLogin: 'fro-bot'})

    // #then it should process
    expect(result.shouldProcess).toBe(true)
    expect(result.context.eventType).toBe('pull_request')
    expect(result.context.action).toBe('ready_for_review')
  })
})
