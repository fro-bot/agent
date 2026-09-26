/**
 * Checkout provenance — what a run started from.
 *
 * `inspect()` is called right after `ensureClone`, still under the repo lock
 * (see `run.ts`). The result is classified here into either a run-blocking
 * failure (`checkout-substituted` — the tree isn't the expected repository,
 * a correctness problem, not a missing label) or a `CheckoutProvenance` the
 * run carries forward: to the agent (via the prompt), to the human (via a
 * deterministic reply line), and onto the run's persisted state.
 *
 * PR 1 (this file) never checks remote freshness — `RemoteFreshness` is always
 * `{kind: 'not-checked'}`. That is represented explicitly, not by omitting a
 * field, so a later PR can add a `{kind: 'checked', ...}` variant without a
 * rewrite of every consumer.
 */

import type {
  CheckoutObservation,
  CheckoutOperation,
  InspectErrorCode,
  InspectWorkspaceError,
  LayoutRefusalReason,
  ObstructionKind,
  UpdateFailed,
  UpdateFailureReason,
  UpdateReady,
  UpdateRefused,
} from '../workspace-api/types.js'

// ---------------------------------------------------------------------------
// RemoteFreshness — explicit "not checked" today; Unit 6 (this file) adds
// `checked`, projected from a `/update` `ready` result.
// ---------------------------------------------------------------------------

/** Whether the run checked the remote for commits ahead of the local checkout. */
export type RemoteFreshness =
  | {readonly kind: 'not-checked'}
  /**
   * Preparation ran `/update`, the remote default branch was observed, and the checkout is
   * current with it. A discriminated union on `change`, not a boolean/optional pairing: the
   * `unchanged` variant has no `fromSha` field at all (there is nothing to have come from), so an
   * "unchanged but here's a fromSha anyway" state cannot be constructed by this module — see
   * `toRemoteFreshnessFromUpdateReady`, the only constructor, for the runtime half of that
   * guarantee (`fromSha` must differ from `sha` for a real `fast-forward`, which TypeScript's
   * structural typing cannot enforce on two `string` fields).
   */
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

/** Singleton for the common "not checked" case. */
export const REMOTE_FRESHNESS_NOT_CHECKED: RemoteFreshness = {kind: 'not-checked'}

/**
 * Projects a workspace `/update` `ready` result into `RemoteFreshness`. The only constructor for
 * the `checked` variant — nothing else in this module builds one by hand.
 *
 * The `fast-forward` invariant (`fromSha` present and differs from `sha`) is enforced at the wire
 * boundary, not here: `workspace-api/client.ts`'s `isUpdateReadyBody` rejects a degenerate
 * fast-forward (missing `fromSha`, or `fromSha === sha`) as `parse-error` before an `UpdateReady`
 * carrying one can ever reach this function — so a caller only ever passes a `ready` result already
 * proven valid. This function therefore never normalizes a bad value into `unchanged`: doing so
 * would hide a genuine workspace-agent bug behind a falsely-reassuring "nothing changed"
 * projection. If the invariant is somehow violated anyway (a caller bypassing the validated client,
 * or a future regression in it), this throws rather than silently misrepresenting the checkout's
 * state — fail loud, not fail quiet.
 */
export function toRemoteFreshnessFromUpdateReady(ready: UpdateReady): RemoteFreshness {
  const {branch: defaultBranch, sha, checkedAt} = ready
  if (ready.change === 'unchanged') {
    return {kind: 'checked', defaultBranch, sha, checkedAt, change: 'unchanged'}
  }
  if (ready.fromSha === undefined || ready.fromSha === sha) {
    throw new Error(
      'toRemoteFreshnessFromUpdateReady: fast-forward UpdateReady missing a real fromSha — the wire ' +
        'validator (isUpdateReadyBody) should have rejected this as parse-error before this function was called',
    )
  }
  return {kind: 'checked', defaultBranch, sha, checkedAt, change: 'fast-forward', fromSha: ready.fromSha}
}

// ---------------------------------------------------------------------------
// CheckoutProvenance — discriminated union, no booleans, no optional SHAs
// ---------------------------------------------------------------------------

/** Reason a starting-state observation could not be obtained. Never `checkout-substituted` — that fails the run instead of producing this. */
export type ProvenanceUnavailableReason =
  | {readonly kind: 'inspect-error'; readonly code: Exclude<InspectErrorCode, 'checkout-substituted'>}
  | {readonly kind: 'http-error'; readonly status: number}
  | {readonly kind: 'network-error'}
  | {readonly kind: 'timeout'}
  | {readonly kind: 'parse-error'}
  | {readonly kind: 'response-mismatch'}

/**
 * What a run started from. A discriminated union: never a `fresh: boolean`,
 * never an optional SHA standing in for "unknown".
 *
 * - `observed` — a `CheckoutObservation` was captured under the repo lock,
 *   immediately after `ensureClone`.
 * - `unavailable` — inspection failed for a reason other than
 *   `checkout-substituted`. The run proceeds; both the prompt and the reply
 *   must say plainly that the starting state is unknown.
 */
export type CheckoutProvenance =
  | {readonly kind: 'observed'; readonly observation: CheckoutObservation; readonly remote: RemoteFreshness}
  | {readonly kind: 'unavailable'; readonly reason: ProvenanceUnavailableReason; readonly remote: RemoteFreshness}

/**
 * Map a workspace-api `inspect()` failure to a `ProvenanceUnavailableReason`.
 * Never called for `checkout-substituted` — `classifyInspectResult` routes that
 * code to `{decision: 'fail-run'}` before this function would be reached.
 */
function toProvenanceUnavailableReason(error: InspectWorkspaceError): ProvenanceUnavailableReason {
  switch (error.kind) {
    case 'inspect-error':
      // Narrowed by the caller (classifyInspectResult) to exclude 'checkout-substituted'.
      return {kind: 'inspect-error', code: error.code as Exclude<InspectErrorCode, 'checkout-substituted'>}
    case 'http-error':
      return {kind: 'http-error', status: error.status}
    case 'network-error':
      return {kind: 'network-error'}
    case 'timeout':
      return {kind: 'timeout'}
    case 'parse-error':
      return {kind: 'parse-error'}
    case 'response-mismatch':
      // inspect() does not produce this today: its status/body contradiction
      // returns 'parse-error', and only clone()'s path-equality check raises
      // 'response-mismatch'. It stays in InspectWorkspaceError's type, so it is
      // handled rather than asserted away, and kept 'unavailable' rather than
      // failing the run.
      return {kind: 'response-mismatch'}
  }
}

// ---------------------------------------------------------------------------
// Classification — the fail-run / proceed decision
// ---------------------------------------------------------------------------

/** The engine's decision after inspecting the checkout. */
export type InspectOutcome =
  | {readonly decision: 'proceed'; readonly provenance: CheckoutProvenance}
  /**
   * A tree that isn't the expected repository is a correctness failure, not a
   * missing label — the caller must fail the run through the existing
   * post-lock failure path rather than proceeding with a mislabeled provenance.
   */
  | {readonly decision: 'fail-run'; readonly reason: 'checkout-substituted'}

/**
 * Classify the result of `workspaceClient.inspect()` (called right after
 * `ensureClone`, under the repo lock) into an `InspectOutcome`.
 *
 * - `ok(observation)` → proceed, `kind: 'observed'`.
 * - `err({kind: 'inspect-error', code: 'checkout-substituted'})` → fail the run.
 * - Any other `err(...)` → proceed, `kind: 'unavailable'` (PR 1: a visibility
 *   feature that can take runs down is out of proportion for anything short
 *   of a substituted checkout).
 */
export function classifyInspectResult(
  result:
    | {readonly success: true; readonly data: CheckoutObservation}
    | {readonly success: false; readonly error: InspectWorkspaceError},
): InspectOutcome {
  if (result.success === true) {
    return {
      decision: 'proceed',
      provenance: {kind: 'observed', observation: result.data, remote: REMOTE_FRESHNESS_NOT_CHECKED},
    }
  }

  if (result.error.kind === 'inspect-error' && result.error.code === 'checkout-substituted') {
    return {decision: 'fail-run', reason: 'checkout-substituted'}
  }

  return {
    decision: 'proceed',
    provenance: {
      kind: 'unavailable',
      reason: toProvenanceUnavailableReason(result.error),
      remote: REMOTE_FRESHNESS_NOT_CHECKED,
    },
  }
}

// ---------------------------------------------------------------------------
// Branch-name safety — refnames are attacker-influenced (a prior run's agent
// chooses them) and `git check-ref-format` permits backticks and other
// Markdown-significant characters. Both rendering surfaces below (the
// human-facing reply line and the agent-facing prompt) must neutralize that
// before interpolating a branch name, never trust it as safe free text.
// ---------------------------------------------------------------------------

/**
 * Maximum branch-name length shown to either surface. Git refnames have no
 * practical upper bound (limited only by the filesystem), so an unbounded
 * branch name is both a display nuisance (a single line could dwarf the rest
 * of the reply) and, in the prompt, a way to pad injected content. 60 chars
 * comfortably fits realistic branch conventions (e.g.
 * `feature/some-descriptive-slug-123`) while bounding the worst case.
 */
const MAX_BRANCH_DISPLAY_LENGTH = 60

/** Truncate `value` to at most `maxLength` characters, appending an ellipsis when cut. */
function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}\u2026`
}

/**
 * Replace every backtick in `branch` with a visually similar, non-Markdown
 * character (U+02CB MODIFIER LETTER GRAVE ACCENT) so the branch text can
 * never contain the code-span delimiter it is about to be wrapped in.
 *
 * Chosen over sizing the surrounding backtick-fence to the longest backtick
 * run in the name (the CommonMark escape strategy) because Discord's inline
 * code rule is not CommonMark: it matches a run of backticks with no
 * unescaped-padding fallback for content that starts or ends with a
 * backtick, so a delimiter-sizing approach would need to special-case those
 * edges to stay safe on Discord specifically. Substitution sidesteps that
 * entirely — the wrapped content is guaranteed backtick-free, so a single
 * backtick delimiter always closes correctly on Discord and in any
 * CommonMark renderer (e.g. the web operator UI), with one deterministic
 * transform instead of two dialect-specific ones.
 */
function sanitizeBranchForCodeSpan(branch: string): string {
  return branch.replaceAll('`', '\u02CB')
}

/** Render a branch name safely for the human-facing reply line's code span. */
export function formatBranchForReply(branch: string): string {
  return sanitizeBranchForCodeSpan(truncateForDisplay(branch, MAX_BRANCH_DISPLAY_LENGTH))
}

/**
 * Render a branch name safely for the agent prompt: a JSON string literal,
 * not interpolated free text. JSON.stringify escapes quotes, backslashes,
 * and control characters, so the model reads the branch as an unambiguous
 * data value rather than text that could blend into surrounding instructions
 * — the same length cap applies before quoting.
 */
function quoteBranchForPrompt(branch: string): string {
  return JSON.stringify(truncateForDisplay(branch, MAX_BRANCH_DISPLAY_LENGTH))
}

// ---------------------------------------------------------------------------
// Agent-facing summary — inserted once, at the engine level, after the prompt
// builder runs (Discord's or a custom one) — never by an individual builder.
// ---------------------------------------------------------------------------

function describeHeadForAgent(observation: CheckoutObservation): string {
  const {head} = observation
  return head.kind === 'attached'
    ? `${head.sha} on branch ${quoteBranchForPrompt(head.branch)}`
    : `${head.sha} (detached HEAD)`
}

function describeWorktreeForAgent(observation: CheckoutObservation): string {
  const {worktree} = observation
  if (worktree.kind === 'clean') return 'clean'
  return `dirty — staged ${worktree.staged}, unstaged ${worktree.unstaged}, untracked ${worktree.untracked}, conflicted ${worktree.conflicted}`
}

/**
 * Renders the remote-freshness clause shared by both `formatProvenanceForPrompt` branches. The
 * `not-checked` case reproduces today's exact literal string (byte-identical output requirement).
 */
function describeRemoteFreshnessForPrompt(remote: RemoteFreshness): string {
  if (remote.kind === 'not-checked') {
    return 'Remote freshness was not checked — do not assume this is the latest default branch.'
  }
  const branch = quoteBranchForPrompt(remote.defaultBranch)
  if (remote.change === 'unchanged') {
    return `Remote checked: default branch ${branch} is unchanged at ${remote.sha}, observed at ${remote.checkedAt}.`
  }
  return `Remote checked: default branch ${branch} advanced from ${remote.fromSha} to ${remote.sha}, observed at ${remote.checkedAt}.`
}

/**
 * Build the agent-facing provenance block. The engine appends this after
 * whichever prompt builder ran (Discord's or a custom one) so no builder can
 * omit it. Keeps it short and factual: starting commit/branch, worktree
 * cleanliness, any in-progress operation, and whether remote freshness was
 * checked — so the agent cannot assume it's reading the latest default
 * branch when it wasn't. Never tells the agent what to do.
 */
export function formatProvenanceForPrompt(provenance: CheckoutProvenance): string {
  if (provenance.kind === 'unavailable') {
    return [
      '--- Checkout provenance ---',
      'The starting state of this checkout could not be determined (inspection unavailable).',
      describeRemoteFreshnessForPrompt(provenance.remote),
      '--- End checkout provenance ---',
    ].join('\n')
  }

  const {observation, remote} = provenance
  const lines = [
    '--- Checkout provenance ---',
    `Starting commit: ${describeHeadForAgent(observation)}`,
    `Worktree: ${describeWorktreeForAgent(observation)}`,
  ]
  if (observation.operationInProgress !== 'none') {
    lines.push(`Operation in progress: ${observation.operationInProgress}`)
  }
  lines.push(describeRemoteFreshnessForPrompt(remote))
  lines.push('--- End checkout provenance ---')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Human-facing deterministic line — generated by code, never by the model
// ---------------------------------------------------------------------------

/** Length of the abbreviated SHA shown in the human-facing line. */
const SHORT_SHA_LENGTH = 7

/**
 * Renders the plan's exact reply-only wording for a `ready` outcome with a checked remote (Unit 7's
 * reply table: "Provenance line only") — a wholly different sentence shape from the
 * not-checked/unavailable lines below, since a `ready` outcome IS the report (unlike "started
 * from," which describes a point the run may have since diverged from). Uses `remote`'s own
 * `defaultBranch`/`sha`/`fromSha` — never the (possibly stale, possibly absent) `observation` —
 * since this is the freshest evidence preparation has.
 */
function formatCheckedReadyLine(remote: Extract<RemoteFreshness, {kind: 'checked'}>): string {
  const branch = formatBranchForReply(remote.defaultBranch)
  const shortSha = remote.sha.slice(0, SHORT_SHA_LENGTH)
  if (remote.change === 'unchanged') {
    return `The checkout is already at \`${shortSha}\` (branch \`${branch}\`), checked \`${remote.checkedAt}\`.`
  }
  const shortFromSha = remote.fromSha.slice(0, SHORT_SHA_LENGTH)
  return `The checkout advanced from \`${shortFromSha}\` to \`${shortSha}\` (branch \`${branch}\`), checked \`${remote.checkedAt}\`.`
}

/**
 * Build the one-line, deterministic, code-generated provenance line shown to
 * the human on every final reply. Describes the STARTING point only — a run
 * that edits files or switches branches mid-run changes the tree, so this
 * says "started from," never "read." Quiet when nothing is unusual (clean,
 * attached, no operation); noticeable when something is (dirty, detached,
 * mid-operation, or unavailable).
 */
export function formatProvenanceLine(repo: string, provenance: CheckoutProvenance): string {
  if (provenance.kind === 'observed' && provenance.remote.kind === 'checked') {
    return formatCheckedReadyLine(provenance.remote)
  }

  if (provenance.kind === 'unavailable') {
    if (provenance.remote.kind === 'checked') {
      return `Started from \`${repo}\` — starting state unavailable. Remote checked \`${provenance.remote.checkedAt}\`.`
    }
    return `Started from \`${repo}\` — starting state unavailable. Remote freshness not checked.`
  }

  const {observation} = provenance
  const shortSha = observation.head.sha.slice(0, SHORT_SHA_LENGTH)
  const branchPart =
    observation.head.kind === 'attached' ? `on \`${formatBranchForReply(observation.head.branch)}\`` : '(detached HEAD)'

  const notes: string[] =
    observation.worktree.kind === 'clean'
      ? ['clean']
      : [
          `dirty (staged ${observation.worktree.staged}, unstaged ${observation.worktree.unstaged}, ` +
            `untracked ${observation.worktree.untracked}, conflicted ${observation.worktree.conflicted})`,
        ]
  if (observation.operationInProgress !== 'none') {
    notes.push(`${observation.operationInProgress} in progress`)
  }

  return `Started from \`${repo}@${shortSha}\` ${branchPart}, ${notes.join(', ')}. Remote freshness not checked.`
}

/**
 * Build the human-facing provenance line for the one case `formatProvenanceLine`
 * never sees: a checkout `inspect()` found to be a different repository than
 * expected (`checkout-substituted`). Deliberately omits SHA and branch — those
 * would describe the substituted tree, not the expected one, and this line
 * exists precisely because that tree should not be trusted. Distinct from
 * `formatProvenanceLine`'s `unavailable` case, which means "inspection
 * failed" (an availability gap) rather than "the checkout is untrustworthy"
 * (a correctness signal) — the two must not share wording.
 */
export function formatSubstitutedCheckoutLine(repo: string): string {
  return `Started from \`${repo}\` — starting state withheld: checkout is not the expected repository.`
}

// ---------------------------------------------------------------------------
// CheckoutPreparation — persisted record for a REFUSED or FAILED preparation
// attempt (Unit 7 wires the call site; this module only builds the value).
// Unlike CheckoutProvenance, a run carrying this never reached EXECUTING.
// ---------------------------------------------------------------------------

/**
 * Cap on the number of path-like detail entries (`changedPaths`, `submodules`, `disallowedKeys`,
 * `obstructions`) carried into a persisted record — bounds payload size against a pathological
 * count, the same posture as `MAX_BRANCH_DISPLAY_LENGTH` and `MAX_REPOS_PER_LISTING` elsewhere in
 * this codebase. This is JSON persisted for a JSON-consuming operator dashboard, not Markdown
 * rendered on Discord, so no backtick-neutralization is needed here (that is `formatBranchForReply`'s
 * job, for the reply surface only) — only a length/count bound against attacker-influenced content
 * (these paths/config-key names come from an agent-writable checkout).
 */
const MAX_PREPARATION_DETAIL_ENTRIES = 20

/** Per-entry length cap for the detail arrays above — wider than `MAX_BRANCH_DISPLAY_LENGTH` since real repo paths are commonly deeper than a branch name, but still bounded against one pathological entry. */
const MAX_PREPARATION_DETAIL_LENGTH = 200

function capDetailArray(values: readonly string[]): readonly string[] {
  return values.slice(0, MAX_PREPARATION_DETAIL_ENTRIES).map(v => truncateForDisplay(v, MAX_PREPARATION_DETAIL_LENGTH))
}

/**
 * A refused preparation attempt, one variant per `UpdateRefusalReason` — mirrors `UpdateRefused`'s
 * own shape field-for-field, since every field it carries is already bounded, non-sensitive detail
 * (a git ref name, a closed-vocabulary config-key/operation/obstruction-kind string, or a checkout-
 * relative path) needed to tell an operator WHY the run was refused.
 */
export type CheckoutPreparationRefused =
  | {readonly outcome: 'refused'; readonly reason: 'needs-recovery'}
  | {readonly outcome: 'refused'; readonly reason: 'checkout-substituted'}
  | {readonly outcome: 'refused'; readonly reason: 'unsupported-layout'; readonly layoutReason: LayoutRefusalReason}
  | {readonly outcome: 'refused'; readonly reason: 'unsupported-config'; readonly disallowedKeys: readonly string[]}
  | {readonly outcome: 'refused'; readonly reason: 'operation-in-progress'; readonly operation: CheckoutOperation}
  | {readonly outcome: 'refused'; readonly reason: 'dirty'; readonly changedPaths: readonly string[]}
  | {readonly outcome: 'refused'; readonly reason: 'submodule-initialized'; readonly submodules: readonly string[]}
  | {readonly outcome: 'refused'; readonly reason: 'detached'}
  | {readonly outcome: 'refused'; readonly reason: 'non-default-branch'; readonly branch: string}
  | {readonly outcome: 'refused'; readonly reason: 'diverged'}
  | {readonly outcome: 'refused'; readonly reason: 'ahead'}
  | {
      readonly outcome: 'refused'
      readonly reason: 'obstructed'
      readonly obstructions: readonly {readonly path: string; readonly kind: ObstructionKind}[]
    }
  | {readonly outcome: 'refused'; readonly reason: 'maintenance-hold'}

/** A failed preparation attempt — mirrors `UpdateFailed` field-for-field. */
export interface CheckoutPreparationFailed {
  readonly outcome: 'failed'
  readonly reason: UpdateFailureReason
  readonly mutationStarted: boolean | 'possibly'
  readonly permanent: boolean
}

/** What preparation reported for a run that never reached EXECUTING. */
export type CheckoutPreparation = CheckoutPreparationRefused | CheckoutPreparationFailed

/**
 * Builds a `CheckoutPreparation` from a workspace `/update` `refused` or `failed` result. The only
 * constructor — nothing else in this module builds one by hand. Applies the detail caps above to
 * every path-like or key-like array field; every other field is a closed-vocabulary string or
 * primitive already safe to persist as-is.
 */
export function toCheckoutPreparation(result: UpdateRefused | UpdateFailed): CheckoutPreparation {
  if (result.kind === 'failed') {
    return {
      outcome: 'failed',
      reason: result.reason,
      mutationStarted: result.mutationStarted,
      permanent: result.permanent,
    }
  }

  switch (result.reason) {
    case 'needs-recovery':
    case 'checkout-substituted':
    case 'detached':
    case 'diverged':
    case 'ahead':
    case 'maintenance-hold':
      return {outcome: 'refused', reason: result.reason}
    case 'unsupported-layout':
      return {outcome: 'refused', reason: result.reason, layoutReason: result.layoutReason}
    case 'unsupported-config':
      return {outcome: 'refused', reason: result.reason, disallowedKeys: capDetailArray(result.disallowedKeys)}
    case 'operation-in-progress':
      return {outcome: 'refused', reason: result.reason, operation: result.operation}
    case 'dirty':
      return {outcome: 'refused', reason: result.reason, changedPaths: capDetailArray(result.changedPaths)}
    case 'submodule-initialized':
      return {outcome: 'refused', reason: result.reason, submodules: capDetailArray(result.submodules)}
    case 'non-default-branch':
      return {
        outcome: 'refused',
        reason: result.reason,
        branch: truncateForDisplay(result.branch, MAX_BRANCH_DISPLAY_LENGTH),
      }
    case 'obstructed':
      return {
        outcome: 'refused',
        reason: result.reason,
        obstructions: result.obstructions.slice(0, MAX_PREPARATION_DETAIL_ENTRIES).map(o => ({
          path: truncateForDisplay(o.path, MAX_PREPARATION_DETAIL_LENGTH),
          kind: o.kind,
        })),
      }
  }
}
