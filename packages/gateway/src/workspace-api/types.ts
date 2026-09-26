/**
 * Request/response types for the workspace-agent HTTP service.
 *
 * These types are wire-compatible with `apps/workspace-agent/src/types.ts`. Some are
 * intentionally narrower (e.g. the `/readyz` shapes below are split into a discriminated
 * union here for stricter consumer-side checking). The gateway MUST import from this file —
 * never from the workspace-agent package directly.
 *
 * SECURITY: `repoPath` is NOT in CloneRequest. The agent derives the path internally.
 * The caller never controls where the repo is cloned.
 */

/** POST /clone request body. */
export interface CloneRequest {
  readonly owner: string
  readonly repo: string
  /** Installation access token (ghs_*). Never logged, never persisted. */
  readonly token: string
}

/** POST /clone success response. */
export interface CloneSuccess {
  readonly ok: true
  /** Absolute path inside the workspace container, e.g. /workspace/repos/fro-bot/agent */
  readonly path: string
  /** HEAD SHA after clone. */
  readonly commit: string
}

/** POST /clone error response. */
export interface CloneFailure {
  readonly ok: false
  readonly error: CloneErrorCode
  /** Optional machine-readable sub-code (e.g. 'ENOSPC'). */
  readonly code?: string
}

export type CloneErrorCode =
  | 'invalid-owner'
  | 'invalid-repo'
  | 'invalid-token-shape'
  | 'malformed-body'
  | 'body-too-large'
  | 'clone-failed'
  | 'clone-timeout'
  | 'clone-aborted'
  | 'git-not-available'
  | 'enospc'
  | 'disk-full'
  | 'permission-denied'
  | 'too-many-files'
  | 'repo-exists'
  | 'path-escaped-workspace'
  | 'head-resolution-failed'
  | 'overloaded'
  /**
   * The workspace-agent's post-clone ownership handoff failed — a DETERMINISTIC failure: the
   * same staged tree fails the same way on every retry (a hardlink, a filesystem-boundary
   * crossing, an unsupported node type, or the handoff's own deadline/entry cap). Classified as
   * PERMANENT in `PERMANENT_CLONE_ERROR_CODES` (execute/run.ts) — never `clone-timeout` or
   * `too-many-files`, both of which stay retryable. The specific reason lives in
   * `CloneFailure.code`, not a new field.
   */
  | 'checkout-handoff-failed'
  /**
   * A journal (apps/workspace-agent/src/journal.ts) already exists for this repository — an
   * update or recovery mutation was interrupted (or is still in flight) and left state that
   * clone must not silently clone over. NOT deterministic in the `PERMANENT_CLONE_ERROR_CODES`
   * sense: it clears once a later `/update` or `/fro-bot recover-checkout` resolves the journal,
   * both of which land in later units. Classified separately in `execute/run.ts`'s
   * `classifyEnsureCloneFailure` — see the comment there.
   */
  | 'journal-in-progress'

/** POST /inspect request body. */
export interface InspectRequest {
  readonly owner: string
  readonly repo: string
}

/** Observed HEAD state of a checkout — attached to a branch, or detached. */
export type CheckoutHead =
  | {readonly kind: 'attached'; readonly branch: string; readonly sha: string}
  | {readonly kind: 'detached'; readonly sha: string}

/** Observed worktree cleanliness. `dirty` always carries all four counts together. */
export type WorktreeState =
  | {readonly kind: 'clean'}
  | {
      readonly kind: 'dirty'
      readonly staged: number
      readonly unstaged: number
      readonly untracked: number
      readonly conflicted: number
    }

/** In-progress git operation detected from state files in the git directory. */
export type CheckoutOperation = 'none' | 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert' | 'bisect'

/** A single point-in-time observation of an existing checkout. Never mutates the checkout. */
export interface CheckoutObservation {
  readonly head: CheckoutHead
  readonly worktree: WorktreeState
  readonly operationInProgress: CheckoutOperation
  /** ISO-8601 timestamp, from an injected clock. */
  readonly observedAt: string
}

/** POST /inspect error response. */
export interface InspectFailure {
  readonly ok: false
  readonly error: InspectErrorCode
}

/** POST /inspect success response. */
export interface InspectSuccess {
  readonly ok: true
  readonly observation: CheckoutObservation
}

export type InspectErrorCode =
  | 'invalid-owner'
  | 'invalid-repo'
  | 'malformed-body'
  | 'body-too-large'
  | 'no-checkout'
  | 'checkout-substituted'
  | 'inspection-failed'
  | 'inspection-timeout'

/**
 * GET /readyz success response (HTTP 200).
 * Narrows the flat `ReadyzResponse` emitted by `apps/workspace-agent/src/server.ts`.
 */
export interface ReadyzReady {
  readonly ready: true
  readonly opencode: 'ready'
}

/**
 * GET /readyz not-ready response (HTTP 503).
 * Narrows the flat `ReadyzResponse` emitted by `apps/workspace-agent/src/server.ts`.
 */
export interface ReadyzNotReady {
  readonly ready: false
  readonly opencode: 'starting' | 'down' | 'degraded' | 'unknown'
}

/** Discriminated union of all /readyz response shapes. */
export type ReadyzResponse = ReadyzReady | ReadyzNotReady

/**
 * Client-side error discriminated union for workspace-api calls.
 * These are the errors the gateway's workspace client can return.
 *
 * This is the union of everything ANY workspace-api call can produce — kept for
 * callers (e.g. `readyz()`, and existing consumers outside this module) that
 * genuinely need the wider shape. `clone()` and `inspect()` return the narrower
 * `CloneWorkspaceError`/`InspectWorkspaceError` below instead, since each can only
 * ever produce its own structured-error kind, never the other's.
 */
export type WorkspaceError =
  | {readonly kind: 'clone-error'; readonly code: CloneErrorCode}
  | {readonly kind: 'inspect-error'; readonly code: InspectErrorCode}
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'network-error'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'parse-error'}
  | {readonly kind: 'response-mismatch'}

/** Errors `WorkspaceClient.clone()` can return — never `inspect-error`, which `clone()` cannot produce. */
export type CloneWorkspaceError =
  | {readonly kind: 'clone-error'; readonly code: CloneErrorCode}
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'network-error'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'parse-error'}
  | {readonly kind: 'response-mismatch'}

/** Errors `WorkspaceClient.inspect()` can return — never `clone-error`, which `inspect()` cannot produce. */
export type InspectWorkspaceError =
  | {readonly kind: 'inspect-error'; readonly code: InspectErrorCode}
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'network-error'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'parse-error'}
  | {readonly kind: 'response-mismatch'}

/** Transport-only errors every new workspace-api call can produce, shared by the unions below. */
export type WorkspaceTransportError =
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'network-error'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'parse-error'}

/** Errors `WorkspaceClient.update()` can return. `update-error` never carries a validation-only reason (`UpdateResult` itself is domain-level; a request-shape problem is `http-error` with the 400 status). */
export type UpdateWorkspaceError = WorkspaceTransportError

/** Errors `WorkspaceClient.previewRecovery()` can return. */
export type PreviewRecoveryWorkspaceError = WorkspaceTransportError

/** Errors `WorkspaceClient.recover()` can return. */
export type ExecuteRecoveryWorkspaceError = WorkspaceTransportError

/** Errors `WorkspaceClient.listBackups()` can return. */
export type ListBackupsWorkspaceError = WorkspaceTransportError

/** Errors `WorkspaceClient.deleteBackup()` can return. */
export type DeleteBackupWorkspaceError = WorkspaceTransportError

/** POST /update request body. */
export interface UpdateRequest {
  readonly owner: string
  readonly repo: string
  /** Installation access token (ghs_*). Used only by the network half; never logged. */
  readonly token: string
}

/** How the checkout's branch tip changed (or didn't) as a result of this update. */
export type UpdateChangeKind = 'fast-forward' | 'unchanged'

/** The checkout was already eligible and is now current — unchanged, or fast-forwarded to the remote tip. */
export interface UpdateReady {
  readonly kind: 'ready'
  readonly change: UpdateChangeKind
  readonly branch: string
  readonly sha: string
  /** HEAD before the update, when `change` is `fast-forward`. Omitted when `change` is `unchanged`. */
  readonly fromSha?: string
  /** ISO-8601 timestamp, from an injected clock, when the remote evidence was checked. */
  readonly checkedAt: string
}

/** Layout admission-check refusal reasons — mirrors `apps/workspace-agent/src/checkout-profile.ts`'s `LayoutRefusalReason`. */
export type LayoutRefusalReason =
  | 'core-worktree'
  | 'gitfile'
  | 'symlinked-git-dir'
  | 'symlinked-config'
  | 'alternates'
  | 'replace-refs'
  | 'grafts'
  | 'shallow'
  | 'partial-clone'
  | 'linked-worktree'
  | 'unsupported-index-flag'
  | 'bare-repository'

/** Path-obstruction kinds — mirrors `checkout-profile.ts`'s `ObstructionKind`. */
export type ObstructionKind = 'exact-conflict' | 'prefix-conflict' | 'identical-content' | 'symlink-ancestor'

/** A single path obstruction blocking a fast-forward merge — mirrors `checkout-profile.ts`'s `Obstruction`. */
export interface Obstruction {
  /** Repo-relative (never absolute, never checkout-path-prefixed). */
  readonly path: string
  readonly kind: ObstructionKind
}

/** Every reason `/update` can refuse to run for, closed and final. */
export type UpdateRefusalReason =
  | 'needs-recovery'
  | 'checkout-substituted'
  | 'unsupported-layout'
  | 'unsupported-config'
  | 'operation-in-progress'
  | 'dirty'
  | 'submodule-initialized'
  | 'detached'
  | 'non-default-branch'
  | 'diverged'
  | 'ahead'
  | 'obstructed'
  | 'maintenance-hold'

/** The checkout is ineligible; no mutation was ever attempted. Discriminated by `reason`. */
export type UpdateRefused =
  | {readonly kind: 'refused'; readonly reason: 'needs-recovery'}
  | {readonly kind: 'refused'; readonly reason: 'checkout-substituted'}
  | {readonly kind: 'refused'; readonly reason: 'unsupported-layout'; readonly layoutReason: LayoutRefusalReason}
  | {readonly kind: 'refused'; readonly reason: 'unsupported-config'; readonly disallowedKeys: readonly string[]}
  | {readonly kind: 'refused'; readonly reason: 'operation-in-progress'; readonly operation: CheckoutOperation}
  | {readonly kind: 'refused'; readonly reason: 'dirty'; readonly changedPaths: readonly string[]}
  | {readonly kind: 'refused'; readonly reason: 'submodule-initialized'; readonly submodules: readonly string[]}
  | {readonly kind: 'refused'; readonly reason: 'detached'}
  | {readonly kind: 'refused'; readonly reason: 'non-default-branch'; readonly branch: string}
  | {readonly kind: 'refused'; readonly reason: 'diverged'}
  | {readonly kind: 'refused'; readonly reason: 'ahead'}
  | {readonly kind: 'refused'; readonly reason: 'obstructed'; readonly obstructions: readonly Obstruction[]}
  | {readonly kind: 'refused'; readonly reason: 'maintenance-hold'}

/** Every reason `/update` can fail for, closed. See `apps/workspace-agent/src/types.ts`'s `UpdateFailureReason` for the full mutationStarted/journal-disposition rationale per reason. */
export type UpdateFailureReason =
  | 'aborted'
  | 'inspection-failed'
  | 'fetch-auth-rejected'
  | 'fetch-not-found'
  | 'fetch-forbidden'
  | 'fetch-rate-limited'
  | 'fetch-unreachable'
  | 'fetch-timeout'
  | 'fetch-failed'
  | 'remote-moved'
  | 'apply-failed'
  | 'termination-unconfirmed'

/** An attempt was made and did not succeed. `mutationStarted` is `'possibly'` only when subprocess termination itself went unconfirmed — never a synonym for `true`. */
export interface UpdateFailed {
  readonly kind: 'failed'
  readonly reason: UpdateFailureReason
  readonly mutationStarted: boolean | 'possibly'
  readonly permanent: boolean
}

/** No checkout exists at this repository's path, and no journal is in flight for it either. */
export interface UpdateNoCheckout {
  readonly kind: 'no-checkout'
}

/** The discriminated result of a `/update` attempt. Never flags — exactly one of these four shapes. */
export type UpdateResult = UpdateReady | UpdateRefused | UpdateFailed | UpdateNoCheckout

/** POST /update validation failure — an HTTP-layer request-shape problem caught BEFORE `executeUpdate` is ever called. */
export interface UpdateValidationFailure {
  readonly ok: false
  readonly error: 'malformed-body' | 'body-too-large' | 'invalid-owner' | 'invalid-repo' | 'invalid-token-shape'
}

/** POST /recover/preview request body. */
export interface PreviewRecoveryRequest {
  readonly owner: string
  readonly repo: string
}

export interface DirtyCounts {
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly conflicted: number
}

/** Current usage against the fixed retention quota. */
export interface RetentionUsage {
  readonly generationCount: number
  readonly hasUnknownSize: boolean
  readonly totalBytes: number
  readonly maxGenerations: number
  readonly maxBytes: number
}

/** Full preview — `inspectionSafe: true` — every admission check the checkout would face passed. */
export interface SafeRecoveryPreview {
  readonly inspectionSafe: true
  readonly headSha: string | undefined
  readonly branch: string | undefined
  readonly dirty: DirtyCounts
  readonly operationInProgress: CheckoutOperation
  readonly ignoredCount: number
  readonly estimatedSizeBytes: number
  readonly entryCount: number
  readonly sizeMeasurementComplete: boolean
  readonly retention: RetentionUsage
  readonly fingerprint: string
}

/** Opaque preview — `inspectionSafe: false` — admission would refuse the checkout; no git ever ran in it. */
export interface OpaqueRecoveryPreview {
  readonly inspectionSafe: false
  readonly estimatedSizeBytes: number
  readonly entryCount: number
  readonly sizeMeasurementComplete: boolean
  readonly retention: RetentionUsage
  readonly fingerprint: string
}

export type RecoveryPreview = SafeRecoveryPreview | OpaqueRecoveryPreview

/** Mirrors `apps/workspace-agent/src/journal.ts`'s `UpdateJournalPhase`. */
export type UpdateJournalPhase = 'fetched' | 'applying' | 'applied'

/** Mirrors `apps/workspace-agent/src/journal.ts`'s `RecoveryJournalPhase`. */
export type RecoveryJournalPhase = 'building' | 'quarantining' | 'installing' | 'verifying'

/**
 * An interrupted UPDATE journal reported as RECOVERABLE via `/recover`, rather than a dead-end
 * refusal. `fingerprint` digests the journal's own identity (phase, from/to SHAs, `startedAt`) and
 * a filesystem-only size observation, never a live git inspection.
 */
export interface RecoverableUpdatePreview {
  readonly phase: UpdateJournalPhase
  readonly fromSha: string
  readonly toSha: string
  readonly startedAt: string
  readonly estimatedSizeBytes: number
  readonly entryCount: number
  readonly sizeMeasurementComplete: boolean
  readonly fingerprint: string
}

/** A journal (update or recovery) currently in flight for this repository. */
export type JournalInProgressPhase = UpdateJournalPhase | RecoveryJournalPhase | 'malformed'

export type PreviewRecoveryResult =
  | {readonly kind: 'no-checkout'}
  | {readonly kind: 'refused'; readonly reason: 'checkout-substituted'}
  | {readonly kind: 'refused'; readonly reason: 'maintenance-hold'}
  | {readonly kind: 'refused'; readonly reason: 'journal-in-progress'; readonly phase: JournalInProgressPhase}
  | {readonly kind: 'failed'; readonly reason: 'inspection-failed'}
  | {readonly kind: 'failed'; readonly reason: 'termination-unconfirmed'}
  | {readonly kind: 'ok'; readonly preview: RecoveryPreview}
  | {readonly kind: 'recoverable-update'; readonly update: RecoverableUpdatePreview}

/** POST /recover/preview validation failure — an HTTP-layer request-shape problem caught BEFORE `previewRecovery` is ever called. */
export interface PreviewRecoveryValidationFailure {
  readonly ok: false
  readonly error: 'malformed-body' | 'body-too-large' | 'invalid-owner' | 'invalid-repo'
}

/** POST /recover request body. */
export interface ExecuteRecoveryRequest {
  readonly owner: string
  readonly repo: string
  readonly token: string
  /** The fingerprint the operator saw from `previewRecovery`; recomputed and compared under the mutex. */
  readonly fingerprint: string
}

export type ExecuteRecoveryFailureReason =
  | 'inspection-failed'
  | 'fetch-failed'
  | 'build-failed'
  | 'quarantine-failed'
  | 'install-failed'
  | 'verification-failed'
  | 'termination-unconfirmed'

export type ExecuteRecoveryResult =
  | {readonly kind: 'no-checkout'}
  | {readonly kind: 'refused'; readonly reason: 'maintenance-hold'}
  | {readonly kind: 'refused'; readonly reason: 'journal-in-progress'; readonly phase: JournalInProgressPhase}
  | {readonly kind: 'refused'; readonly reason: 'checkout-changed'}
  | {readonly kind: 'refused'; readonly reason: 'quota-exceeded'; readonly usage: RetentionUsage}
  | {readonly kind: 'refused'; readonly reason: 'insufficient-disk-space'}
  | {readonly kind: 'failed'; readonly reason: ExecuteRecoveryFailureReason}
  | {readonly kind: 'ok'; readonly recoveryId: string; readonly sha: string; readonly branch: string}

/** POST /recover validation failure — an HTTP-layer request-shape problem caught BEFORE `executeRecovery` is ever called. */
export interface ExecuteRecoveryValidationFailure {
  readonly ok: false
  readonly error:
    | 'malformed-body'
    | 'body-too-large'
    | 'invalid-owner'
    | 'invalid-repo'
    | 'invalid-token-shape'
    | 'invalid-fingerprint'
}

/** GET/DELETE /backups/... validation failure — owner/repo path-segment problems caught before `listBackups`/`deleteBackup` is ever called. */
export interface BackupsValidationFailure {
  readonly ok: false
  readonly error: 'invalid-owner' | 'invalid-repo'
}

/** One listable quarantine generation. `metadataOk: false` means metadata.json failed to parse. */
export interface BackupEntry {
  readonly id: string
  readonly metadataOk: boolean
  readonly createdAt: string
  readonly sizeBytes: number
  readonly sizeComplete: boolean
  readonly originalHeadSha: string | undefined
  readonly originalBranch: string | undefined
}

/** GET /backups/:owner/:repo response. */
export type ListBackupsResult =
  | {readonly kind: 'ok'; readonly backups: readonly BackupEntry[]; readonly totalBytes: number}
  | {readonly kind: 'failed'}

/** DELETE /backups/:owner/:repo/:id response. */
export type DeleteBackupResult =
  | {readonly kind: 'ok'}
  | {
      readonly kind: 'refused'
      readonly reason: 'invalid-id' | 'not-found' | 'maintenance-hold' | 'recovery-in-progress'
    }
  | {readonly kind: 'failed'}
