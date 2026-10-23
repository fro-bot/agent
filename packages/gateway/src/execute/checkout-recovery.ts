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
  ListBackupsResult,
  ListBackupsWorkspaceError,
  PreviewRecoveryResult,
  PreviewRecoveryWorkspaceError,
  RetentionUsage,
} from '../workspace-api/types.js'
import type {RepoQuiescenceChecker} from './repo-quiescence.js'

// Re-exported: the pure budget sum lives in recovery-budget.ts so config.ts can use it without this module's graph.
export {totalRecoveryBudgetMs} from './recovery-budget.js'

/** `RunMentionDeps.previewRecovery`: mints the installation token itself, like `update`. */
export type PreviewRecoveryFn = (
  owner: string,
  repo: string,
) => Promise<Result<PreviewRecoveryResult, PreviewRecoveryWorkspaceError>>

/**
 * The installation token could not be minted in time, so `/recover` was never sent. Distinct from every
 * workspace transport error: those mean a request may have reached the workspace, this means none did.
 */
export interface RecoverTokenUnavailable {
  readonly kind: 'token-unavailable'
}

/**
 * `RunMentionDeps.recover`: mints the installation token itself (bounded by
 * `RECOVERY_TOKEN_MINT_TIMEOUT_MS`) and sends `runId` for attribution.
 */
export type RecoverFn = (
  owner: string,
  repo: string,
  options: {readonly fingerprint: string; readonly runId: string},
) => Promise<Result<ExecuteRecoveryResult, ExecuteRecoveryWorkspaceError | RecoverTokenUnavailable>>

/** `RunMentionDeps.listBackups`: bounded by the workspace client's own `listBackupsTimeoutMs`. */
export type ListBackupsFn = (
  owner: string,
  repo: string,
) => Promise<Result<ListBackupsResult, ListBackupsWorkspaceError>>

export interface CheckoutRecoveryDeps {
  readonly checkRepoQuiescence: RepoQuiescenceChecker
  readonly previewRecovery: PreviewRecoveryFn
  readonly recover: RecoverFn
  readonly listBackups: ListBackupsFn
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
  /** Worst-case cost of the whole attempt (`totalRecoveryBudgetMs`). */
  readonly requiredBudgetMs: number
}

/** Nothing moved: we never asked, or the workspace guarantees the checkout is as it was. */
export type RecoveryDeclineReason =
  | 'budget-insufficient'
  | 'token-unavailable'
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
  | 'rollback-failed'
  | 'transport-error'
  | 'unexpected-result'
  | 'quarantine-failed'
  | 'install-failed'
  | 'verification-failed'
  | 'termination-unconfirmed'

/**
 * What the run's own backup lookup found after an ambiguous outcome (`settleAmbiguousRecovery`).
 * `found`: a backup is attributed to this run id. `not-found`: none carries this run id. `failed`:
 * the lookup itself could not answer. Only `found` lets a reply name an id.
 */
export type BackupLookup =
  {readonly kind: 'found'; readonly backupId: string} | {readonly kind: 'not-found'} | {readonly kind: 'failed'}

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
    // The rollback of a pre-quarantine failure could not be confirmed: a `building` journal (and
    // possibly staging) is left behind. The original is untouched, but this is not a clean decline;
    // the follow-up `update` reports `needs-recovery` for it.
    case 'rollback-failed':
    // From the `quarantining` journal onward the original may already be renamed away.
    case 'quarantine-failed':
    case 'install-failed':
    case 'verification-failed':
    case 'termination-unconfirmed':
      return {kind: 'ambiguous', reason}
  }
}

function classifyRecover(
  result: Result<ExecuteRecoveryResult, ExecuteRecoveryWorkspaceError | RecoverTokenUnavailable>,
): CheckoutRecoveryOutcome {
  if (result.success === false && result.error.kind === 'token-unavailable') {
    // The mint failed or timed out BEFORE `/recover` was sent: the workspace was never asked to do anything.
    return {kind: 'declined', reason: 'token-unavailable'}
  }
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
  // An ambiguous outcome is logged by `settleAmbiguousRecovery`, once the backup lookup (which rides on
  // that one line) is done.
  if (outcome.kind === 'recovered') {
    logger.warn({...base, backupId: outcome.backupId}, 'run: dirty checkout recovered automatically')
  } else if (outcome.kind === 'declined') {
    logger.warn({...base, reason: outcome.reason}, 'run: automatic checkout recovery declined')
  }
}

/**
 * Finds this run's backup and writes the one warning an ambiguous outcome gets. Call it AFTER the
 * follow-up `update` has returned: the recover request may have completed the swap even though the
 * caller never saw the answer, and `listBackups` takes no repo lock, so a lookup made while the swap
 * is still renaming can wrongly come back empty. The follow-up `update` queues behind the workspace's
 * per-repo mutex, so once it has answered the swap is over and the backup is visible.
 *
 * The backup is matched by the run id the workspace recorded in its metadata (and listed for this
 * owner/repo only), so another run's backup can never be named. The lookup is bounded by the workspace
 * client's own `listBackupsTimeoutMs`; any failure is `failed`, never an error, and the result only
 * ever adds a backup id to a reply - it cannot turn an outcome into a decline.
 */
export async function settleAmbiguousRecovery(
  deps: Pick<CheckoutRecoveryDeps, 'listBackups' | 'logger'>,
  request: AutoRecoverRequest,
  reason: RecoveryAmbiguousReason,
): Promise<BackupLookup> {
  const lookup = await lookUpOwnBackup(deps, request)
  deps.logger.warn(
    {
      repo: request.repoSlug,
      runId: request.runId,
      outcome: 'ambiguous',
      reason,
      lookup: lookup.kind,
      ...(lookup.kind === 'found' ? {backupId: lookup.backupId} : {}),
    },
    'run: automatic checkout recovery ambiguous',
  )
  return lookup
}

async function lookUpOwnBackup(
  deps: Pick<CheckoutRecoveryDeps, 'listBackups'>,
  request: AutoRecoverRequest,
): Promise<BackupLookup> {
  try {
    const listed = await deps.listBackups(request.owner, request.repo)
    if (listed.success === false || listed.data.kind !== 'ok') return {kind: 'failed'}
    const mine = listed.data.backups
      .filter(entry => entry.runId === request.runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const newest = mine[0]
    return newest === undefined ? {kind: 'not-found'} : {kind: 'found', backupId: newest.id}
  } catch {
    return {kind: 'failed'}
  }
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
  // the checker applies its own timeout (`REPO_QUIESCENCE_TIMEOUT_MS`). A throwing checker is
  // `unknown`: fail closed.
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
  let classified: CheckoutRecoveryOutcome
  try {
    classified = classifyRecover(
      await deps.recover(request.owner, request.repo, {fingerprint: preview.fingerprint, runId: request.runId}),
    )
  } catch {
    classified = {kind: 'ambiguous', reason: 'transport-error'}
  }
  return finish(classified)
}
