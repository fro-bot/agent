/**
 * Redaction and authorization obligation clauses for the operator API contract.
 *
 * This module embeds the #950 redaction obligation and the authorization obligation
 * as normative contract clauses bound to OPERATOR_CONTRACT_VERSION.
 *
 * It does NOT implement the redaction gate itself. The gate ships with the first
 * repo-data endpoint that needs it. This module provides:
 *   - REDACTION_OBLIGATION: the normative clause stating the four operational rules.
 *   - assertRedactionApplied: a fail-closed structural stub that throws by default,
 *     making the obligation grepable and unskippable.
 *   - AUTHORIZATION_OBLIGATION: the normative clause for operator decision/launch
 *     authorization, including the two documented security constraints.
 */

// ---------------------------------------------------------------------------
// REDACTION_OBLIGATION — normative clause for the #950 redaction invariant
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
  'Redaction obligation (operator contract v1.0.0): ' +
  '(a) denylist-before-query — exclude redacted repos BEFORE any per-repo query ' +
  '(binding lookups, run-state reads, OperatorRunStatus projections); render-time filtering is too late. ' +
  '(b) format-stable deny keys — handle node_id format skew (MDEw… vs R_kgDO… base64 variants); ' +
  'derive numeric database_id for stable matching; exact-string matching on node_id alone is insufficient. ' +
  '(c) fail-closed — a redacted entry with no usable deny key, or an unreadable denylist, MUST DENY; ' +
  'never return an unfiltered union. ' +
  '(d) composes alongside checkRepoAuthz (web/auth/repo-authz.ts), NOT instead of: ' +
  'checkRepoAuthz proves the operator MAY see a repo; redaction proves the repo IS NOT hidden by policy; ' +
  'BOTH must pass. The two gates cannot silently diverge.'

// ---------------------------------------------------------------------------
// assertRedactionApplied — fail-closed structural stub
// ---------------------------------------------------------------------------

/**
 * Context passed to assertRedactionApplied.
 *
 * The first repo-data endpoint MUST replace the stub body with the real
 * denylist-before-query gate, accepting this context (or a superset of it)
 * to perform the actual redaction check.
 */
export interface RedactionContext {
  /** The repo reference being accessed, e.g. 'owner/repo'. */
  readonly repoRef: string
}

/**
 * Fail-closed redaction stub — deliberately throws by default.
 *
 * This is a structural enforcement point, not a no-op placeholder. Its body
 * throws `REDACTION_GATE_NOT_IMPLEMENTED` so that any response path that
 * surfaces repo data without calling this function (or its real replacement)
 * crashes at runtime. This makes the redaction obligation:
 *   - Grepable: search for `assertRedactionApplied` to find every call site.
 *   - Unskippable: a response path that omits the call throws in production.
 *   - Auditable: the call site is visible in code review.
 *
 * The first repo-data endpoint MUST replace this stub's body with the real
 * denylist-before-query gate (bound alongside checkRepoAuthz). Until then,
 * calling this function always throws.
 *
 * The real gate implementation is deferred to the #950 follow-up task.
 *
 * @param context - The repo reference being accessed.
 * @throws {Error} Always — until the real gate replaces this stub body.
 */
export function assertRedactionApplied(context: RedactionContext): void {
  throw new Error(
    `REDACTION_GATE_NOT_IMPLEMENTED: redaction check not yet implemented for repo '${context.repoRef}'. ` +
      `The first repo-data endpoint must replace this stub with the real denylist-before-query gate ` +
      `(bound alongside checkRepoAuthz). See REDACTION_OBLIGATION for the four operational rules.`,
  )
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
  'Authorization obligation (operator contract v1.0.0): ' +
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
