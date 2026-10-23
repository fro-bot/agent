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

import {totalRecoveryCeilingMs} from '../workspace-api/client.js'
import {REPO_QUIESCENCE_TIMEOUT_MS} from './repo-quiescence.js'

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
 * What the run's own backup lookup found after an ambiguous outcome. `found`: the workspace did
 * complete the swap (the backup is attributed to this run id). `not-found`: no backup carries this
 * run id. `failed`: the lookup itself could not answer. Only `found` lets the reply name an id.
 */
export type BackupLookup =
  {readonly kind: 'found'; readonly backupId: string} | {readonly kind: 'not-found'} | {readonly kind: 'failed'}

export type CheckoutRecoveryOutcome =
  | {readonly kind: 'recovered'; readonly backupId: string}
  | {readonly kind: 'declined'; readonly reason: 'quota-exceeded'; readonly usage: RetentionUsage}
  | {readonly kind: 'declined'; readonly reason: Exclude<RecoveryDeclineReason, 'quota-exceeded'>}
  | {readonly kind: 'ambiguous'; readonly reason: RecoveryAmbiguousReason; readonly backup: BackupLookup}

/** What `classifyRecover` returns: an ambiguous outcome has not been looked up yet. */
type ClassifiedOutcome =
  | Exclude<CheckoutRecoveryOutcome, {readonly kind: 'ambiguous'}>
  | {readonly kind: 'ambiguous'; readonly reason: RecoveryAmbiguousReason}

/**
 * Worst-case wall-clock cost of one whole automatic-recovery attempt: the quiescence check, then every
 * workspace call (`totalRecoveryCeilingMs`: preview, recover with its dispose, the backup lookup, the
 * follow-up `update`), each at the ceiling the client is configured with. A run with less budget left
 * than this must not start one it could not finish.
 */
export function totalRecoveryBudgetMs(options: Parameters<typeof totalRecoveryCeilingMs>[0] = {}): number {
  return REPO_QUIESCENCE_TIMEOUT_MS + totalRecoveryCeilingMs(options)
}

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
): ClassifiedOutcome {
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

function classifyRecover(result: Result<ExecuteRecoveryResult, ExecuteRecoveryWorkspaceError>): ClassifiedOutcome {
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
  switch (outcome.kind) {
    case 'recovered':
      logger.warn({...base, backupId: outcome.backupId}, 'run: dirty checkout recovered automatically')
      return
    case 'declined':
      logger.warn({...base, reason: outcome.reason}, 'run: automatic checkout recovery declined')
      return
    case 'ambiguous':
      // The backup lookup rides on this one line: `found` adds the id, never a path.
      logger.warn(
        {
          ...base,
          reason: outcome.reason,
          lookup: outcome.backup.kind,
          ...(outcome.backup.kind === 'found' ? {backupId: outcome.backup.backupId} : {}),
        },
        'run: automatic checkout recovery ambiguous',
      )
  }
}

/**
 * Finds this run's backup after an ambiguous outcome. The recover request may have completed the swap
 * even though the caller never saw the answer, so the backup is looked up by the run id the workspace
 * recorded in its metadata. The lookup is bounded by the workspace client's own listBackups timeout;
 * any failure is `failed`, never an error, and a lookup can never turn an outcome into a decline.
 */
async function lookUpOwnBackup(deps: CheckoutRecoveryDeps, request: AutoRecoverRequest): Promise<BackupLookup> {
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
  let classified: ClassifiedOutcome
  try {
    classified = classifyRecover(
      await deps.recover(request.owner, request.repo, {fingerprint: preview.fingerprint, runId: request.runId}),
    )
  } catch {
    classified = {kind: 'ambiguous', reason: 'transport-error'}
  }
  if (classified.kind !== 'ambiguous') return finish(classified)
  return finish({...classified, backup: await lookUpOwnBackup(deps, request)})
}
