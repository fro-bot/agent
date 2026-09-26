/**
 * Reply text for every checkout-preparation outcome that ends a run before EXECUTING (refused,
 * failed, or a client-side timeout waiting on `/update`). One module so Unit 8 and every test
 * share the exact same strings, never duplicated inline.
 *
 * `checkout-substituted` is absent here: `run.ts` routes it through the existing
 * `RunCoreError('checkout-substituted', ...)` path, which has its own reply text.
 */

import type {UpdateFailed, UpdateRefused} from '../workspace-api/types.js'

import {formatBranchForReply} from './provenance.js'

/** Appended to every refusal/apply-interrupted reply except `maintenance-hold`. */
export const RECOVER_SUFFIX =
  'Nothing was discarded. Use the button below, or run `/fro-bot recover-checkout`, to preserve this checkout and install a fresh one.'

/** No response arrived from `/update` within its deadline; neither side knows what happened. */
export const CLIENT_TIMEOUT_REPLY =
  "The update didn't finish within its time budget, and I can't tell whether the checkout changed. The next run will check its state before doing anything."

/** A prior operation's subprocess termination could not be confirmed; the workspace holds this repo until it restarts. */
export const TERMINATION_UNCONFIRMED_REPLY =
  "This update couldn't be confirmed to have stopped, so I can't tell whether it changed the checkout. The workspace has put this repository on hold until it restarts; try again after that."

/** A prior operation may still be running; the workspace put this repo on hold until it restarts. Never gets `RECOVER_SUFFIX` - recovery can't safely run against unconfirmed subprocess state either. */
export const MAINTENANCE_HOLD_REPLY =
  'An earlier operation on this checkout may still be running, so the workspace has put this repository on hold. Restarting the workspace clears the hold; try again after that.'

/** The checkout has local commits beyond the default branch's tip with no divergence - nothing for a fast-forward to move to. */
const AHEAD_REPLY = "The checkout is ahead of the repository's default branch, so there's nothing to fast-forward."

const REFUSAL_REPLY_TEXT: Record<
  Exclude<UpdateRefused['reason'], 'checkout-substituted' | 'maintenance-hold'>,
  string
> = {
  dirty: "The checkout has uncommitted or untracked changes, so I can't update it safely.",
  detached: "The checkout isn't on a branch, so I can't update it safely.",
  'non-default-branch': '', // built per-instance below - needs the branch name
  diverged: "The checkout has local commits the remote doesn't have, so a fast-forward isn't possible.",
  ahead: AHEAD_REPLY,
  'unsupported-layout': "The checkout's git configuration or layout isn't one I can update safely.",
  'unsupported-config': "The checkout's git configuration or layout isn't one I can update safely.",
  obstructed:
    "An incoming file or directory would overwrite something already in the checkout, so I can't update it safely.",
  'submodule-initialized': "The checkout has an initialized submodule, which I don't support updating.",
  'operation-in-progress':
    "The checkout has a git operation in progress (merge, rebase, or similar), so I can't update it safely.",
  'needs-recovery': 'A previous update to this checkout was interrupted and needs recovery before I can run here.',
}

/**
 * Formats the reply for a `refused` outcome (never `checkout-substituted`, which `run.ts` routes
 * through the existing RunCoreError path). `maintenance-hold` returns its own text with no suffix;
 * every other reason gets the reply-table clause followed by `RECOVER_SUFFIX`.
 */
export function formatPreparationRefusedReply(
  result: Exclude<UpdateRefused, {readonly reason: 'checkout-substituted'}>,
): string {
  if (result.reason === 'maintenance-hold') return MAINTENANCE_HOLD_REPLY
  const clause =
    result.reason === 'non-default-branch'
      ? `The checkout is on \`${formatBranchForReply(result.branch)}\`, not the repository's default branch, so I can't update it safely.`
      : REFUSAL_REPLY_TEXT[result.reason]
  return `${clause}\n\n${RECOVER_SUFFIX}`
}

const TRANSIENT_REMOTE_REPLY =
  "I couldn't reach the repository's remote right now. This is usually temporary - try again shortly."
const PERMANENT_ACCESS_REPLY =
  "I don't have access to this repository's remote anymore. Check that the GitHub App still has access, then try again."
const APPLY_INTERRUPTED_REPLY =
  "The update started changing the checkout but didn't finish, so it needs recovery before I can run here."
const CHECK_OR_UPDATE_TRANSIENT_REPLY =
  "I couldn't check or update the checkout just now. This is usually temporary, so try again shortly."

/**
 * Formats the reply for a `failed` outcome. Maps each `UpdateFailureReason` explicitly rather than
 * trusting the `permanent` flag alone (a workspace-side classification bug there must not corrupt
 * user-facing wording) - reason wins if the two ever disagree. No `default` case: a new reason
 * added to the union fails `check-types` here until this switch is updated.
 */
export function formatPreparationFailedReply(result: UpdateFailed): string {
  switch (result.reason) {
    case 'fetch-auth-rejected':
    case 'fetch-rate-limited':
    case 'fetch-unreachable':
    case 'fetch-timeout':
    case 'fetch-failed':
    case 'remote-moved':
      return TRANSIENT_REMOTE_REPLY
    case 'fetch-not-found':
    case 'fetch-forbidden':
      return PERMANENT_ACCESS_REPLY
    case 'apply-failed':
      return result.mutationStarted === false
        ? CHECK_OR_UPDATE_TRANSIENT_REPLY
        : `${APPLY_INTERRUPTED_REPLY}\n\n${RECOVER_SUFFIX}`
    case 'inspection-failed':
      return CHECK_OR_UPDATE_TRANSIENT_REPLY
    case 'aborted':
      return CLIENT_TIMEOUT_REPLY
    case 'termination-unconfirmed':
      return TERMINATION_UNCONFIRMED_REPLY
  }
}
