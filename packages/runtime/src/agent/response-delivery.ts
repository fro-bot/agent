import type {ResponseMode} from '../shared/types.js'

export type ResponseDelivery = 'file-convention' | 'model-gh' | 'none'
export type CredentialDisposition = 'withhold' | 'provision'

export interface ResponseDeliveryDecision {
  readonly delivery: ResponseDelivery
  readonly credential: CredentialDisposition
}

/**
 * Only `schedule` and `workflow_dispatch` provision the GitHub credential: the model there reads text the caller wrote
 * or scheduled. Every other raw event name, known or not, reads text anyone can write, so the credential is withheld
 * from the model and the reply is delivered through the response file. The default denies; a new or unrecognized event
 * name withholds.
 *
 * Withholding keeps the token out of the agent's env and gh config; on its own it is not an OS boundary, since the
 * agent can read the action's environ on Linux. The `isolate-agent` input runs the agent as a separate user to provide
 * one (#2135).
 */
function provisionsCredential(eventName: string): boolean {
  switch (eventName) {
    case 'schedule':
    case 'workflow_dispatch':
      return true

    default:
      return false
  }
}

/**
 * Resolves the credential disposition and the response delivery mechanism for a raw GitHub event name.
 *
 * - `credential` depends only on the event name; `responseMode` never changes it, so a withheld trigger stays withheld
 *   when nothing will be delivered.
 * - `delivery` is `none` whenever `responseMode` is `none`; otherwise `model-gh` when the credential is provisioned and
 *   `file-convention` when it is withheld.
 */
export function resolveResponseDelivery(eventName: string, responseMode: ResponseMode): ResponseDeliveryDecision {
  const credential: CredentialDisposition = provisionsCredential(eventName) ? 'provision' : 'withhold'

  if (responseMode === 'none') {
    return {delivery: 'none', credential}
  }

  return {delivery: credential === 'provision' ? 'model-gh' : 'file-convention', credential}
}
