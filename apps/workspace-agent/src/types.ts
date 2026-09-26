/**
 * Request/response types for the workspace-agent HTTP service.
 *
 * These types define the contract between the gateway (PR D workspace-api client)
 * and the workspace-agent server. The gateway MUST import from
 * `packages/gateway/src/workspace-api/types.ts`, whose types are wire-compatible with these
 * (some intentionally narrower for stricter consumer-side checking).
 *
 * SECURITY: `repoPath` is NOT in CloneRequest. The agent derives the path internally.
 * The caller never controls where the repo is cloned.
 */

import type {LayoutRefusalReason, Obstruction} from './checkout-profile.js'

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
   * The post-clone ownership handoff (handoff.ts) failed — a deterministic failure: the same
   * staged tree fails the same way on every retry (a hardlink, a filesystem-boundary crossing,
   * an unsupported node type, or the handoff's own deadline/entry cap). Never `clone-timeout`
   * (reserved for `git clone` itself timing out) and never `too-many-files` (reserved for an
   * EMFILE from git) — those are gateway-classified as transient/operator-environment issues,
   * not "this repository can never be handed off". The specific reason
   * (`'hardlink' | 'foreign-filesystem' | 'unsupported-entry' | 'deadline-exceeded' | 'max-entries'`,
   * see handoff.ts `HandoffFailureReason`) is carried in `CloneFailure.code`.
   */
  | 'checkout-handoff-failed'
  /**
   * A journal (journal.ts) already exists for this repository — an update or recovery mutation
   * was interrupted (or is still in flight) and left state that clone must not silently clone
   * over. NOT deterministic in the same sense as `checkout-handoff-failed`: once the outstanding
   * journal is resolved (by `/update` or `/recover` in later units, or by an operator running
   * `/fro-bot recover-checkout`), a retried clone can succeed. The gateway does not yet special-
   * case this code (see `packages/gateway/src/workspace-api/client.ts`'s `CLONE_ERROR_CODES` and
   * `packages/gateway/src/execute/run.ts`'s `PERMANENT_CLONE_ERROR_CODES`) — until it does, it
   * falls through `classifyEnsureCloneFailure` to the default `'unreachable'` bucket, which invites
   * a retry rather than pointing at recovery. Track updating that classification alongside Unit 4
   * (`/update`) or Unit 7 (preparation in the run path).
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

/** POST /inspect success response. */
export interface InspectSuccess {
  readonly ok: true
  readonly observation: CheckoutObservation
}

/** POST /inspect error response. */
export interface InspectFailure {
  readonly ok: false
  readonly error: InspectErrorCode
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

/** POST /update request body. */
export interface UpdateRequest {
  readonly owner: string
  readonly repo: string
  /** Installation access token (ghs_*). Used only by the network half; never logged. */
  readonly token: string
}

/** How the checkout's branch tip changed (or didn't) as a result of this update. */
export type UpdateChangeKind = 'fast-forward' | 'unchanged'

/**
 * The checkout was already eligible and is now current — unchanged, or fast-forwarded to the
 * remote tip. Carries CHECKED remote evidence; a `ready` result is never produced from an
 * unchecked or cached observation.
 */
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

/**
 * Every reason `/update` can refuse to run for, closed and final — see the plan's Unit 2 "Policy"
 * fixtures for why classifying `detached`/`non-default-branch`/`diverged`/`ahead`/`obstructed` is
 * update.ts's job, not checkout-profile.ts's.
 */
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
  /**
   * This repository is under a sticky, in-process maintenance hold (repo-mutex.ts's
   * `markRepoHeld`/`repoHoldReason`) — some earlier `/update` (or `/clone`) ended with an
   * UNCONFIRMED subprocess termination, so the service cannot rule out a leaked process still
   * touching this repository's on-disk state. Checked FIRST, before journal reconciliation —
   * before anything else — and cleared only by a process restart.
   */
  | 'maintenance-hold'

/**
 * The checkout is ineligible; no mutation was ever attempted, and NO network profile was ever
 * built or spawned reaching this result — every admission check runs entirely local-only, as
 * AGENT_UID. Discriminated by `reason`, each carrying exactly the detail its refusal reply needs.
 */
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

/**
 * Every reason `/update` can fail for, closed. Fetch-phase reasons (`fetch-*`, `remote-moved`)
 * always carry `mutationStarted: false` — nothing in the checkout was ever touched, and the
 * journal (if any exists yet at that point) is cleared. `apply-failed`'s `mutationStarted` and
 * journal disposition depend on whether the fast-forward merge command itself had already been
 * spawned — see that reason's own doc comment. `termination-unconfirmed` always leaves the journal
 * at `applying` UNLESS it happened before the journal ever reached `applying` in the first place
 * (a network-phase git call whose termination could not be confirmed) — in that earlier case there
 * is no `applying` journal to leave behind, and `mutationStarted` is `false`; the repository is
 * placed under a maintenance hold either way (repo-mutex.ts's `markRepoHeld`), since an unconfirmed
 * termination means a leaked process may still be running regardless of which phase it happened in.
 */
export type UpdateFailureReason =
  /**
   * The client's `AbortSignal` fired before the apply phase began (checked only up through the
   * fetch phase — once the journal records `applying`, the mutation runs to completion or
   * confirmed termination regardless of a later disconnect).
   */
  | 'aborted'
  /**
   * A local admission check could not determine an answer (a git subprocess timed out, its
   * termination went unconfirmed, or it returned something this module can't parse) and failed
   * closed rather than guessing.
   */
  | 'inspection-failed'
  /** The remote rejected the credential (401, or an auth challenge never satisfied). Not permanent — a fresh token may succeed. */
  | 'fetch-auth-rejected'
  /** The remote reported 404 — explicit positive evidence the repository doesn't exist (or isn't visible to this token). Permanent. */
  | 'fetch-not-found'
  /** The remote reported 403 — explicit positive evidence access is denied. Permanent. */
  | 'fetch-forbidden'
  /** The remote reported 429. Not permanent — expected to clear. */
  | 'fetch-rate-limited'
  /** The remote host could not be reached (connection refused, DNS failure, TLS failure). Not permanent. */
  | 'fetch-unreachable'
  /** The fetch phase (ls-remote or fetch) did not complete within the network budget. Not permanent. */
  | 'fetch-timeout'
  /** A fetch-phase git invocation failed for a reason this module's classifier doesn't recognize. Not permanent — unclassified failures are never assumed permanent. */
  | 'fetch-failed'
  /** The remote's default-branch tip moved between observations, twice in a row (the one retry was exhausted). Not permanent. */
  | 'remote-moved'
  /**
   * A CONFIRMED (non-zero exit, or a positively-detected mismatch — never an unconfirmed
   * termination, which is always reported as `termination-unconfirmed` instead) failure somewhere
   * in the apply phase. `mutationStarted` depends on exactly WHERE: the object import and every
   * pre-merge re-admission re-check (layout, config, cleanliness, submodules, re-observed
   * head/branch/operation state) run before the fast-forward merge itself is ever spawned — the
   * checkout's refs, HEAD, and working tree are untouched at that point (the import is additive-
   * only), so those report `mutationStarted: false` and the journal is cleared. Once the merge
   * command has actually been spawned, any subsequent confirmed failure (a non-zero exit, or a
   * post-merge verification mismatch — branch, HEAD SHA, or working-tree cleanliness against the
   * target) reports `mutationStarted: true` and the journal stays at `applying` for recovery.
   */
  | 'apply-failed'
  /**
   * A pack-stream or merge subprocess's termination could not be CONFIRMED (mirrors
   * `PackStreamOutcome`'s/`GitOutcome`'s own `termination-unconfirmed`). `mutationStarted:
   * 'possibly'` — never a synonym for `true`.
   */
  | 'termination-unconfirmed'

/**
 * An attempt was made and did not succeed. `mutationStarted` is `'possibly'` only when subprocess
 * termination itself went unconfirmed — never a synonym for `true`.
 */
export interface UpdateFailed {
  readonly kind: 'failed'
  readonly reason: UpdateFailureReason
  readonly mutationStarted: boolean | 'possibly'
  readonly permanent: boolean
}

/**
 * No checkout exists at this repository's path, and no journal is in flight for it either — the
 * gateway should clone, not update.
 */
export interface UpdateNoCheckout {
  readonly kind: 'no-checkout'
}

/** The discriminated result of a `/update` attempt. Never flags — exactly one of these four shapes. */
export type UpdateResult = UpdateReady | UpdateRefused | UpdateFailed | UpdateNoCheckout

/**
 * POST /update validation failure — an HTTP-layer request-shape problem (oversized body,
 * unparseable JSON, an invalid owner/repo/token) caught BEFORE `executeUpdate` is ever called.
 * Deliberately a separate, `ok`-discriminated shape from `UpdateResult`: `UpdateResult`'s
 * `refused`/`failed` variants are the DOMAIN outcome of a well-formed request `executeUpdate`
 * actually attempted, and carry no HTTP-layer-only reasons (`malformed-body`, `body-too-large`,
 * ...) in their closed unions.
 */
export interface UpdateValidationFailure {
  readonly ok: false
  readonly error: 'malformed-body' | 'body-too-large' | 'invalid-owner' | 'invalid-repo' | 'invalid-token-shape'
}

/** GET /healthz response. */
export interface HealthzResponse {
  readonly ok: true
  /** OpenCode server readiness. Present when the server lifecycle is managed. */
  readonly opencode?: 'ready' | 'starting' | 'down' | 'degraded'
}

/** GET /readyz response. */
export interface ReadyzResponse {
  readonly ready: boolean
  /**
   * OpenCode server readiness. 'unknown' when no status ref is available.
   * 'degraded' = retries exhausted, clone API still alive, /readyz returns 503.
   */
  readonly opencode: 'ready' | 'starting' | 'down' | 'degraded' | 'unknown'
}
