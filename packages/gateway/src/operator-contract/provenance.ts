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
 * `kind` may gain additional variants in later contract minors (e.g. a future `'checked'`
 * variant reporting how far behind the remote the checkout is). Consumers must handle an
 * unknown `kind` gracefully rather than assume the current list (`'not-checked'`) is complete.
 */
export interface OperatorRemoteFreshness {
  readonly kind: 'not-checked'
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

function isRemoteFreshness(value: unknown): value is OperatorRemoteFreshness {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.kind === 'not-checked'
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
