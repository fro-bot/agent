---
title: "feat: Durable operator sessions with bindings-only repo authorization"
type: feat
status: active
date: 2026-10-17
---

# feat: Durable operator sessions with bindings-only repo authorization

## Overview

A gateway redeploy logs the operator out today. Sessions live in a process-local map with an 8-hour absolute and a 30-minute idle lifetime, so the installed dashboard asks for a GitHub sign-in after every deploy and most idle gaps.

This plan makes sessions survive a restart for up to 7 days. Each session is one signed object in the existing object store. The in-memory map stays authoritative, and the object is a write-through copy that the gateway reloads at startup.

Durable sessions cannot carry the GitHub user OAuth token. Persisting a credential is not acceptable. So the token is dropped, and repository authorization stops asking GitHub. A route now allows a request when the operator is on the allowlist, the repository is bound, and the repository is not on the redaction denylist. Dropping the GitHub check makes the binding the trust anchor, so the plan also restricts who can create bindings. The gateway has exactly one operator, so one predicate covers reads and writes.

---

## Problem Frame

Issue #1837. `createInMemorySessionStore` (`packages/gateway/src/web/auth/session.ts`) keeps each entry in a `Map`, including the operator's OAuth token. Ten routes and the run-stream lease use that token to call `GET /repos/{owner}/{repo}` through `packages/gateway/src/web/auth/repo-authz.ts`. A restart loses every session. The token cannot be written out to fix that.

The GitHub check adds a network round trip, a rate-limit surface and a write-level permission probe, and it fails when the token expires. Removing it is only safe if a binding means something. Today the only code path that creates a binding is Discord `/add-project` (`packages/gateway/src/discord/commands/add-project.ts`), and it is gated by guild-level `ManageChannels` and by what the GitHub App installation can reach. That is not an allowlist of people. This plan adds one.

The gateway has one operator. This work adds no per-recipient authorization and no multi-operator gating.

---

## Requirements Trace

**Session lifetime and storage**

- R1. A session survives a gateway restart. Its lifetime is a fixed 7 days from login. Idle time does not shorten it and no request extends it.
- R2. A stored session record holds `githubUserId`, `login`, `issuedAt`, a status, and an integrity MAC. It holds no OAuth token, no raw session ID and no last-access time. The object key is `operator-web/sessions/<sha256 of the session ID>.json`, built in one place.
- R3. Every record carries an HMAC over its canonical body and its key hash. The MAC key is derived from `GATEWAY_OPERATOR_CSRF_SECRET` with HKDF and a distinct label, and is never the CSRF signing key. Load drops records that fail the MAC, that are dated in the future beyond a small skew, or that are older than the absolute TTL.
- R4. The OAuth token is used for `GET /user` and then discarded. It is never stored or logged.
- R5. Login fails closed. If the session cap is reached, the durable write fails, or the store is not ready, login returns 503 with `Retry-After` and mints no session. An existing session is left untouched.

**Revocation**

- R6. Logout writes durably first. A 200 means the revoke is durable. Only after the durable write succeeds does the session revoke in memory, the hook fire and the cookie clear. A final failure returns 503 with `Retry-After` and leaves the session valid.
- R7. One store-level hook, `onSessionRevoked(githubUserId)`, fires once per revocation, including for restored sessions. TTL expiry does not fire it. At load, push deactivation is replayed for users whose logout or revoke is stored but who have no live session.
- R8. Every login issues a new session ID. A same-user re-login rotates the old session without firing the hook. A different-user login revokes the old session and fires it. If rotation cannot be made durable, login fails with 503 and the old session stays.
- R9. Rotating `GATEWAY_OPERATOR_CSRF_SECRET` and redeploying invalidates every stored session at the next load.

**Restore and retention**

- R10. At startup the gateway runs a self-test and loads every stored session before the operator server is built. It drops expired, revoked, non-allowlisted, MAC-failing and future-dated records, enforces the cap, and durably revokes records the cap dropped. An unknown session ID is a map miss with no I/O.
- R11. If the self-test or the load fails, the store is not ready and `create` returns 503 until the gateway restarts.
- R12. A periodic sweep deletes records past the absolute TTL. A record is retained for at most 7 days plus one sweep interval.

**Authorization**

- R13. Only configured Discord users can create bindings. An empty or unset binder list fails closed at `/add-project`.
- R14. All ten routes and the run-stream lease authorize through one helper, `resolveRepoAccess`. It returns `allowed`, `denied` or `unavailable` from a single binding read and fails closed on anything but `allowed`. Reads and writes use the same predicate.
- R15. The lease re-checks session, allowlist, denylist and binding on every tick. A transient error closes the stream.
- R16. Every denial returns the same 404 `{error: 'not-found'}`. A malformed owner or repo is denied with zero object-store calls on every route, including launch. Repo-level denials emit no audit event, and lease logs carry no owner, repo or run ID.

**Cookie, CSRF and session info**

- R17. The session cookie carries `Max-Age=604800`. Clearing keeps `Max-Age=0` with identical attributes.
- R18. The CSRF payload binds `sha256(sessionId)` and not the raw ID. A CSRF token survives a restart.
- R19. `GET /operator/session` returns `expiresAt = issuedAt + 7 days`. The response shape is unchanged.

**Operations**

- R20. New audit events carry only a kind, counts, an error class and a retry count. They never carry a raw ID, a hash, a login or a token.
- R21. Docs state the lifetime, the durable-logout guarantee, the retention bound, the global-revoke procedure, the binder allowlist, the loss of GitHub-rights tracking on write routes, and the scoped IAM gate before any deploy.

---

## Scope Boundaries

- Durable approvals and questions are out. After a redeploy, a notification tap lands on the run. The run shows it was interrupted. No OAuth step is involved.
- The 10,000-session cap with refusal, opaque 256-bit IDs, the rule that IDs never appear in logs, and the guarded logout with no public fallback all stay.
- The CSRF scheme stays a stateless HMAC. Only the session binding in its payload changes.
- The operator allowlist file and the redaction denylist keep their current semantics.
- The ManageChannels check on `/add-project` stays. The binder allowlist is added beside it.
- GitHub-side access loss no longer closes a live stream, and write routes no longer track the operator's GitHub rights. This is the accepted cost of dropping the token.
- The operator contract version does not change. `expiresAt` keeps its type and meaning. Only the arithmetic changes.
- The gateway runs as one process. There is no multi-replica coordination for sessions.

### Deferred to Separate Tasks

- Scheduling `pruneInactive` for push subscriptions: separate PR.
- A shared 412/404 classifier for object-store errors: it exists in the bindings store, the push store and the coordination lock already, so extraction is a follow-up.
- The IAM policy change on the gateway identity and the audit of other principals' write access to `operator-web/`: infrastructure repository, and a pre-deploy gate for this work.
- Corrections to the infrastructure runbooks `operator-push-enablement.md` and `operator-surface-acceptance.md`, which say sessions die on restart: infrastructure repository.

---

## Context & Research

### Relevant Code and Patterns

- **Session store:** `packages/gateway/src/web/auth/session.ts`.
  - The constants are the absolute TTL, the idle TTL and the 10,000 cap.
  - `oauthToken`, `getOperatorToken` and `dropOperatorToken` carry the credential.
  - The per-session `onRevoke` hook map is wired only from the OAuth callback.
  - `scavenge` has no production caller.
  - `buildSessionCookieValue` sets no `Max-Age` on the set path.
  - `buildLogoutRoutes` revokes in memory and always returns 200.
- **Browser guard:** `packages/gateway/src/web/auth/csrf.ts`. The order is session get, allowlist, touch, origin, fetch metadata, CSRF. The CSRF payload is base64url JSON, and `GET /operator/session/csrf` returns the token to page script. The raw session ID is therefore readable from script today, even though the cookie is `HttpOnly`.
- **OAuth callback:** `packages/gateway/src/web/auth/github.ts`. It exchanges the code, calls `GET /user`, checks the allowlist, deletes any stale session, creates the new one, then registers the revoke hook. The authorize URL sets `scope=read:user`.
- **Display use of `login`:** `launch-route.ts` attributes the requester with the session's login, and `GET /operator/session` returns it. Nothing authorizes on it.
- **Repo authorization today:** `packages/gateway/src/web/auth/repo-authz.ts` plus `checkDenylist` in `packages/gateway/src/web/operator/route-helpers.ts`. Ten routes call it, and each consumes only the boolean.
  - Read: runs, repos, launch, pending-approvals, pending-questions, run-stream.
  - Write: dispatch, cancel, decision, question-decision.
  - `repo-authz.ts` also owns the `OWNER_RE` and `REPO_RE` name validation.
- **Bindings and denylist:** `packages/gateway/src/bindings/store.ts` does one object GET per `getBindingByRepo`. `packages/gateway/src/redaction/denylist.ts` answers `isRepoDenied` synchronously and denies an unprimed or null key. `lookupBindingDenyKeys` in `packages/gateway/src/redaction/surface-gate.ts` already separates a store error (`unavailable`) from a missing binding, but it is private. `resolveBindingDenyKeys` wraps it and collapses both into a null key for the redaction callers. Launch and dispatch read the binding and check the denylist inline today.
- **Binding creation:** `bindingsStore.createBinding` has one production caller, `runAddProjectPhases` in `add-project.ts`. The command's `authorize` step checks bot permissions and the invoking user's guild-level `ManageChannels`. The binding records `createdByDiscordId`.
- **Existing config patterns:** `packages/gateway/src/config.ts` reads Discord IDs with `readOptionalSecret` (`GATEWAY_TRIGGER_ROLE_ID`) and the operator allowlist with `readOptionalMultilineSecret`, which accepts an inline value or a `_FILE` variant. `parseAllowlistText` in `packages/gateway/src/web/auth/allowlist.ts` parses numeric GitHub IDs into numbers. Discord snowflakes can exceed the safe-integer range, so a binder list must parse to strings.
- **Lease:** `runLeaseCheck` in `packages/gateway/src/web/sse/run-stream-route.ts` checks session, token, denylist and `checkRepoAuthz`. Its warn logs include `owner`, `repo` and `runId`.
- **Pattern to copy:** `packages/gateway/src/web/operator-push/subscription-store.ts`. It has the key hashing, the CAS writes, the 412 and 404 classification, `requireCasCapable` narrowing of the optional adapter methods into a typed error, a sibling `_self-test` prefix that no listing sweeps, and the startup `selfTestCas` that `packages/gateway/src/program.ts` runs before it wires push.
- **Object-store adapter:** `packages/runtime/src/object-store/types.ts` makes `list` required and `getObject`, `conditionalPut`, `conditionalDelete` optional. `packages/runtime/src/object-store/s3-adapter.ts` does not prefix keys and truncates `list` at 100 pages. It logs `{key}` at info for writes and deletes, so the hashed session key will appear in logs.
- **Timers and startup:** the denylist refresh interval in `packages/gateway/src/program.ts` is the pattern for the scavenge timer. Startup is an `Effect.gen` program, so async steps are `yield* Effect.tryPromise`. `buildOperatorServerInputs` is shared with the offline route inventory in `packages/gateway/src/web/operator-route-smoke.ts`.
- **Shutdown:** `installShutdownHandlers` in `packages/gateway/src/shutdown.ts` calls the drain callback synchronously, then calls `server.close`. Both run concurrently.
- **Audit:** `packages/gateway/src/web/audit.ts` is exhaustive. A new event kind needs the union member, the `LOG_LEVEL` entry (or a per-outcome level function) and the `emitAudit` switch case. Only `repo-authz.ts` emits `authz.denied` today.
- **GitHub-side identity:** dispatch authenticates with `appClient.authForWorkflowDispatch` (`packages/gateway/src/github/dispatch.ts`). Launch clones through `packages/gateway/src/workspace-api/ensure-clone.ts` with the same GitHub App. Neither uses the operator's token.
- **Key layout:** the Action defaults its object-store prefix to `fro-bot-state` (`DEFAULT_S3_PREFIX` in `packages/runtime/src/shared/constants.ts`, applied in `src/harness/config/inputs.ts`). Gateway binding keys are built under that prefix by `buildObjectStoreKey`. Push keys such as `operator-push/` are raw adapter keys at the bucket root, so `operator-web/` will also sit at the bucket root and outside `fro-bot-state/`.

### Institutional Learnings

- `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md`: no-oracle gating and continuous lease re-checks. Its token-authz statements go stale.
- `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md`: the launch gate order. Its token-authz statements go stale.
- `docs/solutions/best-practices/dependency-gated-route-registration-guard-2026-06-25.md`: a route whose dependency is absent silently unmounts. Update the route inventory and the dependency-omission tests when new dependencies join the stream route.
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md`: build every key in one function.
- `docs/solutions/best-practices/s3-restore-needs-listbucket-and-prefix-scope-2026-08-12.md`: a startup list needs `ListBucket` on the prefix, and a denied list looks empty.

### External References

- OWASP Session Management Cheat Sheet: timeouts are a risk-based choice, and both idle and absolute timeouts must be enforced server-side.
- ASVS 5.0 V7.1.1 (L2): document and justify the timeout choice.
- ASVS V7.2.4 (L1): issue a new session token on authentication.
- RFC 6265bis: `__Host-` cookies may carry `Max-Age`. A clear uses `Max-Age=0` with identical attributes.
- WebKit tracking prevention: the 7-day cap applies to script-writable storage. It does not apply to a first-party, server-set `HttpOnly` cookie on a Home Screen app. Persistence across OS updates is not guaranteed, so re-authentication must stay a normal path.

---

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "packages/gateway/src/web + packages/gateway/src/bindings + packages/runtime/src/coordination (operator-web persisted state)",
  "freshness": {
    "vcs_reference": "42a1d831d"
  },
  "budget": {
    "max_search_passes": 6,
    "max_candidate_inspections": 8,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/gateway/src/web/auth/session.ts createInMemorySessionStore",
      "description": "Owns operator session entries keyed by opaque 256-bit IDs (githubUserId, login, issuedAt, lastAccessedAt, revoked, oauthToken) with create, get, touch, delete, onRevoke, scavenge, a 10,000-entry cap, and a Map-only backing store.",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/gateway/src/web/operator-push/subscription-store.ts createOperatorPushSubscriptionStore",
      "description": "Owns push subscription records under operator-push/subscriptions/by-endpoint/<sha256>.json with tombstones, operator-scoped deactivation, and CAS writes via ifNoneMatch and ifMatch.",
      "disposition": "insufficient",
      "insufficiency_reason": "Keyed by push endpoint and operator, not session. Deactivation is not session revocation, and there is no read-path cache. Its CAS and tombstone shape is a pattern to copy, not a store to reuse."
    },
    {
      "path_or_symbol": "packages/gateway/src/web/auth/github.ts createInMemoryStateStore",
      "description": "Owns single-use OAuth state entries (codeVerifier, issuedAt, consumed) with a TTL and bounded size, held in a process-local Map.",
      "disposition": "insufficient",
      "insufficiency_reason": "Short-lived login-flow state. A restart mid-login is acceptable, and it carries no operator identity or session lifetime."
    },
    {
      "path_or_symbol": "packages/runtime/src/coordination/lock.ts",
      "description": "Owns per-repo execution leases on locks/repo.json and locks/action.json using If-None-Match create and If-Match renew and release, with a TTL.",
      "disposition": "insufficient",
      "insufficiency_reason": "Models mutual exclusion and lease expiry for runs, not operator identity. Its expiry semantics cannot express absolute or idle session TTLs."
    },
    {
      "path_or_symbol": "packages/gateway/src/bindings/store.ts createBindingsStore",
      "description": "Owns repo bindings at <identity>/github/<owner>/<repo>/bindings/repo.json plus a channel index. Read per call via getObject; listed via list plus get.",
      "disposition": "insufficient",
      "insufficiency_reason": "Holds repo-to-channel bindings, not operator sessions. It is the authorization source under the bindings-only decision and is reused as a read predicate, not as session persistence."
    },
    {
      "path_or_symbol": "packages/gateway/src/redaction/denylist.ts createDenylistCache",
      "description": "Owns the in-memory redacted repo databaseId and nodeId sets, refreshed on a TTL with a grace window, and denies all on cold start or grace expiry.",
      "disposition": "insufficient",
      "insufficiency_reason": "Read-side deny metadata with no operator or session state. Its fail-closed unprimed behavior is the model the new binding predicate must preserve, not something to persist."
    }
  ]
}
```

---

## Key Technical Decisions

- **Drop the OAuth token and authorize from bindings.** A durable session cannot hold a credential. The predicate is allowlisted operator, bound repo, and a repo that is not denylisted. Reads and writes use the same predicate. Operator-side revocation (unbind, denylist, allowlist removal, logout) lands within one lease tick. The accepted cost is that GitHub-side access loss no longer closes a stream and write routes no longer track the operator's GitHub rights.
- **Restrict who can bind first.** Removing the GitHub check makes a binding the whole grant. Bindings are created only by Discord `/add-project`, so a configured Discord binder allowlist becomes the trust boundary. This ships before the route migration. A binding is then created only by a configured binder, and only for a repo the GitHub App installation can reach.
- **Fail closed at the command, not at startup.** An empty or unset binder list makes `/add-project` reply with a generic ephemeral refusal that does not reveal whether the list exists or is empty. Requiring the entry at startup would break gateways that do not run the operator web surface and would stop the whole gateway for a Discord-side setting. The command-level refusal is local and reversible, and the gateway logs one startup warning when the list is empty. The ManageChannels check stays.
- **The map stays authoritative and the object is a write-through copy.** Reads never touch the object store, so the store's `get` stays synchronous and the guard stays cheap. An unknown cookie is a map miss with no I/O. Writes happen on create and revoke, and the sweep deletes.
- **Records are signed.** The MAC covers a fixed-order canonical body and the record's own key hash, so a record cannot be copied to another ID. Its key is HKDF output from `GATEWAY_OPERATOR_CSRF_SECRET` with the info label `fro-bot/operator-session-record/v1`. A distinct label keeps the derived key separate from the CSRF signing key, and no new deploy secret is needed. A planted record with an attacker-chosen ID and the operator's `githubUserId` fails the MAC at load. Load also rejects `issuedAt` in the future beyond a small skew and records older than the absolute TTL. The MAC does not stop rollback of a revoked record to an earlier signed copy. Bucket write access stays a trust root, now limited to sessions that already existed.
- **Rotating the CSRF secret is the revoke-all control.** Every stored record then fails the MAC at the next load. It is the stolen-device procedure and part of the 7-day justification (ASVS V7.1.1): one allowlisted operator, an installed PWA that is awkward to re-authenticate, immediate durable logout, and a global revoke. Idle equals absolute, so no request extends a session and there are no renewal writes.
- **Keep `login` in the record, drop `lastAccessedAt`.** Nothing authorizes on `login`, but launch attribution and `GET /operator/session` read it from the session, so it stays as display data covered by the MAC. With no idle TTL, `lastAccessedAt` would only hold the creation time, so it goes.
- **Key by `sha256(sessionId)`.** The input is 256 bits of CSPRNG output, so a plain hash resists preimage and enumeration. The MAC key is the secret, not the key hash.
- **Create is cap check, then durable write, then map insert.** The result is `ok`, `cap`, `write_failed` or `not_ready`, and every failure is 503. A session that was never written never exists in memory.
- **Logout writes durably first.** The CAS revoke reads the ETag, re-signs the record as revoked, and writes with `ifMatch`, with bounded retries on a lost race. A 404 counts as done. Only on success does the store revoke in memory, fire the hook, and let the route clear the cookie and return 200. A final failure emits `auth.revocation.persist_failed` and returns 503 with `Retry-After`. The session stays valid and the operator retries through the guarded logout. There is no pending-revoke queue and no background retry, so a 200 is a durable guarantee and there is nothing to flush at shutdown.
- **Rotation is durable-first too.** The callback creates the new session, then revokes the old one the same way. If that fails, the new session is discarded without a hook, login returns 503, and the old session stays. The discarded record is an orphan nobody holds the ID for. A stale ID missing from the map is revoked by hash and a 404 counts as done.
- **Distinguish rotation in the record.** A record has a status of active, revoked or rotated. Revoked is the logout and revoke case. Rotated is a same-user re-login that deliberately fired no hook.
- **One store-level hook replaces per-session hooks.** `onSessionRevoked(githubUserId)` is passed at construction, so a restored session fires it. TTL expiry does not.
- **Push deactivation converges at load.** For each revoked record inside the TTL, load re-runs the idempotent deactivation for its user, once per user. It skips rotated records, and it skips users who have a live restored session, because those users logged in again and may have resubscribed. If the first deactivation failed, the next restart repairs it.
- **Load before building server inputs, and fail closed.** The load is `yield* Effect.tryPromise` inside the startup `Effect.gen`, before `buildOperatorServerInputs`, and the store is passed in. The helper stays synchronous for the offline route inventory. A self-test failure, a list failure or a load timeout leaves the store not ready, logs at error and emits an audit event. A failed read of a single record is counted and skipped, which is safe because an absent ID is rejected. The gateway still starts, but `create` returns 503 until restart. Restart-only is the simpler choice: startup already stops the gateway when the provider self-test fails, so a restart is the existing recovery for an unreachable store, and it needs no retry machinery.
- **Bounded load and sweep.** Record reads run with bounded concurrency under an overall timeout. Logs carry counts only.
- **Load policy.** Expired, revoked, non-allowlisted, MAC-failing and future-dated records are dropped from memory. Non-allowlisted records are revoked durably. Over the cap, the newest `issuedAt` values win, and the dropped ones are revoked durably too. Counts are logged.
- **Retention is a periodic sweep.** The same unref'd timer that scavenges the map also runs a bounded sweep. It lists `operator-web/sessions/`, reads each record, and best-effort deletes with `ifMatch` any record past the absolute TTL by `issuedAt`. A record that fails the MAC is deleted on the same age rule, since deletion trusts nothing. Revoked records inside the TTL stay until they expire. One interval of one hour drives both, so retention is bounded at 7 days plus one hour. The list is truncated at 100 pages, which is a known limit far above the session cap.
- **Narrow the adapter once.** The persistence module narrows the optional `getObject`, `conditionalPut` and `conditionalDelete` methods, plus `list`, into a typed error before any operation, following the push store. A missing method fails the self-test.
- **Expand, then contract.** The new async store and factory land beside the old ones. Callers migrate one unit at a time. A final unit deletes the old store, the token accessors, `touch`, `onRevoke` and the idle TTL. Every unit leaves the tree type-clean.
- **`resolveRepoAccess` is the single predicate.** It validates the names first, reads the binding once through the exported `lookupBindingDenyKeys` or a sibling that also returns the binding, then awaits and consults the denylist. A missing binding or a denylisted repo is `denied`. A store error or throw is `unavailable`. An `allowed` result carries the binding, which launch and dispatch need. The browser guard enforces the allowlist per request, so only the lease checks it explicitly. `resolveBindingDenyKeys` stays for redaction callers. List routes already hold the bindings, so their per-repo authz loop is deleted.
- **Repo-level denials are silent.** They emit no audit event, which keeps the wiki's "no audit on a denylist denial" statement true. `authz.denied` stays for operator-level events, and the lease emits it with `not_allowlisted` when an operator leaves the allowlist. Unbound and denylisted repos are logged under one denial label, so the log is not an existence oracle either. The dead members of `AuthzDeniedReason` are pruned.
- **CSRF binds a hash of the session ID.** The payload is base64url and the token is returned to page script, so a raw ID in it defeats `HttpOnly`. A hash fixes that. Tokens issued before the deploy fail once. The HMAC secret is stable, so tokens survive a restart.
- **`expiresAt` is fixed.** It equals `issuedAt` plus the absolute TTL. There is no sliding window and no `min()`.
- **Shutdown needs no ordering for sessions.** The scavenge and sweep timer is cleared in the drain callback, which runs before `server.close`. Without a revoke queue nothing depends on the order. A logout cut off by process exit has not returned 200, and the operator retries.
- **Fresh session ID on every login.** ASVS V7.2.4. Create always mints a new ID, and a test pins it.
- **Drop `scope=read:user`.** The scope is removed only after a live check confirms `GET /user` still returns the numeric ID and login without it.

---

## Open Questions

### Resolved During Planning

- **Should the key hash use a secret?** No. The ID is high-entropy random, so a plain hash is enough. Integrity comes from the separate record MAC.
- **Is the MAC key the CSRF secret?** No. It is HKDF output with its own label, so the CSRF signing key is never used for records.
- **Retry the load on a timer, or require a restart?** Restart. See the fail-closed decision.
- **Does the 7-day lifetime collide with WebKit's 7-day cap?** No. The cap applies to script-writable storage. A server-set `HttpOnly` cookie is not covered. Re-authentication stays a supported path.
- **Why not delete the record at revoke?** A deleted record looks like one that never existed, and a failed delete could leave the session alive at the next load. A revoked record inside the TTL is also the evidence that replays push deactivation.
- **Does a restored session need the OAuth callback to register a hook?** No. The hook is store-level.
- **Which `AuthzDeniedReason` members survive?** Only `not_allowlisted`, which the lease emits.
- **Does the dashboard need a paired release?** No. The contract version and shapes are unchanged.

### Deferred to Implementation

- **Live check of `GET /user` without a scope.** Confirm the response still carries `id` and `login` for a scope-less token. Remove `scope=read:user` only if it does. If not, keep the scope and record why.
- **Numbers.** Load concurrency and timeout, sweep read bound, CAS retry count and per-attempt timeout, the `Retry-After` seconds for each 503, and the future-date skew allowance (minutes).
- **Names.** The new store factory and interface, the record field names, the audit event kinds and whether the restore event needs a per-outcome log level, and the hook-suppressing rotate option.
- **List-route caps.** Decide whether `MAX_REPOS_PER_LISTING` and `MAX_REPOS_AUTHZ_FANOUT` still earn their place as response or read bounds.
- **Routes that no longer read the store.** Pending-approvals and pending-questions only used the token. Decide whether their `sessionStore` dependency disappears or stays as a structural `Pick`.

---

## High-Level Technical Design

> _This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce._

```mermaid
sequenceDiagram
  participant B as Browser
  participant G as Gateway (session store, Map)
  participant S as Object store (operator-web/sessions/)
  Note over G,S: Startup (store not ready until this succeeds)
  G->>S: self-test (conditionalPut, list, getObject, conditionalDelete)
  G->>S: list prefix, bounded GETs
  S-->>G: signed records
  Note over G: verify MAC, drop expired/revoked/non-allowlisted/future; cap; replay push deactivation
  Note over B,S: Login (OAuth callback)
  B->>G: callback (code, state)
  G->>G: GET /user, discard token, allowlist check
  G->>S: create sha256(newId).json, signed (ifNoneMatch)
  alt cap, write failed, or not ready
    G-->>B: 503 Retry-After, old session untouched
  else ok
    G->>G: insert in Map
    G->>S: revoke old session (durable first)
    G-->>B: Set-Cookie new ID, Max-Age=604800
  end
  Note over B,S: Logout (durable first)
  B->>G: POST logout
  G->>S: GET etag, conditionalPut status=revoked (bounded retries)
  alt durable write ok
    G->>G: revoke in Map, fire hook once
    G-->>B: 200, cookie cleared
  else final failure
    G-->>B: 503 Retry-After, session still valid
  end
  Note over G,S: Hourly timer: scavenge Map, sweep records past TTL
```

The repo-access predicate, as a decision table:

| Binding read | Denylist | Outcome | Request effect |
| --- | --- | --- | --- |
| Malformed owner or repo | not consulted | `denied` | 404, zero object-store calls |
| Found | not denied | `allowed` (carries the binding) | request proceeds |
| Found | denied or unprimed | `denied` | 404 |
| Not found | not consulted | `denied` | 404 |
| Store error or throw | not consulted | `unavailable` | 404, and the lease closes the stream |

---

## Implementation Units

- [ ] **Unit 1: Session persistence module and shared object-store fake**

**Goal:** One module owns the signed record shape and every object-store operation for sessions, and one fake backs every test that needs the store.

**Requirements:** R2, R3, R6, R9, R10, R11, R12

**Dependencies:** None

**Files:**

- Create: `packages/gateway/src/web/auth/session-persistence.ts`
- Create: `packages/gateway/src/web/auth/session-persistence.test.ts`
- Create: `packages/gateway/src/web/auth/test-object-store.ts` (the in-memory ETag/CAS fake with `ifNoneMatch`/`ifMatch`, list, get, conditional put and delete, and failure injection)

**Approach:**

- One key builder produces `operator-web/sessions/<sha256 hex>.json` and exposes the hash so the store can revoke a stale ID that is not in the map.
- The record has `githubUserId`, `login`, `issuedAt`, a three-value status (active, revoked, rotated) and the MAC. A shape guard parses each object without throwing.
- The MAC key comes from a derive function that takes the CSRF secret bytes and applies HKDF with the label `fro-bot/operator-session-record/v1`. The MAC input is a fixed-order canonical body plus the record's key hash. Verification uses a timing-safe compare.
- Operations over a narrowed adapter: create-if-absent, CAS revoke (rotated or revoked), list-and-load, best-effort delete of an expired record, and the self-test. Narrowing follows `requireCasCapable` in the push store and returns a typed error when `list`, `getObject`, `conditionalPut` or `conditionalDelete` is missing.
- Revoke reads the ETag, re-signs the body with the new status, writes with `ifMatch`, treats 404 as done, and re-reads on 412 up to a bounded count.
- Load lists the prefix, then reads records with bounded concurrency under one overall timeout. It returns verified records plus counts of skipped, MAC-failed, future-dated, too-old and failed reads. A list failure or a timeout is returned as a failure and is distinct from an empty result.
- The sweep lists the prefix, reads records with the same bounds, and deletes with `ifMatch` any record whose `issuedAt` is past the absolute TTL, whatever its MAC status. It returns counts.
- The self-test works under a sibling `operator-web/_self-test/` prefix that load and the sweep never list. It puts a key, lists the prefix and requires the key to appear, reads it back with `getObject`, updates it with `ifMatch`, confirms a second `ifNoneMatch` create conflicts, deletes it with `ifMatch`, then cleans up best effort. A list that returns nothing after a successful put fails with a `ListBucket` message.
- The module never logs an ID, a hash or a raw key. It logs counts and error classes.

**Execution note:** Test-first, against the shared fake.

**Patterns to follow:**

- `packages/gateway/src/web/operator-push/subscription-store.ts`: `hashEndpoint`, `readRecord`, `requireCasCapable`, the CAS writes, error classification, `selfTestCas`.
- `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md`.

**Test scenarios:**

- Happy path: the key builder returns a 64-character hex hash under the prefix and never contains the raw ID.
- Happy path: create writes once, and a second create for the same ID reports a conflict.
- Happy path: revoke and rotate re-sign the record, and load verifies them.
- Happy path: the derived MAC key differs from the CSRF secret bytes, and a different label yields a different key.
- Happy path: the self-test passes on the fake and leaves no key behind.
- Edge case: a well-shaped record at an attacker-chosen ID, carrying the operator's `githubUserId` and no valid MAC, is rejected at load and counted.
- Edge case: a valid record copied to a different key fails the MAC.
- Edge case: a record with `issuedAt` beyond the skew allowance, and a record older than the absolute TTL, are rejected and counted.
- Edge case: a record signed under a different CSRF secret fails the MAC, which is the global-revoke path.
- Edge case: a malformed or mistyped record is skipped and counted, not thrown.
- Edge case: revoke on an already-revoked record writes nothing and succeeds. Revoke on a 404 is done.
- Edge case: a 412 on revoke re-reads and succeeds on retry. An exhausted retry budget reports failure.
- Edge case: load concurrency never exceeds the bound.
- Edge case: the sweep deletes a record past the TTL, keeps a revoked record inside the TTL, deletes a MAC-failing record past the TTL, and loses a race to a concurrent write without error.
- Error path: a list failure and an overall timeout are reported as failures, not as an empty store.
- Error path: some record reads fail. They are counted and skipped, and the rest load.
- Error path: the adapter lacks a method. The module returns the typed error.
- Error path: the self-test fails when a put succeeds but list returns nothing, when both concurrent creates succeed, and when `conditionalDelete` is missing.
- Integration: create, load, revoke, load on one fake shows the revoked status and no resurrection.

**Verification:** Every session object-store call lives in this module. No raw ID, hash or key reaches a log line. The self-test separates a denied list from an empty prefix. Commit boundary: the new files compile and pass on their own, and no existing code changes.

- [ ] **Unit 2: Restrict binding creation to configured Discord binders**

**Goal:** Only a configured Discord user can create a binding through `/add-project`, and an empty list refuses everyone.

**Requirements:** R13, R21

**Dependencies:** None

**Files:**

- Modify: `packages/gateway/src/config.ts` (new `binderAllowlist` field and parser)
- Modify: `packages/gateway/src/discord/commands/add-project.ts` (`AddProjectDeps`, `authorize`)
- Modify: `packages/gateway/src/program.ts` (pass the list into the command deps and log one warning when it is empty)
- Modify: `deploy/compose.yaml` (optional `GATEWAY_BINDER_ALLOWLIST_FILE` env entry and secret mount, mirroring `GATEWAY_TRIGGER_ROLE_ID_FILE`)
- Test: `packages/gateway/src/config.test.ts`, `packages/gateway/src/discord/commands/add-project.test.ts`, `packages/gateway/src/program.test.ts`

**Approach:**

- New entry `GATEWAY_BINDER_ALLOWLIST` with a `_FILE` variant, read with `readOptionalMultilineSecret`. The value is newline-separated Discord user IDs. A separate parser validates each entry as a snowflake string and returns a set of strings. The numeric GitHub allowlist parser is not reused because snowflakes can exceed the safe-integer range.
- Unset or empty is valid config and yields an empty set. A malformed entry fails config load, as the operator allowlist does.
- `authorize` checks the binder list after the shutdown and bot-permission gates and before the member fetch. A user not in the set, or any user when the set is empty, gets one generic ephemeral refusal that does not reveal whether the list is empty. The ManageChannels check then runs as before.
- The deploy README documents the new entry beside the other gateway variables, and notes that existing deployments must set it before deploy or `/add-project` refuses everyone. `deploy/.env.example` lists no gateway variables, so it does not change.

**Patterns to follow:**

- `GATEWAY_OPERATOR_ALLOWLIST` loading in `config.ts` for the inline-or-file read, and `GATEWAY_TRIGGER_ROLE_ID` for a Discord ID setting.
- The existing `authorize` gate order and refusal copy in `add-project.ts`.

**Test scenarios:**

- Happy path: config parses a newline-separated list of snowflakes into a set, from the env value and from the `_FILE` variant.
- Happy path: a listed user with ManageChannels passes `authorize`.
- Edge case: a listed user without ManageChannels is refused with the existing ManageChannels copy.
- Edge case: a user not in the list is refused with the generic copy, and the member fetch is never called.
- Edge case: an empty or unset list refuses every user with the same generic copy.
- Edge case: duplicate entries, blank lines and surrounding whitespace parse cleanly. Snowflakes beyond the safe-integer range keep their exact digits.
- Error path: a non-numeric or wrong-length entry fails config load with a message that names the variable and not the value.
- Integration: with an empty list, `program.ts` logs one startup warning that `/add-project` is disabled, and the gateway still starts.

**Verification:** No code path creates a binding for a user outside the configured list. Commit boundary: existing add-project tests pass with the list supplied in their fixtures.

- [ ] **Unit 3: Bindings-only repo authorization for routes and lease**

**Goal:** All ten routes and the lease authorize through `resolveRepoAccess`, and nothing consumes the OAuth token.

**Requirements:** R14, R15, R16, R20

**Dependencies:** Unit 2

**Files:**

- Modify: `packages/gateway/src/redaction/surface-gate.ts` (export `lookupBindingDenyKeys`, or add a sibling that also returns the binding)
- Modify: `packages/gateway/src/web/operator/route-helpers.ts` (add `resolveRepoAccess` and the owner/repo name validation, remove `checkDenylist`)
- Modify: `packages/gateway/src/web/operator/pending-approvals-route.ts`, `pending-questions-route.ts`, `decision-route.ts`, `question-decision-route.ts`, `cancel-route.ts`, `launch-route.ts`, `dispatch-route.ts`, `runs-route.ts`, `repos-route.ts` (all under `packages/gateway/src/web/operator/`)
- Modify: `packages/gateway/src/web/sse/run-stream-route.ts` (route and lease; `allowlist` and `auditLogger` join `RunStreamRouteDeps`)
- Modify: `packages/gateway/src/web/server.ts` (remove every `repoAuthzDeps` block and the `repoAuthzCache` dep; pass `allowlist` and `auditLogger` to the stream route)
- Modify: `packages/gateway/src/web/audit.ts` (prune `AuthzDeniedReason`)
- Modify: `packages/gateway/src/web/operator/test-helpers.ts`
- Modify (comment sweep): `packages/gateway/src/operator-contract/redaction.ts`, `packages/gateway/src/execute/run-index.ts`
- Delete: `packages/gateway/src/web/auth/repo-authz.ts`, `packages/gateway/src/web/auth/repo-authz.test.ts`
- Test: `packages/gateway/src/web/operator/route-helpers.test.ts` (create), `packages/gateway/src/redaction/surface-gate.test.ts`, the test file beside each route above, `packages/gateway/src/web/sse/run-stream-route.test.ts`, `packages/gateway/src/web/server.test.ts`, `packages/gateway/src/web/audit.test.ts`, `packages/gateway/src/operator-contract/redaction.test.ts`

**Approach:**

- `resolveRepoAccess(owner, repo)` validates the names, reads the binding once, awaits the denylist state, and answers from the decision table. It is generic over the binding shape the caller's lookup returns. The `OWNER_RE` and `REPO_RE` patterns move into `route-helpers.ts` before `repo-authz.ts` is deleted.
- Run-scoped routes (pending-approvals, pending-questions, decision, question-decision, cancel, run-stream) resolve the repo from the run index, then call the helper. Any outcome but `allowed`, and any throw, returns the uniform 404.
- Launch and dispatch replace their inline binding and denylist blocks with the helper and keep their own 404 bodies. A malformed name now makes zero object-store calls on launch as well.
- List routes (runs, repos) keep `listBindings` and the denylist filter and lose the per-repo authz loop.
- Write routes use the same predicate as read routes. The write-level probe and its `insufficient_permission` path are gone.
- The lease runs session get, an explicit allowlist check, then the helper. The token check is deleted. A transient `unavailable` closes the stream. An allowlist removal emits `authz.denied` with `not_allowlisted`. The other lease warn logs carry `githubUserId` and a gate label only, with no owner, repo or run ID. Route-level denial logs use one denial label, so unbound and denylisted repos are not distinguishable.
- Repo-level denials emit no audit event. `AuthzDeniedReason` shrinks to the members still emitted.
- Update the doc comments that cite `checkRepoAuthz` or `getOperatorToken` in the files above.
- The old store still exposes the token accessors in this unit. No route calls them, and route session dependencies shrink to a structural `get`.
- Scale: about 130 `repoAuthz`/`getOperatorToken` lines across 19 files in `packages/gateway/src/web/operator/`, source and tests, plus 29 in `run-stream-route.test.ts`.

**Patterns to follow:**

- `checkDenylist` and `resolveRepoFromRunIndex` in `route-helpers.ts` for the helper shape.
- The uniform `notFoundResponse` handling in each route.
- `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md` for no-oracle ordering.

**Test scenarios:**

- Happy path: a bound, non-denylisted repo returns `allowed` with its binding after exactly one `getBindingByRepo` call.
- Happy path: each of the ten routes succeeds for an allowlisted operator on a bound repo with no token accessor in its deps.
- Edge case: an unbound repo is `denied`. A denylisted repo is `denied`. An unprimed denylist is `denied`. A binding with no deny keys is `denied`.
- Edge case: owner or repo values `''`, `.`, `..`, `a/b`, a NUL byte and an over-length name are `denied` with zero `getBindingByRepo` calls, on every route including launch.
- Edge case: the 404 body and headers are identical across unbound, denylisted, unavailable and malformed inputs for each of the ten routes. Launch and dispatch keep their existing bodies.
- Edge case: list routes omit a denylisted repo and make no per-repo store call.
- Edge case: write routes allow a bound repo with no write-level check, and the old `insufficient_permission` tests are gone.
- Error path: `getBindingByRepo` returns an error or throws. The helper returns `unavailable`, request routes return 404, and `listBindings` errors still return 503.
- Integration: a lease tick closes the stream when the session is revoked, the operator leaves the allowlist, the binding is removed, the repo becomes denylisted, or the binding read errors.
- Integration: a lease tick with all four still valid leaves the stream open.
- Integration: every lease and route denial log context lacks owner, repo and run ID, and no repo-level denial calls the audit logger.
- Integration: an allowlist removal emits exactly one `authz.denied` with `not_allowlisted`.
- Integration: omitting `allowlist` or `auditLogger` from the stream deps unmounts the route, and the dependency-omission test names it.
- Regression: `tsc` finds no reference to `checkRepoAuthz`, `checkRepoWriteAuthz`, `RepoAuthzCache` or `repoAuthzDeps`.

**Verification:** No route or lease path consumes an OAuth token or calls GitHub. Every denial looks identical to the caller and in the logs. Commit boundary: the whole tree type-checks and tests pass with the old session store and its token accessors still in place.

- [ ] **Unit 4: Durable session store, added beside the old one**

**Goal:** A new store creates asynchronously, signs and writes through, restores at startup, revokes durably before it acknowledges, and holds no credential.

**Requirements:** R1, R2, R5, R6, R7, R8, R10, R11, R12, R17, R20

**Dependencies:** Unit 1, Unit 3

**Files:**

- Modify: `packages/gateway/src/web/auth/session.ts` (new factory and interface beside the existing ones; cookie builder gains the `Max-Age` on set; a 7-day TTL constant under a new name, with the V7.1.1 justification beside it; the old 8-hour constant stays for the old store until Unit 7)
- Modify: `packages/gateway/src/web/audit.ts` (new audit events)
- Test: `packages/gateway/src/web/auth/durable-session.test.ts` (create), `packages/gateway/src/web/auth/session.test.ts` (cookie cases only), `packages/gateway/src/web/audit.test.ts`

**Approach:**

- The factory takes the persistence module, a clock, a logger, an audit logger, the allowlist and the optional `onSessionRevoked` hook. The interface has async `create`, `get`, async `revoke`, `load`, `scavenge`, `sweep` and `size`. The old factory, interface and tests stay untouched.
- `create` returns `ok`, `cap`, `write_failed` or `not_ready`. The order is cap check (reclaiming expired and revoked entries first), durable create, map insert. It mints a new ID every time.
- `get` is map-only. It returns nothing for unknown, revoked or expired IDs, and an unknown ID touches no adapter.
- `revoke` runs the CAS first. On success it revokes in memory and fires the hook once if the entry was not already revoked, then reports success. On final failure it emits `auth.revocation.persist_failed` and reports failure, and the entry stays valid. A repeat revoke of an already-revoked entry succeeds without a second hook. A rotate option writes the rotated status and suppresses the hook. An ID absent from the map is revoked by hash, tolerates a 404 and fires no hook.
- `load` runs the self-test, then the persistence load, then applies the load policy and the push replay from Key Technical Decisions. On any self-test or load failure it leaves the store not ready, logs at error and emits the restore audit event. Otherwise it marks the store ready. It returns count-only results.
- `scavenge` removes expired and revoked entries from the map and never touches the object store. `sweep` delegates to the persistence sweep.
- New audit events and their fields:
  - `auth.revocation.persist_failed`: kind, a fixed correlation label, retry count, error class.
  - A restore event: kind, outcome, failing phase (self-test or load) when it failed, error class, and counts of loaded, expired, revoked, not-allowlisted, MAC-failed, future-dated, over-cap and failed-read records.
  - Neither carries a raw ID, a hash, a login or a token. Each needs the union member, the level entry or function, and the `emitAudit` case.
- The cookie builder adds `Max-Age=604800` on set. The clear path keeps `Max-Age=0` and the same other attributes.

**Execution note:** Test-first for revoke ordering, hook semantics, push replay and the load policy.

**Patterns to follow:**

- The existing store and `buildSessionCookieValue` in `session.ts`.
- The per-outcome level functions in `audit.ts` (`pushDisabledLevel`).

**Test scenarios:**

- Happy path: `create` returns `ok`, the stored record has a hashed key, a valid MAC, no token and no raw ID, and `get` returns the identity.
- Happy path: `revoke` writes durably first, then `get` returns nothing and the hook fires once with the user ID.
- Happy path: the set cookie carries `Max-Age=604800`. The clear cookie carries `Max-Age=0` and the same other attributes.
- Edge case: a session is valid at 7 days minus 1 ms and invalid at 7 days plus 1 ms. Activity on day 3 does not extend it. Six days of silence does not expire it.
- Edge case: two logins mint different session IDs.
- Edge case: at the cap with all entries live, `create` returns `cap` and writes nothing. With expired entries present, they are reclaimed and `create` succeeds.
- Edge case: a failed durable create returns `write_failed`, leaves no map entry and fires no hook. A store that is not ready returns `not_ready` and writes nothing.
- Edge case: a second `revoke` fires no second hook. A revoke of an unknown ID fires no hook, writes by hash and tolerates a 404.
- Edge case: a rotate revokes the old session, writes the rotated status and fires nothing.
- Edge case: `scavenge` drops expired and revoked entries and never calls the adapter. TTL expiry fires no hook.
- Edge case: load drops expired, revoked-inside-TTL, non-allowlisted, MAC-failing and future-dated records. It revokes non-allowlisted records durably. Over the cap it keeps the newest `issuedAt` values and durably revokes the rest.
- Edge case: an unknown ID in `get` makes zero adapter calls.
- Error path: the CAS revoke fails after its retries. `revoke` reports failure, the entry stays valid, and `persist_failed` is emitted with the retry count.
- Error path: a throwing hook does not undo a successful revoke.
- Error path: a self-test failure, a list failure and a load timeout each leave the store not ready, `create` returns `not_ready`, old IDs are rejected, and the error log and restore audit event are emitted.
- Error path: serializing every new audit event and every log context emitted during these tests never matches a 43-character base64url ID, a 64-character hex hash, the test login or a token pattern.
- Integration: store A creates and revokes sessions. A fresh store B on the same fake loads them. The live ID is accepted and the revoked ID stays rejected.
- Integration: a revoke of a restored session fires the same hook as one made before the restart.
- Integration: push replay. The first deactivation fails, and after a restart the load re-runs it and the user's subscriptions are deactivated.
- Integration: push replay skips rotated records, skips a user with a live restored session, and runs once per user when several revoked records exist.
- Integration: a record planted at an attacker-chosen ID with the operator's `githubUserId` is rejected at load.

**Verification:** The new store satisfies the lifecycle end to end over the shared fake, and the old store is unchanged. Commit boundary: the tree type-checks, and nothing outside the new tests uses the new store yet.

- [ ] **Unit 5: Cut over callers to the durable store**

**Goal:** The OAuth callback, logout, browser guard and `program.ts` use the durable store, and the gateway loads, scavenges and sweeps it.

**Requirements:** R4, R5, R6, R7, R8, R10, R11, R12, R15, R17

**Dependencies:** Unit 3, Unit 4

**Files:**

- Modify: `packages/gateway/src/web/auth/github.ts` (callback, `GitHubOAuthDeps`, `buildGitHubOAuthDeps`)
- Modify: `packages/gateway/src/web/auth/session.ts` (`buildLogoutRoutes`)
- Modify: `packages/gateway/src/web/auth/csrf.ts` (guard store type; remove the touch step)
- Modify: `packages/gateway/src/web/server.ts` (the `sessionStore` dependency type and the header comment on route gating)
- Modify: `packages/gateway/src/program.ts`
- Modify: `packages/gateway/src/web/operator-route-smoke.ts`
- Test: `packages/gateway/src/web/auth/github.test.ts` (2 sync `create` sites), `packages/gateway/src/web/server.test.ts` (18), `packages/gateway/src/web/auth/csrf.test.ts` (19), `packages/gateway/src/web/operator-route-smoke.test.ts` (1), `packages/gateway/src/web/auth/session-info-route.test.ts`, `packages/gateway/src/program.test.ts`

**Approach:**

- The callback uses the token for `GET /user` and drops it. `create` receives identity only. The order after identity is verified is allowlist check, async create, then durable-first rotation of the stale cookie's session. Same user rotates without the hook. A different user revokes and fires it. A stale ID absent from the map is revoked by hash.
- `cap`, `write_failed` and `not_ready` return 503 with `Retry-After` and set no cookie. A failed rotation discards the new session without a hook, returns 503 and leaves the old session valid.
- `scope=read:user` leaves the authorize URL once the live check in Deferred to Implementation passes.
- Remove `onSessionRevoke` from `GitHubOAuthDeps` and from the `buildGitHubOAuthDeps` parameters.
- The logout route awaits `revoke`. On success it emits `auth.logout`, clears the cookie and returns 200. On failure it returns 503 with `Retry-After`, leaves the cookie, and the session stays valid.
- The guard's store type becomes the structural `get`, and the touch step and its comment are removed. The allowlist check stays where it is.
- `BuildOperatorServerInputs` takes the store. The helper stops building one and stops passing a revoke hook to the OAuth deps. It stays synchronous.
- In the operator-web block the order is push self-test, then store construction over the shared adapter with the CSRF-derived MAC key and the existing push-deactivation closure as `onSessionRevoked`, then `yield* Effect.tryPromise` around `load`, then `buildOperatorServerInputs`. The hook is defined only when push is enabled. The closure moves to where the store is built, after the push self-test. A load failure or throw never aborts startup.
- One unref'd timer follows the denylist refresh interval. Each tick runs the map scavenge and the sweep, and a tick error is logged and never fatal. The interval is one hour. The drain callback clears the timer.
- The offline route inventory builds the store from the shared fake. The expected route list does not change. The dependency-omission test is updated for the new stream-route dependencies.
- Convert the 40 sync `create` sites in `server.test.ts`, `csrf.test.ts`, `github.test.ts` and `operator-route-smoke.test.ts` to the async result over the shared fake. Update the `program.test.ts` cases that assert `githubOAuth.onSessionRevoke` to assert the store-level hook.

**Patterns to follow:**

- The existing consume-before-await and allowlist-before-mint ordering in the callback.
- The denylist refresh interval and the drain callback in `program.ts`.
- `docs/solutions/best-practices/dependency-gated-route-registration-guard-2026-06-25.md`.

**Test scenarios:**

- Happy path: a successful callback creates a session, the fetch mock sees the token only on the `GET /user` call, and the store receives identity only.
- Happy path: the `Set-Cookie` carries `Max-Age=604800`, and the authorize URL has no `scope` parameter once the live check passes.
- Happy path: logout returns 200 only after the stored record is revoked, clears the cookie, and emits `auth.logout`.
- Happy path: with push enabled, revoking a restored session deactivates that operator's push subscriptions through the store-level hook.
- Edge case: a stale cookie for the same user rotates without the hook and leaves push alone. A different user fires the hook once. A stale ID unknown to the map is revoked by hash and login succeeds.
- Edge case: `cap`, `write_failed` and `not_ready` each return 503 with `Retry-After`, set no cookie, and leave the old session valid.
- Edge case: a failed rotation returns 503, discards the new session without a hook, and leaves the old session valid.
- Edge case: logout whose durable write fails returns 503, keeps the cookie, leaves the session valid, and a retry succeeds.
- Edge case: a non-allowlisted user gets 403 and nothing is written. A failed `GET /user` returns 400 and mints nothing.
- Edge case: a load failure still starts the gateway and the operator server, and `create` returns 503 until restart.
- Edge case: with push disabled the hook is undefined and revocation still works. With operator web disabled no store and no timer exist.
- Edge case: the timer is unref'd, runs both scavenge and sweep, and is cleared on shutdown. A throwing tick is logged and does not crash.
- Edge case: omitting the stream-route dependencies unmounts it, and the diagnostic names it.
- Error path: `load` throws instead of returning an error. The gateway catches it and starts not ready.
- Integration: callback, then restart from the same fake, then the guard accepts the issued cookie.
- Integration: `load` resolves before `startOperatorServer` is called, and the offline inventory exits 0 with production-shaped deps.

**Verification:** A restart keeps sessions, logout is durable before it answers, and the offline inventory fails loudly if a dependency is dropped. Commit boundary: the tree type-checks with the old factory still defined but unused by production code.

- [ ] **Unit 6: CSRF session binding and fixed session expiry**

**Goal:** The CSRF token no longer exposes the session ID, and `/session` reports a fixed expiry.

**Requirements:** R18, R19

**Dependencies:** Unit 5

**Files:**

- Modify: `packages/gateway/src/web/auth/csrf.ts` (payload binding, header comment)
- Modify: `packages/gateway/src/web/auth/session-info-route.ts` (expiry arithmetic, comments, and removal of the idle-TTL import)
- Modify: `packages/gateway/src/operator-contract/responses.ts` (the `expiresAt` comment)
- Test: `packages/gateway/src/web/auth/csrf.test.ts`, `packages/gateway/src/web/auth/session-info-route.test.ts`

**Approach:**

- Generation and verification both bind `sha256(sessionId)` through one private function. The public signatures do not change.
- Tokens issued before the deploy carry the raw ID and fail once. The interval, grace window and HMAC are unchanged.
- `expiresAt` is `issuedAt` plus the absolute TTL. The idle import and the `min()` go.
- Update the header comment in `csrf.ts`, the route comment, and the `responses.ts` comment that says "sooner of absolute or idle expiry".

**Patterns to follow:**

- The existing token build and verify functions in `csrf.ts`.

**Test scenarios:**

- Happy path: a token for session A verifies for A and fails for B.
- Happy path: decoding the payload shows no substring of the raw session ID.
- Happy path: a token verifies after a simulated restart with the same secret and a reloaded session.
- Edge case: a token built with the old raw-ID binding fails verification.
- Edge case: interval rollover and the 30-second grace window behave as before.
- Edge case: `expiresAt` equals `issuedAt` plus 7 days whatever the clock reads and however often the session is used.
- Integration: `parseOperatorSessionInfo` still accepts the route's response body.

**Verification:** The CSRF token reveals nothing about the session ID, and the session response matches the documented fixed lifetime. Commit boundary: no remaining reader of the idle TTL constant except the old store.

- [ ] **Unit 7: Contract: delete the old store and token API**

**Goal:** No credential, idle TTL, touch or per-session hook symbol remains.

**Requirements:** R1, R2, R4

**Dependencies:** Unit 5, Unit 6

**Files:**

- Modify: `packages/gateway/src/web/auth/session.ts` (delete the old factory and the `oauthToken`, `getOperatorToken`, `dropOperatorToken`, `touch`, `onRevoke` and `SESSION_IDLE_TTL_MS` members; keep one SessionStore name for the durable store if that reads best)
- Modify: `packages/gateway/src/web/operator/test-helpers.ts` (drop leftover token stubs)
- Test: `packages/gateway/src/web/auth/session.test.ts` (remove the old-store cases, including the 64 sync `create` sites)
- Modify (comment sweep): any remaining doc comment that cites the removed members

**Approach:**

- Delete the old in-memory factory and its interface members, then let `tsc` find any leftover consumer: routes, the lease, `Pick` types and test helpers.
- Move still-relevant cookie and cap cases into the durable-store tests if they are not already covered there.

**Test expectation:** none for new behavior. The old-store tests are removed, and the durable-store tests from Unit 4 are the coverage.

**Verification:** `tsc` reports no `oauthToken`, `getOperatorToken`, `dropOperatorToken`, `touch`, `onRevoke` or `SESSION_IDLE_TTL_MS`. Commit boundary: the tree type-checks and tests pass with only the durable store present.

- [ ] **Unit 8: Documentation**

**Goal:** Every living doc describes the shipped behavior, the retention bound, the revoke-all procedure and the scoped IAM gate.

**Requirements:** R21

**Dependencies:** Units 2 through 7

**Files:**

- Modify: `deploy/README.md` (route table and session paragraph near the operator routes; the "Who can answer" paragraph; the binder allowlist in the gateway variable docs; the global-revoke procedure; a new "Operator session store rollout" subsection beside "AWS run-state retention rollout")
- Modify: `docs/wiki/Operator Web Control Surface.md` (source list, the session and authorization sections, the launch and dispatch gate descriptions, the approvals and questions routes, the lease, cross-surface answering, the binder allowlist, the revoke-all procedure)
- Modify: `packages/gateway/AGENTS.md` (the redaction note that composes with `checkRepoAuthz`, and the dispatch route entry)
- Modify: `docs/privacy/operator-push-retention.md`
- Modify: `docs/plans/2026-06-20-001-feat-authenticated-sse-run-stream-route-plan.md` (a short note that its token-based authorization is superseded by this plan)
- Modify: `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md`, `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md` (mark the token-authz statements superseded)

**Approach:**

- State the lifetime: 7 days fixed, no idle timeout, survives restart. Give the V7.1.1 justification, including the revoke-all control.
- State the logout guarantee: a 200 means the revoke is durable, and a 503 means the session is still valid and logout should be retried.
- Revoke-all procedure, in the README and the wiki: rotate `GATEWAY_OPERATOR_CSRF_SECRET` and redeploy. Every stored session then fails its MAC at the next load, and in-flight CSRF tokens fail with it. Use this for a stolen device or a suspected leak. The stale records are deleted by the next sweeps after their TTL.
- Replace "repo write/admin" and "repo-scoped read authz" wording with the bindings-only predicate, including the dispatch and launch descriptions. State that write routes no longer track the operator's GitHub rights, and that the GitHub-side action on dispatch and launch runs as the Fro Bot GitHub App installation, not as the operator.
- State that bindings are created only by the configured Discord binders, and that the App installation scope bounds which repos they can bind. Leave the wiki sentence that a denylist denial writes no audit event as it is.
- Privacy document: logout and revoke deactivate that operator's push subscriptions, and a restart repairs a deactivation that failed. TTL expiry does not deactivate. A stored session record is kept for at most 7 days plus one hourly sweep interval.
- Note that the hashed session key appears in object-store info logs and is not a credential.
- IAM gate, to be met before deploy and scoped to the session keys only:
  - Object actions `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `operator-web/sessions/*` and `operator-web/_self-test/*`.
  - `s3:ListBucket` with `s3:prefix` conditions on both prefixes.
  - A pre-deploy check that no other principal, including the Action's S3 principal, can write under `operator-web/`. The Action's default prefix is `fro-bot-state`, and the gateway adapter does not prefix keys, so `operator-web/` sits at the bucket root and outside the Action's default prefix. A bucket-wide grant on the Action's principal would still reach it.
  - Without the grant the self-test fails, the store stays not ready, and logins return 503 until the grant is fixed and the gateway restarts.
- Cross-repo follow-up: the infrastructure runbooks `operator-push-enablement.md` and `operator-surface-acceptance.md` say sessions die on restart and need correcting there.
- Leave `docs/decisions/2026-06-19-s2-operator-auth-authority.md` alone. The decision it records still holds.

**Test expectation:** none, because this is documentation. The repository's markdown link check covers the links.

**Verification:** No living doc says restart is a global logout, cites an idle timeout or an 8-hour lifetime, describes GitHub repo-access authorization, or claims a retention bound without the sweep.

---

## System-Wide Impact

- **Interaction graph:** The browser guard loses its touch step. The OAuth callback loses the hook registration. `program.ts` owns store construction, load and the hourly timer. Ten routes and the lease change their authorization call. `/add-project` gains a gate.
- **Error propagation:** Object-store failures during login and logout become 503, with the session left as it was. During load they become a not-ready store. During request handling they never occur, because the guard reads only the map.
- **State lifecycle risks:**
  - A crash between the durable create and the map insert, or a discarded failed-rotation session, leaves an orphan record. It loads as a valid session whose ID nobody holds.
  - A crash during logout leaves the session valid and unrevoked, which matches the 503 the operator would have seen.
  - A revoked record inside its TTL stays until the sweep removes it after expiry.
- **API surface parity:** The operator contract shape is unchanged. The dashboard keeps reading `expiresAt` as a timestamp. A pre-deploy CSRF token fails once and the dashboard refetches it.
- **Integration coverage:** Restart round trips, hook and push replay on restored sessions, lease closure on each operator-side revocation, and load-before-server ordering need tests that exercise the real store over the shared fake. Mocks alone will not prove them.
- **Unchanged invariants:**
  - The uniform 404 on every denial.
  - Redaction before authorization, and fail-closed denylist behavior.
  - The guarded logout and the browser-origin guard order, minus touch.
  - The session cap and refusal.
  - One operator, one process.

---

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| The gateway identity lacks the scoped object-store grant, so login returns 503 | Pre-deploy IAM gate in the rollout notes and the deploy README. The self-test fails loudly at startup, and a denied list is caught by the put-then-list check. |
| Another principal, such as the Action's S3 identity, can write under `operator-web/` | The pre-deploy check lists it. Even then, a planted record fails the MAC unless the writer also holds the CSRF-derived key. |
| A bucket writer replays an older signed copy of a revoked record | The MAC binds a record to its key but has no counter. Access to the prefix is limited by the IAM gate, and the replay only revives a session that already existed. |
| Removing the GitHub check widens access if a binding is wrong | Bindings are created only by configured Discord binders, for repos the GitHub App installation can reach. The denylist still applies. Operator-side revocation closes streams within one lease tick. |
| An existing deployment upgrades with no binder list set | `/add-project` refuses everyone and the gateway logs one startup warning. Existing bindings keep working. The rollout notes say to set the list before deploy. |
| An object-store outage blocks logins and logouts | Login and logout return 503 with `Retry-After` and change nothing. A logout failure leaves the session valid and visible to the operator. The audit and error logs name the cause. |
| A failed or timed-out load leaves the store not ready until restart | Loud by design: error log, audit event and 503 on login. Restart is the existing recovery for an unreachable store. |
| In-flight CSRF tokens fail once at deploy | Expected and visible. The dashboard refetches the token. The HMAC secret is stable, so this happens once. |
| The startup list is slow or partial | Bounded concurrency and an overall timeout. A skipped record only costs one re-login. The list truncates at 100 pages, far above the session cap. |
| Hashed session keys appear in object-store info logs | Accepted. The hash cannot be turned back into a cookie. The raw ID never appears. |
| Safari or iOS drops the cookie across an OS update | Re-authentication stays a normal, supported path. |
| Infrastructure runbooks keep saying sessions die on restart | Listed as a cross-repo follow-up in the rollout notes. |

---

## Documentation / Operational Notes

- **IAM pre-deploy gate.** Before deploying, grant the gateway identity `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `operator-web/sessions/*` and `operator-web/_self-test/*`, and `s3:ListBucket` with `s3:prefix` conditions on both prefixes. Confirm that no other principal, including the Action's S3 principal, can write under `operator-web/`. Confirm the startup self-test passes in the first deploy log.
- **Binder allowlist.** Set `GATEWAY_BINDER_ALLOWLIST` (or the `_FILE` variant) to the Discord user IDs allowed to bind repos before deploying. Until it is set, `/add-project` refuses everyone.
- **First deploy.** Every existing in-memory session ends, which is the last forced logout. In-flight CSRF tokens fail once. Browsers receive a 7-day cookie on their next login.
- **Revoke-all.** Rotate `GATEWAY_OPERATOR_CSRF_SECRET` and redeploy. Every stored session is dropped at the next load.
- **Retention.** Stored records live for at most 7 days plus one hourly sweep interval. Logged-out records stay marked revoked until the sweep removes them after expiry.
- **Observability.** Watch for `auth.revocation.persist_failed` and the restore event. Logs carry counts and error classes, never session IDs or hashes.
- **Cross-repo follow-ups.** Correct `operator-push-enablement.md` (near line 200) and `operator-surface-acceptance.md` (near line 183) in the infrastructure repository, and ship the IAM change there before this release.
- **Dashboard.** No pairing is needed. The contract version and response shapes are unchanged.

---

## Sources & References

- Issue: #1837
- Related code: `packages/gateway/src/web/auth/session.ts`, `packages/gateway/src/web/auth/csrf.ts`, `packages/gateway/src/web/auth/github.ts`, `packages/gateway/src/web/auth/repo-authz.ts`, `packages/gateway/src/web/operator/route-helpers.ts`, `packages/gateway/src/web/sse/run-stream-route.ts`, `packages/gateway/src/web/operator-push/subscription-store.ts`, `packages/gateway/src/bindings/store.ts`, `packages/gateway/src/redaction/denylist.ts`, `packages/gateway/src/redaction/surface-gate.ts`, `packages/gateway/src/discord/commands/add-project.ts`, `packages/gateway/src/config.ts`, `packages/gateway/src/program.ts`, `packages/gateway/src/shutdown.ts`, `packages/runtime/src/object-store/s3-adapter.ts`
- Related plan: `docs/plans/2026-06-20-001-feat-authenticated-sse-run-stream-route-plan.md`
- Learnings: `docs/solutions/best-practices/authenticated-sse-run-observation-2026-06-20.md`, `docs/solutions/best-practices/web-operator-launch-surface-2026-06-20.md`, `docs/solutions/best-practices/dependency-gated-route-registration-guard-2026-06-25.md`, `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md`, `docs/solutions/best-practices/s3-restore-needs-listbucket-and-prefix-scope-2026-08-12.md`
- External: OWASP Session Management Cheat Sheet; OWASP ASVS 5.0 V7.1.1 and V7.2.4; RFC 6265bis (cookie prefixes and `Max-Age`); WebKit tracking prevention, storage and cookie lifetime limits
