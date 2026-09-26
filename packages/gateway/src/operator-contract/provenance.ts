/**
 * Operator-safe checkout provenance projection.
 *
 * Wire-decoupled from the internal `CheckoutProvenance` type
 * (`execute/provenance.ts`): this module defines its own DTO shape so an
 * internal refactor of the run-execution engine cannot silently change the
 * wire format the dashboard consumes. `parseOperatorCheckoutProvenance`
 * validates `runState.details.checkoutProvenance` — untyped `unknown` data
 * read off disk — into this DTO. Anything malformed or absent is rejected to
 * `undefined`, the same state a pre-existing run (recorded before this field
 * existed) already produces. Never cast; always validated field-by-field.
 *
 * A discriminated union throughout: never a `fresh: boolean`, never an
 * optional SHA standing in for "unknown". `remote: {kind: 'not-checked'}` is
 * present on both variants — explicit, not an omitted field — so a later
 * contract version can add a `{kind: 'checked', ...}` variant without a
 * rewrite of every consumer.
 */

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export type OperatorCheckoutHead =
  | {readonly kind: 'attached'; readonly branch: string; readonly sha: string}
  | {readonly kind: 'detached'; readonly sha: string}

export type OperatorWorktreeState =
  | {readonly kind: 'clean'}
  | {
      readonly kind: 'dirty'
      readonly staged: number
      readonly unstaged: number
      readonly untracked: number
      readonly conflicted: number
    }

export type OperatorCheckoutOperation = 'none' | 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert' | 'bisect'

export interface OperatorCheckoutObservation {
  readonly head: OperatorCheckoutHead
  readonly worktree: OperatorWorktreeState
  readonly operationInProgress: OperatorCheckoutOperation
  readonly observedAt: string
}

/**
 * Whether remote freshness was checked. Present on every variant — never omitted.
 *
 * Contract 1.8.0 adds `'checked'`: preparation ran `/update`, observed the remote default branch,
 * and the checkout is current with it. `fromSha` exists only on the `fast-forward` shape — an
 * `unchanged` value has no field for it at all, matching `execute/provenance.ts`'s internal
 * `RemoteFreshness` shape one-for-one (this DTO stays wire-decoupled from that type; it defines its
 * own copy rather than importing it). Consumers must still handle an unrecognized `kind` gracefully
 * rather than assume this two-member list is complete — a later minor may add more.
 */
export type OperatorRemoteFreshness =
  | {readonly kind: 'not-checked'}
  | {
      readonly kind: 'checked'
      readonly defaultBranch: string
      readonly sha: string
      readonly checkedAt: string
      readonly change: 'unchanged'
    }
  | {
      readonly kind: 'checked'
      readonly defaultBranch: string
      readonly sha: string
      readonly checkedAt: string
      readonly change: 'fast-forward'
      readonly fromSha: string
    }

/**
 * What a run started from, projected for the operator surface.
 *
 * - `observed` — an observation was captured under the repo lock.
 * - `unavailable` — inspection failed for a reason other than a substituted
 *   checkout (a substituted checkout fails the run instead of producing this).
 */
export type OperatorCheckoutProvenance =
  | {
      readonly kind: 'observed'
      readonly observation: OperatorCheckoutObservation
      readonly remote: OperatorRemoteFreshness
    }
  | {readonly kind: 'unavailable'; readonly remote: OperatorRemoteFreshness}

// ---------------------------------------------------------------------------
// Validators — parse, don't trust. `value as Record<string, unknown>` is a
// narrowing cast after a typeof/null guard, matching the style already used
// by workspace-api/client.ts's wire validators (isCheckoutObservation et al.)
// — never `as any`, `as unknown as`, or a blind property-existence check.
// ---------------------------------------------------------------------------

const CHECKOUT_OPERATIONS = new Set<string>(['none', 'merge', 'rebase', 'am', 'cherry-pick', 'revert', 'bisect'])
const SHA_RE = /^[0-9a-f]{40}$/

function isCheckoutOperation(value: unknown): value is OperatorCheckoutOperation {
  return typeof value === 'string' && CHECKOUT_OPERATIONS.has(value)
}

function isValidSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_RE.test(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Rejects a `fast-forward` whose `fromSha` equals `sha` (no real advance — an invariant-violating
 * value the internal `RemoteFreshness` constructor never produces, so trusting one on the wire
 * would be trusting stored data over the type's own guarantee) or that omits `fromSha` entirely.
 */
function isRemoteFreshness(value: unknown): value is OperatorRemoteFreshness {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.kind === 'not-checked') return true
  if (v.kind !== 'checked') return false
  if (!isNonEmptyString(v.defaultBranch) || !isValidSha(v.sha) || !isNonEmptyString(v.checkedAt)) return false
  if (v.change === 'unchanged') return true
  if (v.change === 'fast-forward') return isValidSha(v.fromSha) && v.fromSha !== v.sha
  return false
}

function isCheckoutHead(value: unknown): value is OperatorCheckoutHead {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.kind === 'attached') {
    return isNonEmptyString(v.branch) && isValidSha(v.sha)
  }
  if (v.kind === 'detached') {
    return isValidSha(v.sha)
  }
  // Unknown kind — a missing branch field must never be interpreted as "detached".
  return false
}

function isWorktreeState(value: unknown): value is OperatorWorktreeState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.kind === 'clean') return true
  if (v.kind === 'dirty') {
    return (
      isNonNegativeInteger(v.staged) &&
      isNonNegativeInteger(v.unstaged) &&
      isNonNegativeInteger(v.untracked) &&
      isNonNegativeInteger(v.conflicted)
    )
  }
  return false
}

function isCheckoutObservation(value: unknown): value is OperatorCheckoutObservation {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    isCheckoutHead(v.head) &&
    isWorktreeState(v.worktree) &&
    isCheckoutOperation(v.operationInProgress) &&
    isNonEmptyString(v.observedAt)
  )
}

/**
 * Validate `runState.details.checkoutProvenance` (untyped `unknown` read off
 * disk) into an `OperatorCheckoutProvenance`, or `undefined` when the value is
 * absent (a run recorded before this field existed) or malformed (storage
 * corruption, version skew). Never throws; never casts the input directly —
 * every field is checked before it is used.
 */
export function parseOperatorCheckoutProvenance(value: unknown): OperatorCheckoutProvenance | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>

  if (!isRemoteFreshness(v.remote)) return undefined

  if (v.kind === 'observed') {
    if (!isCheckoutObservation(v.observation)) return undefined
    return {kind: 'observed', observation: v.observation, remote: v.remote}
  }

  if (v.kind === 'unavailable') {
    return {kind: 'unavailable', remote: v.remote}
  }

  return undefined
}

// ---------------------------------------------------------------------------
// OperatorCheckoutPreparation — contract 1.8.0. A separate, optional field from
// OperatorCheckoutProvenance: a run carrying this NEVER reached EXECUTING (a
// refused or failed preparation attempt), so the two are mutually exclusive in
// practice, not structurally forbidden from co-existing on the wire type.
// Wire-decoupled from execute/provenance.ts's `CheckoutPreparation`, same
// posture as `OperatorCheckoutProvenance` above.
// ---------------------------------------------------------------------------

export type OperatorLayoutRefusalReason =
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

export type OperatorObstructionKind = 'exact-conflict' | 'prefix-conflict' | 'identical-content' | 'symlink-ancestor'

/** A refused preparation attempt — mirrors `execute/provenance.ts`'s `CheckoutPreparationRefused` field-for-field. */
export type OperatorCheckoutPreparationRefused =
  | {readonly outcome: 'refused'; readonly reason: 'needs-recovery'}
  | {readonly outcome: 'refused'; readonly reason: 'checkout-substituted'}
  | {
      readonly outcome: 'refused'
      readonly reason: 'unsupported-layout'
      readonly layoutReason: OperatorLayoutRefusalReason
    }
  | {readonly outcome: 'refused'; readonly reason: 'unsupported-config'; readonly disallowedKeys: readonly string[]}
  | {
      readonly outcome: 'refused'
      readonly reason: 'operation-in-progress'
      readonly operation: OperatorCheckoutOperation
    }
  | {readonly outcome: 'refused'; readonly reason: 'dirty'; readonly changedPaths: readonly string[]}
  | {readonly outcome: 'refused'; readonly reason: 'submodule-initialized'; readonly submodules: readonly string[]}
  | {readonly outcome: 'refused'; readonly reason: 'detached'}
  | {readonly outcome: 'refused'; readonly reason: 'non-default-branch'; readonly branch: string}
  | {readonly outcome: 'refused'; readonly reason: 'diverged'}
  | {readonly outcome: 'refused'; readonly reason: 'ahead'}
  | {
      readonly outcome: 'refused'
      readonly reason: 'obstructed'
      readonly obstructions: readonly {readonly path: string; readonly kind: OperatorObstructionKind}[]
    }
  | {readonly outcome: 'refused'; readonly reason: 'maintenance-hold'}

export type OperatorUpdateFailureReason =
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

/** A failed preparation attempt — mirrors `execute/provenance.ts`'s `CheckoutPreparationFailed` field-for-field. */
export interface OperatorCheckoutPreparationFailed {
  readonly outcome: 'failed'
  readonly reason: OperatorUpdateFailureReason
  readonly mutationStarted: boolean | 'possibly'
  readonly permanent: boolean
}

/** What preparation reported for a run that never reached EXECUTING, projected for the operator surface. */
export type OperatorCheckoutPreparation = OperatorCheckoutPreparationRefused | OperatorCheckoutPreparationFailed

const LAYOUT_REFUSAL_REASONS = new Set<string>([
  'core-worktree',
  'gitfile',
  'symlinked-git-dir',
  'symlinked-config',
  'alternates',
  'replace-refs',
  'grafts',
  'shallow',
  'partial-clone',
  'linked-worktree',
  'unsupported-index-flag',
  'bare-repository',
])

const OBSTRUCTION_KINDS = new Set<string>([
  'exact-conflict',
  'prefix-conflict',
  'identical-content',
  'symlink-ancestor',
])

const UPDATE_FAILURE_REASONS = new Set<string>([
  'aborted',
  'inspection-failed',
  'fetch-auth-rejected',
  'fetch-not-found',
  'fetch-forbidden',
  'fetch-rate-limited',
  'fetch-unreachable',
  'fetch-timeout',
  'fetch-failed',
  'remote-moved',
  'apply-failed',
  'termination-unconfirmed',
])

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

function isObstructionArray(
  value: unknown,
): value is readonly {readonly path: string; readonly kind: OperatorObstructionKind}[] {
  if (!Array.isArray(value)) return false
  return value.every(entry => {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Record<string, unknown>
    return typeof e.path === 'string' && typeof e.kind === 'string' && OBSTRUCTION_KINDS.has(e.kind)
  })
}

function isCheckoutPreparationFailed(v: Record<string, unknown>): v is {
  outcome: 'failed'
  reason: OperatorUpdateFailureReason
  mutationStarted: boolean | 'possibly'
  permanent: boolean
} {
  if (typeof v.reason !== 'string' || !UPDATE_FAILURE_REASONS.has(v.reason)) return false
  if (v.mutationStarted !== true && v.mutationStarted !== false && v.mutationStarted !== 'possibly') return false
  return typeof v.permanent === 'boolean'
}

/**
 * Field-by-field per refusal `reason`, exactly like `isCheckoutPreparationFailed` above — never a
 * blanket property-existence check, never a cast of the whole object.
 */
function parseCheckoutPreparationRefused(v: Record<string, unknown>): OperatorCheckoutPreparationRefused | undefined {
  const {reason} = v
  switch (reason) {
    case 'needs-recovery':
    case 'checkout-substituted':
    case 'detached':
    case 'diverged':
    case 'ahead':
    case 'maintenance-hold':
      return {outcome: 'refused', reason}
    case 'unsupported-layout':
      return typeof v.layoutReason === 'string' && LAYOUT_REFUSAL_REASONS.has(v.layoutReason)
        ? {outcome: 'refused', reason, layoutReason: v.layoutReason as OperatorLayoutRefusalReason}
        : undefined
    case 'unsupported-config':
      return isStringArray(v.disallowedKeys)
        ? {outcome: 'refused', reason, disallowedKeys: v.disallowedKeys}
        : undefined
    case 'operation-in-progress':
      return isCheckoutOperation(v.operation) ? {outcome: 'refused', reason, operation: v.operation} : undefined
    case 'dirty':
      return isStringArray(v.changedPaths) ? {outcome: 'refused', reason, changedPaths: v.changedPaths} : undefined
    case 'submodule-initialized':
      return isStringArray(v.submodules) ? {outcome: 'refused', reason, submodules: v.submodules} : undefined
    case 'non-default-branch':
      return isNonEmptyString(v.branch) ? {outcome: 'refused', reason, branch: v.branch} : undefined
    case 'obstructed':
      return isObstructionArray(v.obstructions) ? {outcome: 'refused', reason, obstructions: v.obstructions} : undefined
    default:
      return undefined
  }
}

/**
 * Validate `runState.details.checkoutPreparation` (untyped `unknown` read off disk) into an
 * `OperatorCheckoutPreparation`, or `undefined` when absent (no field — the run reached EXECUTING,
 * or predates this contract version) or malformed (storage corruption, version skew). Never
 * throws; never casts the input directly.
 */
export function parseOperatorCheckoutPreparation(value: unknown): OperatorCheckoutPreparation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>

  if (v.outcome === 'failed') {
    return isCheckoutPreparationFailed(v) ? v : undefined
  }
  if (v.outcome === 'refused') {
    return parseCheckoutPreparationRefused(v)
  }
  return undefined
}
