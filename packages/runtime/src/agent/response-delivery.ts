import type {ResponseMode} from '../shared/types.js'

export type ResponseDelivery = 'file-convention' | 'model-gh' | 'none'
export type CredentialDisposition = 'withhold' | 'provision'

export interface ResponseDeliveryDecision {
  readonly delivery: ResponseDelivery
  readonly credential: CredentialDisposition
}

type EventClassification = 'affected' | 'autonomous' | 'deferred-or-unknown'

/**
 * Classifies a raw GitHub event name along the credential-sensitivity axis.
 *
 * `affected` triggers (pull_request, issue_comment, issues) require the
 * response to be delivered through the file-convention path instead of the
 * model calling `gh` directly, so the GitHub credential must be withheld from
 * the agent regardless of responseMode.
 *
 * `autonomous` triggers (workflow_dispatch, schedule) run without a human
 * driving the event and are safe to provision the credential to.
 *
 * Everything else — including the deferred surfaces
 * (pull_request_review_comment, discussion_comment) and any unrecognized
 * event name — defaults to `deferred-or-unknown`, which resolves to
 * `provision`/`model-gh`. This is a safe default: unknown event names keep
 * today's behavior (credential provisioned, model calls gh directly).
 */
function classifyEvent(eventName: string): EventClassification {
  switch (eventName) {
    case 'pull_request':
    case 'issue_comment':
    case 'issues':
      return 'affected'

    case 'workflow_dispatch':
    case 'schedule':
      return 'autonomous'

    default:
      return 'deferred-or-unknown'
  }
}

/**
 * Resolves the response delivery mechanism and credential disposition for a
 * GitHub event, independently, along two axes:
 *
 * - `credential` depends only on whether the trigger is one of the affected
 *   triggers (pull_request, issue_comment, issues); responseMode never
 *   changes this. Even when nothing will be delivered (responseMode 'none'),
 *   the credential stays withheld for affected triggers.
 * - `delivery` depends on responseMode first (a 'none' responseMode always
 *   yields 'none' delivery, regardless of trigger), then on whether the
 *   trigger is affected (file-convention) or not (model-gh).
 */
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`)
}

function resolveCredential(classification: EventClassification): CredentialDisposition {
  switch (classification) {
    case 'affected':
      return 'withhold'

    case 'autonomous':
    case 'deferred-or-unknown':
      return 'provision'

    default:
      return assertNever(classification)
  }
}

function resolveDelivery(classification: EventClassification): ResponseDelivery {
  switch (classification) {
    case 'affected':
      return 'file-convention'

    case 'autonomous':
    case 'deferred-or-unknown':
      return 'model-gh'

    default:
      return assertNever(classification)
  }
}

export function resolveResponseDelivery(eventName: string, responseMode: ResponseMode): ResponseDeliveryDecision {
  const classification = classifyEvent(eventName)
  const credential = resolveCredential(classification)

  if (responseMode === 'none') {
    return {delivery: 'none', credential}
  }

  return {delivery: resolveDelivery(classification), credential}
}
