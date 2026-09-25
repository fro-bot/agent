/**
 * Unit 3 (not implemented yet): checkout admission primitives — layout checks, config inventory,
 * temp-index cleanliness, and the path-obstruction preflight.
 *
 * These are the checks update and recovery run, as AGENT_UID, against an EXISTING agent-owned
 * checkout, before (and, for config inventory, immediately before merging) any mutation. See the
 * plan's "Admission requires a closed configuration profile, not a sanitized one",
 * "Cleanliness is measured against a fresh index built from HEAD", and "Fast-forward with
 * --no-overwrite-ignore, after a path-obstruction preflight" key technical decisions.
 *
 * This module is a STUB: every exported function has a typed signature and a JSDoc contract, but
 * its body throws. The adversarial fixture suite
 * (apps/workspace-agent/src/update-fixtures/*.test.ts) is written against this contract and is
 * expected to fail red until Unit 3 implements it.
 */

import type {GitRunnerFn} from './git-safety.js'

// ---------------------------------------------------------------------------
// Config inventory
// ---------------------------------------------------------------------------

export interface ConfigInventoryOptions {
  readonly checkoutPath: string
  readonly gitRunner?: GitRunnerFn
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
}

export type ConfigInventoryOutcome =
  | {readonly kind: 'allowed'}
  /** Every disallowed key actually found, named so a refusal reply and log line can be specific. */
  | {readonly kind: 'refused'; readonly disallowedKeys: readonly string[]}
  | {readonly kind: 'inspection-failed'}

/**
 * Contract (Unit 3 — not implemented here): inventories `.git/config` with `git config --local
 * --list -z --no-includes` (never following `include.path`/`includeIf` — those keys are
 * themselves refused, not resolved) and refuses unless every key present is a member of the
 * closed allowlist of ordinary-fresh-clone keys (derived from a real `git clone` inside the
 * image, per Unit 2's config-profile fixture — never hardcoded from documentation).
 *
 * Refuses (non-exhaustively — the allowlist is closed, so anything not on it refuses): any
 * `include.*`/`includeIf.*`, any `filter.*`, any `http.*`, any `url.*.insteadOf`, `core.hooksPath`,
 * `core.fsmonitor`, `core.sshCommand`, `core.askPass`, `credential.*`, `protocol.*.allow`, any
 * `extensions.*`, and any sparse-checkout setting.
 */
export async function inventoryCheckoutConfig(_options: ConfigInventoryOptions): Promise<ConfigInventoryOutcome> {
  throw new Error('not implemented: Unit 3')
}

// ---------------------------------------------------------------------------
// Layout checks (metadata attacks)
// ---------------------------------------------------------------------------

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

export type LayoutCheckOutcome =
  | {readonly kind: 'ok'}
  | {readonly kind: 'refused'; readonly reason: LayoutRefusalReason}
  | {readonly kind: 'inspection-failed'}

export interface LayoutCheckOptions {
  readonly checkoutPath: string
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
}

/**
 * Contract (Unit 3 — not implemented here): refuses a checkout whose on-disk layout deviates from
 * an ordinary non-bare, non-worktree-linked clone with a real (non-symlinked) `.git` directory and
 * `.git/config` file, no `core.worktree` relocation, no `objects/info/alternates`, no replace refs
 * (`refs/replace/*` or `core.repositoryFormatVersion`-flagged), no grafts (`info/grafts` or
 * `.git/shallow`-adjacent graft files), no shallow (`.git/shallow` present), and no partial clone
 * (`extensions.partialClone`/promisor remotes).
 *
 * Every check must be performed by inspecting the filesystem and repository metadata directly —
 * NEVER by trusting anything the checkout's own (agent-writable) `.git/config` claims about
 * itself, since that file is exactly what an attack in this class would forge.
 */
export async function checkCheckoutLayout(_options: LayoutCheckOptions): Promise<LayoutCheckOutcome> {
  throw new Error('not implemented: Unit 3')
}

// ---------------------------------------------------------------------------
// Temp-index cleanliness
// ---------------------------------------------------------------------------

export type CleanlinessOutcome =
  | {readonly kind: 'clean'}
  | {readonly kind: 'dirty'; readonly changedPaths: readonly string[]}
  | {readonly kind: 'inspection-failed'}

export interface CleanlinessCheckOptions {
  readonly checkoutPath: string
  readonly headSha: string
  readonly gitRunner?: GitRunnerFn
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
}

/**
 * Contract (Unit 3 — not implemented here): builds a TEMPORARY index — `GIT_INDEX_FILE` pointed
 * at a freshly created path, never `.git/index` — populated from `headSha` via `git read-tree`,
 * then compares it against the real working tree (tracked-file content and untracked/ignored
 * presence, per the eligibility definition of "dirty").
 *
 * The checkout's own (agent-writable) `.git/index` — including any assume-unchanged,
 * skip-worktree, split-index, sparse-index, or manipulated stat-cache bits it carries — is NEVER
 * consulted for this decision; only the temporary index built fresh from `headSha` is.
 */
export async function checkTempIndexCleanliness(_options: CleanlinessCheckOptions): Promise<CleanlinessOutcome> {
  throw new Error('not implemented: Unit 3')
}

// ---------------------------------------------------------------------------
// Path-obstruction preflight
// ---------------------------------------------------------------------------

export type ObstructionKind = 'exact-conflict' | 'prefix-conflict' | 'identical-content' | 'symlink-ancestor'

export interface Obstruction {
  /** Repo-relative (never absolute, never checkout-path-prefixed), matching git's own path conventions (e.g. as reported by `git status`/`git ls-tree`). */
  readonly path: string
  readonly kind: ObstructionKind
}

export type ObstructionPreflightOutcome =
  | {readonly kind: 'clear'}
  | {readonly kind: 'obstructed'; readonly obstructions: readonly Obstruction[]}
  | {readonly kind: 'inspection-failed'}

export interface ObstructionPreflightOptions {
  readonly checkoutPath: string
  readonly fromSha: string
  readonly toSha: string
  readonly gitRunner?: GitRunnerFn
  readonly timeoutMs: number
  readonly uid?: number
  readonly gid?: number
}

/**
 * Contract (Unit 3 — not implemented here): compares the `fromSha` and `toSha` trees against the
 * live filesystem in BOTH prefix directions — an incoming file `a` against an existing directory
 * `a/b`, and an incoming directory `a/b` against an existing file `a` — and reports every
 * untracked/ignored obstruction, exact-path conflict, identical-content obstruction, and symlink
 * ancestor found.
 *
 * Must run, and refuse on any obstruction, BEFORE any mutation — never delegated to `git merge
 * --ff-only`'s own overwrite behaviour, which silently overwrites ignored files that obstruct
 * incoming paths (the exact gap `--no-overwrite-ignore` alone does not close for every obstruction
 * shape — see Unit 2's collisions fixtures).
 */
export async function preflightObstructions(
  _options: ObstructionPreflightOptions,
): Promise<ObstructionPreflightOutcome> {
  throw new Error('not implemented: Unit 3')
}
