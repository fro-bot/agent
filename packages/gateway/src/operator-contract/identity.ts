/**
 * Canonical operator identity for the web control surface.
 *
 * `OperatorIdentity` is the single structural definer of the
 * `{kind:'web-operator', githubUserId, login, sessionCorrelationId}` shape.
 * All other gateway types that carry this shape (`WebOperatorActor`,
 * `WebOperatorIdentity`) are type aliases that point here — they are NOT
 * independent declarations.
 *
 * Discriminated on `kind: 'web-operator'` so future operator variants
 * (e.g. `kind: 'api-key-operator'`) can extend the union without forking
 * the existing shape.
 */
export interface OperatorIdentity {
  readonly kind: 'web-operator'
  /**
   * Stable GitHub numeric user ID (from the GitHub API `id` field).
   * Used for authorization, audit, and idempotency key scoping.
   * Prefer this over `login` for any access-control or audit decision.
   */
  readonly githubUserId: number
  /**
   * GitHub display login (e.g. `'octocat'`).
   * Mutable — use only for human-readable logs and display metadata.
   * Never use for authorization or audit identity.
   */
  readonly login: string
  /**
   * Opaque session correlation value for log correlation.
   * Not used for authorization — use `githubUserId` instead.
   */
  readonly sessionCorrelationId: string
}
