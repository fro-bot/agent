/**
 * Redaction and authorization obligation clauses for the operator API contract.
 *
 * This module embeds the metadata/repos.yaml redaction obligation and the authorization obligation
 * as normative contract clauses bound to OPERATOR_CONTRACT_VERSION.
 *
 * Cross-reference: fro-bot/dashboard docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md
 * — the dashboard's reference implementation of the same invariant. The gateway mirrors the
 * dashboard's denylist-before-query posture; this module is the agent-side authority.
 */

// ---------------------------------------------------------------------------
// REDACTION_OBLIGATION — normative clause for the repo redaction invariant
// ---------------------------------------------------------------------------

/**
 * Normative redaction obligation for the operator API contract.
 *
 * Any endpoint or projection that surfaces repo data or OperatorRunStatus records
 * MUST satisfy all four operational rules stated here before exposing any result.
 *
 * Four operational rules:
 *
 * (a) denylist-before-query: exclude redacted repos BEFORE any per-repo query
 *     (binding lookups, run-state reads, status/mission projections). Render-time
 *     filtering is too late — the pre-query gate is the only safe enforcement point.
 *
 * (b) format-stable deny keys: handle node_id format skew (MDEw… vs R_kgDO…
 *     base64 variants); derive numeric database_id for stable matching. Exact-string
 *     matching on node_id alone is insufficient and will produce false negatives.
 *
 * (c) fail-closed: a redacted entry with no usable deny key, or an unreadable
 *     denylist, MUST DENY — never return an unfiltered union. When in doubt, omit.
 *
 * (d) composes alongside checkRepoAuthz (packages/gateway/src/web/auth/repo-authz.ts),
 *     NOT instead of: checkRepoAuthz proves the operator MAY see a repo; redaction
 *     proves the repo IS NOT hidden by policy. BOTH must pass before repo data is
 *     surfaced. The two gates cannot silently diverge.
 *
 * Scope: this obligation applies to OperatorRunStatus projections (the entity_ref
 * leak path) as well as to direct repo-data queries. An OperatorRunStatus record
 * for a denylisted repo MUST be omitted (null), not returned with a populated entityRef.
 */
export const REDACTION_OBLIGATION: string =
  'Redaction obligation (operator contract v1.1.0): ' +
  '(a) denylist-before-query — exclude redacted repos BEFORE any per-repo query ' +
  '(binding lookups, run-state reads, OperatorRunStatus projections); render-time filtering is too late. ' +
  '(b) format-stable deny keys — handle node_id format skew (MDEw… vs R_kgDO… base64 variants); ' +
  'derive numeric database_id for stable matching; exact-string matching on node_id alone is insufficient. ' +
  '(c) fail-closed — a redacted entry with no usable deny key, or an unreadable denylist, MUST DENY; ' +
  'never return an unfiltered union. ' +
  '(d) composes alongside checkRepoAuthz (web/auth/repo-authz.ts), NOT instead of: ' +
  'checkRepoAuthz proves the operator MAY see a repo; redaction proves the repo IS NOT hidden by policy; ' +
  'BOTH must pass. The two gates cannot silently diverge. ' +
  'Cross-reference: fro-bot/dashboard docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md'

// ---------------------------------------------------------------------------
// assertRedactionApplied — real gate guard
// ---------------------------------------------------------------------------

/**
 * Context passed to assertRedactionApplied.
 *
 * The caller resolves the denylist check (via the gateway bridge / surface-gate)
 * and passes the result here. The function does NOT receive repo identity (owner/repo)
 * — structural no-oracle: it cannot echo what it does not receive.
 */
export interface RedactionContext {
  /**
   * The result of the denylist check for this repo.
   * true = repo is denied (on the denylist or no usable deny key — fail closed).
   * false = repo passed the denylist check and may be surfaced.
   */
  readonly isDenied: boolean
}

/**
 * Redaction gate guard — asserts that the denylist check ran and the repo is allowed.
 *
 * Call this at every repo-data surface point after running the denylist predicate.
 * It throws if called with a denied repo, making the "surfaced a denied repo" state
 * a hard runtime error rather than a silent data leak.
 *
 * Contract:
 * - `isDenied = false` → no-op (redaction ran, repo is allowed, proceed).
 * - `isDenied = true`  → throws REDACTION_OBLIGATION_VIOLATED (surfacing a denied
 *   repo is a contract violation; the caller must not reach this point for denied repos).
 *
 * Structural no-oracle: this function does NOT accept owner/repo — it cannot echo
 * repo identity in error messages. The caller must not pass repo identity here.
 *
 * Grepable: search for `assertRedactionApplied` to find every call site.
 * Auditable: the call site is visible in code review.
 *
 * @param context - The result of the denylist check.
 * @throws {Error} When `context.isDenied === true` — surfacing a denied repo is a
 *   contract violation.
 */
export function assertRedactionApplied(context: RedactionContext): void {
  if (context.isDenied === true) {
    throw new Error(
      'REDACTION_OBLIGATION_VIOLATED: attempted to surface a repo that failed the denylist check. ' +
        'The caller must apply the denylist gate (via the surface-gate bridge) and omit denied repos ' +
        'before reaching this point. See REDACTION_OBLIGATION for the four operational rules.',
    )
  }
}

// ---------------------------------------------------------------------------
// AUTHORIZATION_OBLIGATION — normative clause for operator decision/launch authz
// ---------------------------------------------------------------------------

/**
 * Normative authorization obligation for the operator API contract.
 *
 * Any operator decision or launch MUST satisfy all constraints stated here.
 *
 * Core rule: an operator decision/launch MUST carry a transport-bound OperatorIdentity
 * and DecisionInput (no free-form decidedBy: string). The contract cannot bypass the
 * fail-closed approval gate. registry.handleDecision is the sole approval gate — all
 * transports (Discord, web) settle through it; no transport may implement a parallel
 * settlement path.
 *
 * Two documented security constraints:
 *
 * (1) Version not over the wire: OPERATOR_CONTRACT_VERSION is build-time pinned and
 *     never negotiated over the wire. Any endpoint reading a version header MUST reject
 *     unrecognized versions fail-closed. A client cannot downgrade the contract version
 *     by supplying a version value in a request header or body.
 *
 * (2) Identity server-constructed: OperatorIdentity is always constructed server-side
 *     from the authenticated session. It is NEVER deserialized from a request payload.
 *     A request body claiming to carry an OperatorIdentity must be rejected; the
 *     identity is derived from the session established by the auth flow, not from
 *     untrusted client input.
 */
export const AUTHORIZATION_OBLIGATION: string =
  'Authorization obligation (operator contract v1.1.0): ' +
  'An operator decision/launch MUST carry a transport-bound OperatorIdentity and DecisionInput ' +
  '(no free-form decidedBy: string). The contract cannot bypass the fail-closed approval gate. ' +
  'registry.handleDecision is the sole approval gate — all transports settle through it; ' +
  'no transport may implement a parallel settlement path. ' +
  'Constraint (1) version-not-over-wire: OPERATOR_CONTRACT_VERSION is build-time pinned and never ' +
  'negotiated over the wire; any endpoint reading a version header MUST reject unrecognized versions ' +
  'fail-closed; a client cannot downgrade the contract version via a request header or body. ' +
  'Constraint (2) identity-server-constructed: OperatorIdentity is always constructed server-side ' +
  'from the authenticated session and is NEVER deserialized from a request payload; ' +
  'a request body claiming to carry an OperatorIdentity must be rejected.'
