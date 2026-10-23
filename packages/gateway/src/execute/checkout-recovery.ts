/**
 * Automatic recovery of a dirty shared checkout (#1889), attempted at most once per run.
 *
 * When `update` refuses a checkout as `dirty` and the run still holds the repo lock, `run.ts` asks
 * this module to preserve-and-replace it through the same workspace routes the manual
 * `/fro-bot recover-checkout` flow uses: check the workspace is quiet, preview, then recover. The
 * result is a closed union that tells `run.ts` what it may SAY about the checkout afterwards:
 *
 * - `recovered`: the workspace confirmed the swap; the previous checkout is backup `backupId`.
 * - `declined`: the workspace guarantees nothing moved (or we never asked it to). The original dirty
 *   refusal still describes the checkout truthfully.
 * - `ambiguous`: something may have moved, or the answer is unknown. `run.ts` must re-observe with
 *   `update` and reply from that, never from the stale dirty refusal.
 *
 * When in doubt a result is `ambiguous`: that is always safe, because it costs one more `update`.
 * Both classifiers below are exhaustive switches with no `default`, so a new member of the workspace
 * unions is a `check-types` error here rather than a silent misclassification.
 *
 * Logs carry the run id, the repo slug, the outcome and its reason or backup id. Never a path: those
 * come from an agent-writable checkout.
 */

import type {Result} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {
  ExecuteRecoveryResult,
  ExecuteRecoveryWorkspaceError,
  PreviewRecoveryResult,
  PreviewRecoveryWorkspaceError,
  RetentionUsage,
} from '../workspace-api/types.js'
import type {RepoQuiescenceChecker} from './repo-quiescence.js'

/** `RunMentionDeps.previewRecovery`: mints the installation token itself, like `update`. */
export type PreviewRecoveryFn = (
  owner: string,
  repo: string,
) => Promise<Result<PreviewRecoveryResult, PreviewRecoveryWorkspaceError>>

/** `RunMentionDeps.recover`: mints the installation token itself and sends `runId` for attribution. */
export type RecoverFn = (
  owner: string,
  repo: string,
  options: {readonly fingerprint: string; readonly runId: string},
) => Promise<Result<ExecuteRecoveryResult, ExecuteRecoveryWorkspaceError>>

export interface CheckoutRecoveryDeps {
  readonly checkRepoQuiescence: RepoQuiescenceChecker
  readonly previewRecovery: PreviewRecoveryFn
  readonly recover: RecoverFn
  readonly logger: GatewayLogger
}

export interface AutoRecoverRequest {
  /** Canonical workspace owner/repo - what `update` was called with. */
  readonly owner: string
  readonly repo: string
  /** `owner/repo` as the run knows it; the quiescence check and the logs key on it. */
  readonly repoSlug: string
  readonly runId: string
  /** What is left of the run's wall-clock budget right now. */
  readonly remainingBudgetMs: number
  /** Worst-case cost of preview + recover + the follow-up update (`totalRecoveryCeilingMs`). */
  readonly requiredBudgetMs: number
}

/** Nothing moved: we never asked, or the workspace guarantees the checkout is as it was. */
export type RecoveryDeclineReason =
  | 'budget-insufficient'
  | 'workspace-busy'
  | 'workspace-unknown'
  | 'preview-unavailable'
  | 'preview-not-ok'
  | 'size-incomplete'
  | 'quota-exceeded'
  | 'insufficient-disk-space'
  | 'checkout-changed'
  | 'inspection-failed'
  | 'maintenance-hold'
  | 'journal-in-progress'
  | 'fetch-failed'
  | 'build-failed'

/** Something may have moved, or the result is unknown. */
export type RecoveryAmbiguousReason =
  | 'timeout'
  | 'transport-error'
  | 'unexpected-result'
  | 'quarantine-failed'
  | 'install-failed'
  | 'verification-failed'
  | 'termination-unconfirmed'

export type CheckoutRecoveryOutcome =
  | {readonly kind: 'recovered'; readonly backupId: string}
  | {readonly kind: 'declined'; readonly reason: 'quota-exceeded'; readonly usage: RetentionUsage}
  | {readonly kind: 'declined'; readonly reason: Exclude<RecoveryDeclineReason, 'quota-exceeded'>}
  | {readonly kind: 'ambiguous'; readonly reason: RecoveryAmbiguousReason}

type PreviewDecision =
  | {readonly kind: 'proceed'; readonly fingerprint: string}
  | {readonly kind: 'declined'; readonly reason: 'preview-unavailable' | 'preview-not-ok' | 'size-incomplete'}

/**
 * A preview is read-only on the workspace, so every non-proceed answer - including a transport
 * failure - means nothing moved. Only a complete measurement of a `ok` preview may proceed: the
 * quota and disk checks are only trustworthy on a complete size, and `recoverable-update` (an
 * interrupted-update journal) contradicts the `dirty` refusal that brought us here.
 */
function classifyPreview(result: Result<PreviewRecoveryResult, PreviewRecoveryWorkspaceError>): PreviewDecision {
  if (result.success === false) return {kind: 'declined', reason: 'preview-unavailable'}
  const data = result.data
  switch (data.kind) {
    case 'ok':
      return data.preview.sizeMeasurementComplete
        ? {kind: 'proceed', fingerprint: data.preview.fingerprint}
        : {kind: 'declined', reason: 'size-incomplete'}
    case 'no-checkout':
    case 'refused':
    case 'failed':
    case 'recoverable-update':
      return {kind: 'declined', reason: 'preview-not-ok'}
  }
}

function classifyRecoverFailure(
  reason: Extract<ExecuteRecoveryResult, {readonly kind: 'failed'}>['reason'],
): CheckoutRecoveryOutcome {
  switch (reason) {
    // Returned before any journal, staging or rename exists.
    case 'inspection-failed':
    case 'fetch-failed':
      return {kind: 'declined', reason}
    // Pre-quarantine: staging is removed and the journal rolled back; the checkout was never touched.
    case 'build-failed':
      return {kind: 'declined', reason}
    // From the `quarantining` journal onward the original may already be renamed away.
    case 'quarantine-failed':
    case 'install-failed':
    case 'verification-failed':
    case 'termination-unconfirmed':
      return {kind: 'ambiguous', reason}
  }
}

function classifyRecover(
  result: Result<ExecuteRecoveryResult, ExecuteRecoveryWorkspaceError>,
): CheckoutRecoveryOutcome {
  // The request may have reached the workspace before the transport failed, so none of these prove
  // that nothing moved.
  if (result.success === false) {
    return {kind: 'ambiguous', reason: result.error.kind === 'timeout' ? 'timeout' : 'transport-error'}
  }
  const data = result.data
  switch (data.kind) {
    case 'ok':
      return {kind: 'recovered', backupId: data.recoveryId}
    case 'refused':
      // Every refusal is decided before the first journal write.
      return data.reason === 'quota-exceeded'
        ? {kind: 'declined', reason: 'quota-exceeded', usage: data.usage}
        : {kind: 'declined', reason: data.reason}
    case 'failed':
      return classifyRecoverFailure(data.reason)
    // The workspace never answers `no-checkout` to a recover of a checkout it just previewed; if it
    // does, we do not know what state it describes.
    case 'no-checkout':
      return {kind: 'ambiguous', reason: 'unexpected-result'}
  }
}

function logOutcome(logger: GatewayLogger, request: AutoRecoverRequest, outcome: CheckoutRecoveryOutcome): void {
  const base = {repo: request.repoSlug, runId: request.runId, outcome: outcome.kind}
  logger.warn(
    outcome.kind === 'recovered' ? {...base, backupId: outcome.backupId} : {...base, reason: outcome.reason},
    outcome.kind === 'recovered'
      ? 'run: dirty checkout recovered automatically'
      : `run: automatic checkout recovery ${outcome.kind}`,
  )
}

/**
 * Runs the quiescence gate, preview and recover for one dirty refusal. Never throws: a throwing
 * dependency is classified by the step it broke (before recover: declined; recover itself: ambiguous).
 */
export async function tryAutoRecoverDirtyCheckout(
  deps: CheckoutRecoveryDeps,
  request: AutoRecoverRequest,
): Promise<CheckoutRecoveryOutcome> {
  const finish = (outcome: CheckoutRecoveryOutcome): CheckoutRecoveryOutcome => {
    logOutcome(deps.logger, request, outcome)
    return outcome
  }

  if (request.remainingBudgetMs < request.requiredBudgetMs) {
    return finish({kind: 'declined', reason: 'budget-insufficient'})
  }

  // Preparation is not wired to the operator cancel signal (deferred), so this signal never aborts;
  // the checker applies its own 4s timeout. A throwing checker is `unknown`: fail closed.
  let quiescence: Awaited<ReturnType<RepoQuiescenceChecker>> | undefined
  try {
    quiescence = await deps.checkRepoQuiescence({repo: request.repoSlug, signal: new AbortController().signal})
  } catch {
    quiescence = undefined
  }
  if (quiescence?.kind === 'busy') return finish({kind: 'declined', reason: 'workspace-busy'})
  if (quiescence?.kind !== 'clear') return finish({kind: 'declined', reason: 'workspace-unknown'})

  let preview: PreviewDecision
  try {
    preview = classifyPreview(await deps.previewRecovery(request.owner, request.repo))
  } catch {
    preview = {kind: 'declined', reason: 'preview-unavailable'}
  }
  if (preview.kind === 'declined') return finish({kind: 'declined', reason: preview.reason})

  // From here on the workspace may have acted, so a throw is ambiguous, not a decline.
  let outcome: CheckoutRecoveryOutcome
  try {
    outcome = classifyRecover(
      await deps.recover(request.owner, request.repo, {fingerprint: preview.fingerprint, runId: request.runId}),
    )
  } catch {
    outcome = {kind: 'ambiguous', reason: 'transport-error'}
  }
  return finish(outcome)
}
