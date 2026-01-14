import type {Logger} from '../logger.js'
import type {TriggerContext} from './types.js'

export interface IssueCommentResult {
  readonly handled: boolean
  readonly response: string | null
}

export async function handleIssueComment(_context: TriggerContext, _logger: Logger): Promise<IssueCommentResult> {
  // Stub: Full implementation in RFC-008 (Context Hydration)
  // This function will be called by main.ts after routeEvent() succeeds
  return {handled: false, response: null}
}
