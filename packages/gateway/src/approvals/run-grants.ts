/**
 * Run-local approval grants: what an operator's "Always" means in the gateway.
 *
 * ### Why this exists
 *
 * Upstream OpenCode stores an `always` reply beyond the run that earned it:
 * - V2 writes a saved-permission row keyed by PROJECT (the repo's root commit), with no session or run scope. Every
 *   later ask in that project matches it until the spawn database is wiped (`rm -rf x` saves `rm *`; an edit saves `*`).
 * - V1 appends to an in-memory `approved` list keyed by DIRECTORY.
 *
 * The operator contract promises "for the rest of this run". So the gateway NEVER sends `always` upstream
 * ({@link replyUpstream}); it keeps the grant itself, in memory, for the life of one run ({@link createRunGrants}),
 * and answers later matching asks from that run with a plain `once`.
 *
 * ### What a grant is
 *
 * The ask's own "save" patterns, taken from the ask as upstream delivered it: `save` on a V2 `permission.asked`,
 * `always` on a V1 one (both end up in {@link PermissionRequest.alwaysPatterns}). Upstream would have stored exactly
 * these, keyed by the ask's action/permission, so that is what the run keeps. An ask with none stores nothing, as it
 * would have upstream.
 *
 * ### Matching
 *
 * {@link wildcardMatch} is a local copy of upstream's `Wildcard.match`, because the gateway cannot import upstream. A
 * grant covers an ask when the ask's action matches the grant's action AND every one of the ask's resources matches
 * one of the grant's patterns (upstream's `evaluate`: `Wildcard.match(action, rule.action) && Wildcard.match(resource,
 * rule.resource)`, with every resource needing an allow). A partial match still asks. A configured `deny` still wins
 * because upstream evaluates it before asking: the gateway only ever sees asks upstream actually sent.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PostReplyFactory} from '../execute/launch-types.js'
import type {PermissionReply, PermissionRequest} from './coordinator.js'

import process from 'node:process'

/**
 * Source of truth: `Wildcard.match` in
 * - OpenCode V2 v2.2.0 `packages/core/src/util/wildcard.ts`, and
 * - OpenCode V1 1.19.4 `packages/core/src/util/wildcard.ts` (what V1's `permission/index.ts` imports).
 *
 * The two bodies are byte-identical. (V1 also carries an older, unrelated `packages/opencode/src/util/wildcard.ts` that
 * adds `if (str)` / `if (pattern)` guards before the same replace chain; the permission code does not use it, and for
 * the non-empty strings the gateway matches the results are the same.) Keep this in step with them and with the parity
 * table in `run-grants.test.ts`, whose expected values were produced by running the upstream function.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  let escaped = pattern
    .replaceAll('\\', '/')
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.')

  // A trailing " *" makes the tail optional, so "ls *" matches both "ls" and "ls -la".
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`

  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'si' : 's').test(normalized)
}

/**
 * The decision that goes upstream for an operator decision: `always` becomes `once`, so upstream never stores a grant.
 * Both generations' reply paths run every decision through this.
 */
export function replyUpstream(decision: PermissionReply): PermissionReply {
  return decision === 'always' ? 'once' : decision
}

/** One stored grant: the ask's action and the patterns an `always` on it would have saved. */
interface Grant {
  readonly permission: string
  readonly patterns: readonly string[]
}

/** The grants of ONE run. In memory only; there is no way to read them out and no way to outlive {@link drop}. */
export interface RunGrants {
  /** Remember an ask, so an `always` reply on it can later be turned into a grant. No-op once dropped. */
  readonly noteAsked: (request: PermissionRequest) => void
  /** The operator's `always` on `requestID` landed: store that ask's patterns as a grant. No-op once dropped. */
  readonly grant: (requestID: string) => void
  /** `true` when a stored grant covers the ask: same action, every resource matched. Nothing is stored once dropped. */
  readonly covers: (request: PermissionRequest) => boolean
  /** End of the run: forget every grant and every remembered ask, and refuse new ones. Idempotent. */
  readonly drop: () => void
  readonly isDropped: () => boolean
}

export function createRunGrants(deps: {readonly logger: GatewayLogger; readonly runId: string}): RunGrants {
  const {logger, runId} = deps
  const asked = new Map<string, Grant>()
  let grants: Grant[] = []
  let dropped = false

  function noteAsked(request: PermissionRequest): void {
    if (dropped) return
    asked.set(request.requestID, {permission: request.permission, patterns: request.alwaysPatterns ?? []})
  }

  function grant(requestID: string): void {
    // Nothing is remembered once dropped (`noteAsked` refuses, `drop` clears), so a late grant finds nothing.
    const pending = asked.get(requestID)
    if (pending === undefined || pending.patterns.length === 0) return
    grants.push(pending)
    logger.info({runId, permission: pending.permission}, 'approvals: operator Always kept as a run-local grant')
  }

  function covers(request: PermissionRequest): boolean {
    if (request.patterns.length === 0) return false
    return request.patterns.every(resource =>
      grants.some(
        stored =>
          wildcardMatch(request.permission, stored.permission) &&
          stored.patterns.some(pattern => wildcardMatch(resource, pattern)),
      ),
    )
  }

  function drop(): void {
    dropped = true
    grants = []
    asked.clear()
  }

  return {noteAsked, grant, covers, drop, isDropped: () => dropped}
}

/**
 * Wrap a reply factory so an operator `always` becomes a run-local grant once its reply has landed.
 *
 * The wrapped factory still passes `always` down: the generation's own factory downgrades it with
 * {@link replyUpstream}, so no layer on the way can leak it upstream. A failed reply stores nothing (the operator can
 * retry), and a grant that lands after the run's set was dropped is discarded by {@link RunGrants.grant}.
 */
export function scopeAlwaysToRun(inner: PostReplyFactory, grants: RunGrants): PostReplyFactory {
  return sessionId => {
    const post = inner(sessionId)
    return async (requestId, directory, decision) => {
      const result = await post(requestId, directory, decision)
      if (decision === 'always' && result.ok) grants.grant(requestId)
      return result
    }
  }
}
