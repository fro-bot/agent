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

import type {CheckoutObservation, InspectErrorCode, InspectWorkspaceError} from '../workspace-api/types.js'

// ---------------------------------------------------------------------------
// RemoteFreshness — explicit "not checked" today, extensible tomorrow
// ---------------------------------------------------------------------------

/** Whether the run checked the remote for commits ahead of the local checkout. PR 1 never does. */
export interface RemoteFreshness {
  readonly kind: 'not-checked'
}

/** Singleton — PR 1 has exactly one `RemoteFreshness` value. */
export const REMOTE_FRESHNESS_NOT_CHECKED: RemoteFreshness = {kind: 'not-checked'}

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
function formatBranchForReply(branch: string): string {
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
 * Build the agent-facing provenance block. The engine appends this after
 * whichever prompt builder ran (Discord's or a custom one) so no builder can
 * omit it. Keeps it short and factual: starting commit/branch, worktree
 * cleanliness, any in-progress operation, and that remote freshness was not
 * checked — so the agent cannot assume it's reading the latest default
 * branch. Never tells the agent what to do.
 */
export function formatProvenanceForPrompt(provenance: CheckoutProvenance): string {
  if (provenance.kind === 'unavailable') {
    return [
      '--- Checkout provenance ---',
      'The starting state of this checkout could not be determined (inspection unavailable).',
      'Remote freshness was not checked.',
      '--- End checkout provenance ---',
    ].join('\n')
  }

  const {observation} = provenance
  const lines = [
    '--- Checkout provenance ---',
    `Starting commit: ${describeHeadForAgent(observation)}`,
    `Worktree: ${describeWorktreeForAgent(observation)}`,
  ]
  if (observation.operationInProgress !== 'none') {
    lines.push(`Operation in progress: ${observation.operationInProgress}`)
  }
  lines.push('Remote freshness was not checked — do not assume this is the latest default branch.')
  lines.push('--- End checkout provenance ---')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Human-facing deterministic line — generated by code, never by the model
// ---------------------------------------------------------------------------

/** Length of the abbreviated SHA shown in the human-facing line. */
const SHORT_SHA_LENGTH = 7

/**
 * Build the one-line, deterministic, code-generated provenance line shown to
 * the human on every final reply. Describes the STARTING point only — a run
 * that edits files or switches branches mid-run changes the tree, so this
 * says "started from," never "read." Quiet when nothing is unusual (clean,
 * attached, no operation); noticeable when something is (dirty, detached,
 * mid-operation, or unavailable).
 */
export function formatProvenanceLine(repo: string, provenance: CheckoutProvenance): string {
  if (provenance.kind === 'unavailable') {
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
