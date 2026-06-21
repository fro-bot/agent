---
title: 'Web operator launch surface: fire-and-return, server-owned resolution, denylist-before-authz on a write route'
date: 2026-06-20
category: best-practices
module: gateway
problem_type: best_practice
component: authentication
severity: high
applies_when:
  - Adding a non-Discord write route that launches work through the transport-neutral launchWork engine
  - Returning a caller-owned runId from a fire-and-return route that must not hold the HTTP connection for the run
  - Resolving a client-named repo to a binding server-side, denylist-first, before any authorization call
  - Choosing an approval transport for a surface that has no thread to post approvals into
  - Adding per-operator idempotency namespacing and operator-keyed rate limits to a write route
tags:
  - gateway
  - launch
  - operator
  - write-route
  - transport-agnostic
  - denylist
  - no-oracle
  - idempotency
---

# Web operator launch surface: fire-and-return, server-owned resolution, denylist-before-authz on a write route

## Context

The gateway operator web surface gained the ability to **launch** work from the browser: `GET /operator/repos` lists the repos an operator may launch in, and `POST /operator/runs` starts a run in one — through the same transport-neutral `launchWork` engine the Discord mention loop uses (`packages/gateway/src/execute/run.ts`). The engine was already transport-neutral: `LaunchWorkRequest` (`packages/gateway/src/execute/launch-types.ts`) is a pure data structure the Discord adapter (`runMention`) populates. The launch surface added three additive, optional engine seams (`runId?`, `promptBuilder?`, `createApprovalOnPending?`) so a new HTTP transport could drive the engine without the engine learning about HTTP.

This is the **write** counterpart to [authenticated-sse-run-observation](authenticated-sse-run-observation-2026-06-20.md) (the read/observe transport) — same operator surface, same no-oracle and redaction-before-authz discipline, different shape (fire-and-return vs long-lived stream). It is the second transport built on the [gateway-control-surface-spine](gateway-control-surface-spine-2026-06-15.md) seam, which explicitly anticipated exactly these additive inputs.

Several patterns below were load-bearing safety properties, not conveniences: without the auto-deny approval transport a web launch would deadlock its repo's lock for ~13 minutes; without the empty-string `runId` guard the additive seam would silently corrupt run ids. They are written down so the next transport gets them for free.

## Guidance

### 1. Fire-and-return: the route owns the runId and never awaits the run

`launchWork` awaits the **entire run** on the immediate-slot path. An HTTP route that awaited it would hold the connection open for the whole run budget (minutes). Instead the route owns the `runId`, registers it, fires `launchWork` **without** `await`, logs the returned promise's rejection, and returns `202 {runId}` immediately. The operator then observes the run over the SSE stream.

The snippet below is the fire-and-return tail only. In the real route the run id is generated and the run registered **after** the pre-launch gates, so the full order is: resolve binding (server-owned) → denylist → authz → generate runId + register → fire. Don't register before the repo is resolved and authorized.

```ts
const request = {
  promptText: promptField, runId, channelId: `web:${owner}/${repo}`,
  surface: 'web' as const, binding, requester: operatorIdentity,
  statusSink: createWebStatusSink(), replySink: createWebReplySink(),
  createApprovalOnPending: createWebAutoDenyApproval(deps.logger),
  promptBuilder: buildWebPrompt,
}
const launchWorkPromise = launchWork(request, deps.launchWorkDeps) // NOT awaited
void launchWorkPromise.catch((error: unknown) =>
  deps.logger.error(
    {githubUserId, runId, owner, repo, err: error instanceof Error ? error.message : String(error)},
    'launch: background run failed',
  ),
)
return c.json({runId}, 202)
```

Run admission was later moved into `launchWork` itself, so a queued run and a run that fails before execution both produce an observable `RunState` from the moment they are accepted (the route awaits admission, then commits idempotency). A `202`'d `runId` is therefore observable over SSE for every accepted disposition, not just the immediate-run happy path.

### 2. Server-owned repo resolution on a write route

The client names a repo as an `owner/repo` string; the server resolves it via `getBindingByRepo` and ignores any client-supplied binding, path, or owner tuple. The denylist check runs **before** authorization (a denylisted repo never triggers a GitHub call), and every pre-launch denial returns the same coarse shape — so an attacker cannot tell "does not exist" from "exists but denylisted" from "exists but you lack access."

```ts
const bindingResult = await deps.bindingsLookup.getBindingByRepo(owner, repo) // server-owned
if (bindingResult.success === false || bindingResult.data === null) return c.json({error: 'not-found'}, 404)
const binding = bindingResult.data

if (deps.isRepoDenied(bindingToRepoKey(binding)) === true) return notFoundResponse(c)        // redaction
const authzResult = await checkRepoAuthz(githubUserId, owner, repo, token, deps.repoAuthzDeps) // then authz
if (authzResult.authorized === false) return notFoundResponse(c)
```

This is the same discipline as the SSE route, applied to a write surface. The distinction: a write route may return a differentiated `4xx/5xx` for *post-acceptance* failures (a bad body, an over-cap rate limit), but the *pre-launch* gates must collapse to a single generic rejection to avoid a pre-launch oracle.

### 3. Auto-deny approval transport to avoid a lock-deadlock

A web launch has no interactive approval UX. If the engine falls through to its default Discord approval transport, it `postReply`s to a thread that does not exist for a web run **and holds the per-repo lock until the ~13-minute approval deadline — blocking every other run in that repo, web and Discord.** The fix is to supply a `createApprovalOnPending` that auto-denies every permission request immediately (`'reject'`, fire-and-forget, best-effort log), so the engine never selects the Discord transport.

```ts
export function createWebAutoDenyApproval(logger?: OperatorLogger) {
  return (ctx: ApprovalTransportContext) => (req: PermissionRequest): void => {
    const postReply = ctx.postReplyFactory(req.sessionID)
    void postReply(req.requestID, ctx.directory, 'reject').catch((error: unknown) =>
      logger?.warn(
        {runId: ctx.runId, repo: ctx.repo, err: error instanceof Error ? error.message : String(error)},
        'web-approval: auto-deny postReply failed (best-effort; coordinator deadline will settle fail-closed)',
      ),
    )
  }
}
```

Implication for callers: a web-launched run can only complete work that needs **no** tool approval until a real interactive web approval transport ships. This is the right v1 posture — fail fast, never deadlock — and the deferred replacement is tracked, not forgotten.

### 4. Additive, optional engine seams keep the other transport byte-identical

The three seams are `readonly runId?`, `readonly promptBuilder?`, `readonly createApprovalOnPending?` on `LaunchWorkRequest`. When absent, the engine takes its prior path — `crypto.randomUUID()`, `buildDiscordPrompt`, `createDiscordApprovalOnPending` — so the Discord adapter is unchanged and its regression tests are pinned. The `runId` seam carries an **empty-string guard**: a caller passing `''` falls back to a generated id rather than corrupting the run.

```ts
const runId = request.runId !== undefined && request.runId !== '' ? request.runId : crypto.randomUUID()
const promptText = request.promptBuilder === undefined ? buildDiscordPrompt({...}) : request.promptBuilder({...})
const onPending = request.createApprovalOnPending === undefined
  ? createDiscordApprovalOnPending({...}) : request.createApprovalOnPending(ctx)
```

The `?? default` (or `=== undefined ? default : ...`) selection is the single point where the other transport's behavior is preserved. Skipping the empty-string guard is exactly how an "additive" change silently regresses.

### 5. Scoped enumeration: denylist-filter, then per-repo authz, hard cap, closed DTO

A repo list must not let an allowed operator enumerate unrelated repositories. The working set is built in strict order: `listBindings` → `filterDeniedRecords` (denylist-first, before any authz call) → hard cap → per-binding `checkRepoAuthz`, keeping only repos the operator actually accesses. Denied/unauthorized repos are silently omitted (not differentiated). The projection is closed by construction — it copies only the display-safe fields, never spreads the binding — so a future internal binding field cannot leak.

```ts
const result = await deps.listBindings()
if (result.success === false) return c.json({error: 'unavailable'}, 503)
const allowed = filterDeniedRecords(result.data, bindingToRepoKey, deps.isRepoDenied)
const capped = allowed.slice(0, MAX_REPOS_PER_LISTING)
const authorized = []
for (const b of capped) {
  const r = await checkRepoAuthz(githubUserId, b.owner, b.repo, token, deps.repoAuthzDeps)
  if (r.authorized === true) authorized.push(b)
}
return c.json(authorized.map(toRepoSummary), 200) // toRepoSummary copies {owner, repo, channelName?} only
```

Rate-limit the list **per operator** (not per socket, not per repo): the per-request authz fan-out is up to one GitHub call per bound repo, so an unlimited list route is an OAuth-budget self-DoS.

### 6. Per-operator idempotency namespace

The launch route accepts an optional `idempotencyKey`. The guard namespaces it as `${githubUserId}:${clientKey}` so operator A cannot replay operator B's key to suppress B's launch. Storage is a bounded in-memory map with a TTL; eviction reclaims **expired** entries before live ones, and updating an existing key does not evict a different live key.

```ts
function makeKey(githubUserId: number, clientKey: string): string {
  return `${githubUserId}:${clientKey}` // per-operator — A cannot suppress B
}
```

Residual risk to state plainly: the in-memory table is lost on restart (a client retrying within the window can double-launch). The two-phase reserve/commit lifecycle (reserve before admission, commit on accept, roll back on reject or throw) means a rejected launch no longer leaves a key echoing a dead runId.

### 7. Centralize the binding deny-key extraction (one owner)

Every denylist check across the operator routes and the redaction gate derives the binding's `{databaseId, nodeId}` deny-key through one helper, so the extraction shape — and the rule that a missing/wrong-typed key is `null` and therefore fail-closed — lives in exactly one place.

```ts
export function bindingToRepoKey(binding: {readonly databaseId?: number; readonly nodeId?: string}): RepoKey {
  return {
    databaseId: typeof binding.databaseId === 'number' ? binding.databaseId : null,
    nodeId: typeof binding.nodeId === 'string' ? binding.nodeId : null,
  }
}
```

This applies the [centralize-s3-key-identity-construction](centralize-s3-key-identity-construction-2026-06-09.md) rule to a third key family (binding deny-keys, alongside lock and run-state).

## Why This Matters

The auto-deny transport (rule 3) and the fire-and-return runId ownership (rule 1) are the two properties that make a browser-driven launch surface safe and live: one prevents a repo-wide lock-deadlock, the other prevents an HTTP connection hanging for the whole run. The server-owned resolution + denylist-before-authz (rules 2, 5) close the pre-launch oracle on a write route, the additive seams (rule 4) keep the Discord transport byte-identical (a real regression risk on shared engine code), and the per-operator idempotency namespace (rule 6) stops cross-operator suppression. Several of these would have shipped wrong without the discipline — the empty-string `runId` and the Discord-fallthrough lock-deadlock were both caught because the patterns were applied deliberately.

## When to Apply

- Adding any non-Discord transport (web, CLI, API) that drives `launchWork`: own the runId, register before firing, never await, supply the three seams (or inherit Discord defaults — not what a new transport wants).
- Any write route where redaction must run before an external authz call and pre-acceptance denials must be indistinguishable.
- A surface with no human approval channel: auto-deny tool approvals rather than fall through to a transport that holds the lock.
- Scoped per-operator enumeration: reuse the `listBindings → filterDeniedRecords → per-repo authz → closed DTO` sequence and rate-limit per operator.
- Any new denylist check: route through `bindingToRepoKey` rather than re-extracting the fields.

## Examples

**Idempotency echo on the launch route** (duplicate within the window returns the same runId, no double launch):

```ts
if (idempotencyKey !== undefined) {
  const priorRunId = deps.idempotencyGuard.check(githubUserId, idempotencyKey)
  if (priorRunId !== undefined) return c.json({runId: priorRunId}, 202) // echo, no re-launch
}
```

**Reject a non-plain-object body** (`typeof [] === 'object'`, so the array check is required before treating the body as a record):

```ts
if (body === null || typeof body !== 'object' || Array.isArray(body)) return c.json({error: 'bad request'}, 400)
```

## Related

- [gateway-control-surface-spine-2026-06-15.md](gateway-control-surface-spine-2026-06-15.md) — the transport-neutral execution/approval seam this launch surface is the **write** transport on. It implements the additive `runId` / `promptBuilder` / `createApprovalOnPending` inputs the spine carved; the spine's consolidation note anticipated this doc.
- [authenticated-sse-run-observation-2026-06-20.md](authenticated-sse-run-observation-2026-06-20.md) — the **read counterpart** on the same operator surface. Its rules (redaction-before-authz, server-owned resolution, closed-DTO, denylist-prime) apply unchanged here; the difference is fire-and-return vs long-lived stream and the allowance for differentiated post-acceptance errors.
- [centralize-s3-key-identity-construction-2026-06-09.md](centralize-s3-key-identity-construction-2026-06-09.md) — `bindingToRepoKey` is a third key family under the same one-owner-one-builder discipline.
- [atomic-serial-channel-queue-handoff-2026-06-09.md](atomic-serial-channel-queue-handoff-2026-06-09.md) — the launch surface threads `launchWork` with a synthetic per-operator/per-repo `channelId`; the FIFO + cap + shutdown discipline is respected by reuse, not extended.
- Shipped via PR #968 under issue #907; the redaction-before-authz invariant is anchored by #950 and the operator-auth authority by #951. Run lifecycle admission moved into `launchWork` (queued/failed runs observable, two-phase idempotency) as a follow-up. Remaining deferred work: #965 (stream web-launched run output to the operator).
