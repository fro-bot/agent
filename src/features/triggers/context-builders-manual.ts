import type {GitHubContext} from '../../services/github/types.js'
import type {TriggerContextData} from './context-builders-types.js'
import type {AuthorInfo, TriggerTarget} from './types.js'

export function buildWorkflowDispatchContextData(
  event: GitHubContext['event'],
  actor: string,
  promptInput: string | null,
): TriggerContextData {
  if (event.type !== 'workflow_dispatch') {
    throw new Error('Event type must be workflow_dispatch')
  }

  const effectivePrompt = (promptInput ?? event.inputs?.prompt ?? '').trim()
  const target: TriggerTarget = {
    kind: 'manual',
    number: 0,
    title: 'Manual workflow dispatch',
    body: effectivePrompt === '' ? null : effectivePrompt,
    locked: false,
  }
  const author: AuthorInfo = {
    login: actor,
    association: 'OWNER',
    isBot: false,
  }

  return {
    action: null,
    author,
    target,
    commentBody: effectivePrompt === '' ? null : effectivePrompt,
    commentId: null,
    hasMention: false,
    command: null,
  }
}

export function buildScheduleContextData(
  _event: GitHubContext['event'],
  actor: string,
  promptInput: string | null,
): TriggerContextData {
  const effectivePrompt = promptInput?.trim() ?? ''
  const target: TriggerTarget = {
    kind: 'manual',
    number: 0,
    title: 'Scheduled workflow',
    body: effectivePrompt === '' ? null : effectivePrompt,
    locked: false,
  }
  const author: AuthorInfo = {
    login: actor,
    association: 'OWNER',
    isBot: false,
  }

  return {
    action: null,
    author,
    target,
    commentBody: effectivePrompt === '' ? null : effectivePrompt,
    commentId: null,
    hasMention: false,
    command: null,
  }
}
