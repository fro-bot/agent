import type {GitHubContext} from '../../services/github/types.js'
import {classifyEventType, normalizeEvent} from '../../services/github/context.js'

export function createMockGitHubContext(eventName: string, payload: unknown = {}): GitHubContext {
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
