---
title: Gateway OpenCode mention-loop best practices
date: 2026-05-30
last_updated: 2026-06-10
category: best-practices
module: gateway
problem_type: best_practice
component: assistant
severity: high
related_components:
  - runtime
  - workspace-agent
  - discord
  - coordination
applies_when:
  - remote-attaching a gateway to a workspace-bound OpenCode server
  - forwarding authorization across both HTTP and SSE event streams
  - recovering stale execution runs after a restart
  - streaming partial agent output during long-running sessions
  - enforcing single-run ownership and timeout cleanup
tags:
  - gateway
  - opencode
  - remote-attach
  - sse
  - bearer-token
  - recovery
  - stream-flush
  - abort-signal
---

# Gateway OpenCode mention-loop best practices

Patterns from the gateway `@fro-bot` mention loop — an authorized Discord mention in a
bound channel drives an OpenCode session against the cloned repo. This is the **Discord
transport** of the gateway's transport-neutral execution engine; the engine also drives
the operator web read (SSE) and write (launch) transports — see
[gateway-control-surface-spine](gateway-control-surface-spine-2026-06-15.md). Captured
after the work cleared an 11-reviewer review pass plus a Fro Bot review that caught a P0
(recovery lock ownership) and a blocking UX gap (partial output discarded on failure).
These are the
load-bearing decisions worth reusing in later gateway units.

Adjacent docs (different angle, not duplicates):
- `discord-slash-command-orchestration-patterns-2026-05-27.md` — the `/add-project`
  orchestration side (members.fetch auth, partial-failure recovery, IAT handling).
- `signed-webhook-ingress-hardening-2026-05-29.md` — the inbound webhook trust boundary
  (fail-closed auth, never-log-secret, no auth oracle).
- `./architectural-issues-type-safety-and-resource-cleanup.md` — the
  finally-guaranteed cleanup discipline this doc's dual-finally sharpens.

## Context

Unit 6 needed the gateway (one container) to drive OpenCode against a repo checked out in a
sandboxed workspace container. The instinct is to treat "OpenCode in another container" as a
special transport. It is not — and the wrong instinct leads to either breaking the sandbox
(running OpenCode in the gateway against a shared volume) or rebuilding the whole execution
loop inside the workspace. The patterns below are the middle path: reuse the proven HTTP+SSE
transport, put a thin auth boundary in front of it, and harden the failure and recovery edges
that only show up under crashes, timeouts, and concurrent triggers.

## Guidance

### 1. Remote attach is the same transport as in-process

`createOpencode()` is `createOpencodeServer()` + `createOpencodeClient({baseUrl})` talking over
HTTP+SSE. "Remote attach" is just pointing `baseUrl` at another container — no special mode.
Crucially, the SDK's SSE path (`event.subscribe`) is **fetch-based, not `EventSource`**, so a
custom `Authorization` header survives on the `/event` stream, not only on HTTP calls. Verify
this kind of transport assumption with a throwaway spike before building on it.

```ts
// packages/runtime/src/agent/remote-client.ts
const client = createOpencodeClient({baseUrl, headers})
return {client, server: {url: baseUrl, close: () => {}}, shutdown: () => {}}
```
```ts
// packages/gateway/src/execute/opencode-attach.ts — header injected here, never logged
export function attachOpencode(baseURL: string, token: string): OpenCodeServerHandle {
  return createRemoteOpenCodeHandle(baseURL, {Authorization: `Bearer ${token}`})
}
```

### 2. Bearer-token reverse proxy fronting a loopback-bound server

OpenCode's SDK server has **no native auth**. So bind it to `127.0.0.1` only and make a
bearer-token reverse proxy the sole sandbox-net-reachable surface. The proxy validates with
`timingSafeEqual` (length pre-check, then constant-time compare) and rejects with a fixed 401
body. Network isolation + proxy auth together are the trust model; neither alone is.

```ts
// apps/workspace-agent/src/main.ts
const OPENCODE_PORT = 54321
const OPENCODE_HOSTNAME = '127.0.0.1' // loopback only — never sandbox-net
const PROXY_PORT = 9200               // the only reachable surface
```
```ts
// apps/workspace-agent/src/opencode-proxy.ts
let authorized = false
if (presentedBuf.length === expectedBuf.length) authorized = timingSafeEqual(presentedBuf, expectedBuf)
if (authorized === false) { res.writeHead(401, {'Content-Type': 'text/plain'}); res.end(UNAUTHORIZED_BODY); return }
```

### 3. Gate stale-run lock release on `run_id` ownership

Startup recovery sweeps runs left in a non-terminal phase by a crash → transitions them
`FAILED`. The sweep now covers `PENDING` and `ACKNOWLEDGED` (pre-execution admitted runs)
in addition to `EXECUTING`, since admission writes a durable `PENDING` before execution; the
heartbeat-staleness window excludes a just-admitted run so it is never killed mid-admission.
Only `EXECUTING` runs hold a repo lock, so lock release applies to that phase alone. When
releasing, it must **verify the current lock record's `run_id` matches the
stale run before releasing**. A stale run-state whose lease already expired may have had its
lock re-acquired by a newer, live run; releasing blindly deletes the newer run's lock and
permits concurrent execution against the same repo. This was a P0.

The canonical recovery entry point is `recoverStaleRuns` (`packages/gateway/src/execute/recovery.ts`),
which calls the internal `recoverOneRun` helper per stale run. Both `getLockKey` and `getRunKey`
are the exported key builders from `packages/runtime/src/coordination/lock.ts` and
`packages/runtime/src/coordination/run-state.ts` respectively — never construct these keys
ad-hoc. See also: `docs/solutions/best-practices/centralize-s3-key-identity-construction-2026-06-09.md`.

```ts
// packages/gateway/src/execute/recovery.ts (inside recoverOneRun)
// Key builders from @fro-bot/runtime — single source of truth for key shape:
const runKeyResult = getRunKey(coordinationConfig, identity, repo, run.run_id)
const lockKeyResult = getLockKey(coordinationConfig, repo)

// Only release the lock when it belongs to this stale run:
const lockFetch = await fetchLockRecord(coordinationConfig, lockKeyResult.data, logger)
if (lockFetch !== null) {
  if (lockFetch.runId === run.run_id) {
    await releaseLock(coordinationConfig, repo, lockFetch.etag, coordLogger)
  } else {
    logger.warn(
      {runId: run.run_id, repo, lockRunId: lockFetch.runId},
      'recovery: lock.run_id does not match stale run — skipping release (lock belongs to a different run)',
    )
  }
}
```

An unparseable/missing `run_id` resolves to `null` → skip the release (fail safe: never delete
a lock you cannot prove belongs to the stale run).

`forceReleaseStaleLock` (`packages/runtime/src/coordination/lock.ts`) is the dual-signal
(lease-expired + heartbeat-stale) variant used outside the startup sweep; it also calls
`getLockKey` internally and guards the read→delete race with an `IfMatch` conditional delete.

### 4. Flush partial output on failure paths

A streaming sink flushed only on the success path silently discards everything on
timeout/error — so the most expensive failure (a 600s timeout) yields the least information.
Flush buffered output best-effort **in the catch path, before the coarse error reply**, in its
own try/catch so a flush failure cannot mask the original error. Guard against double-post.

The coarse user message is sent via `sendMessage` from `discord/io.ts` (the old `safeSend`/
`safeReply` local helpers in `run.ts` have been deleted; all Discord content sends now go
through `discord/io.ts`).

```ts
// packages/gateway/src/execute/run.ts (catch path)
if (sink !== null) {
  await sink.flush().catch((flushError: unknown) =>
    logger.warn({repo, runId, err: String(flushError)}, 'run: sink.flush failed in error path'))
}
// ...then send the coarse, detail-free user message via sendMessage (discord/io.ts):
await sendMessage(thread, {content: userMessage}, logger)
```

### 5. Bounded execution + guaranteed resource release

Thread `AbortSignal.timeout(runTimeoutMs)` into the event loop so a hung stream can't run
forever. Release resources in nested `finally` blocks: inner releases the lock + stops the
heartbeat, outer **always** releases the concurrency slot — both survive the timeout/throw
path.

```ts
// packages/gateway/src/execute/run.ts
const timeoutSignal = AbortSignal.timeout(runTimeoutMs)
try {
  try {
    await runOpenCodeCore({handle, directory: binding.workspacePath, promptText, sink, signal: timeoutSignal, logger})
  } finally {
    if (heartbeatStopped === false) await heartbeat.stop().catch(() => {})
    await releaseLock(coordinationConfig, repo, lockEtag, coordLogger)
  }
} finally {
  concurrency.release(channelId) // always, even on throw
}
```

### 6. EOF before the terminal signal is a failure; classify auth by status, not text

A stream that ends **without** `session.idle` must throw (run marked `FAILED`), not resolve as
`COMPLETED` — otherwise a dropped connection looks like success while the agent may still be
mutating the repo. Separately, classify auth errors by **numeric status (401/403) only**;
substring-matching "401"/"unauthorized"/"forbidden" in a stringified error misclassifies
unrelated errors whose payload happens to contain those tokens.

```ts
// packages/gateway/src/execute/run-core.ts
// signal aborted → 'timeout'; stream ended without session.idle → 'stream-ended' (both throw)
// auth detection: trust response.status === 401 || response.status === 403 only
```

## Why This Matters

- **Transport clarity** — knowing remote attach is just a `baseUrl` swap (with fetch-based SSE
  that honors headers) is what makes the bearer-proxy boundary viable instead of a rebuild.
- **The proxy is the trust boundary** because the server has no auth of its own.
- **Ownership-gated release** prevents one stale run from deleting a newer run's lock — a
  silent concurrency-corruption P0 that no happy-path test catches.
- **Failure-path flush** preserves the only useful output in exactly the cases users care about
  most (timeouts, mid-run failures).
- **Dual-finally + AbortSignal.timeout** make hangs and throws non-catastrophic instead of
  slot/lock leaks that wedge a channel until the next restart.
- **Terminal-signal correctness** stops dropped streams from masquerading as completed work;
  **numeric auth classification** avoids false "workspace unreachable" replies.

## When to Apply

- Attaching OpenCode (or any SDK server) across containers/hosts over HTTP+SSE.
- Fronting a no-auth local server with a bearer-token boundary.
- Recovering stale leases/locks at startup where another holder may have taken over.
- Streaming output to a user-visible sink during long-running async work.
- Any long-running orchestration with concurrency caps and a per-resource lock.
- Consuming SSE where the terminal event (not EOF) defines success.

## Examples

**Remote attach** — `createRemoteOpenCodeHandle(baseUrl, {Authorization: 'Bearer ' + token})`;
`event.subscribe()` carries the header because the SDK SSE path is fetch-based.

**Proxy security** — bind OpenCode to `127.0.0.1`; expose only the reverse proxy; verify the
bearer with `timingSafeEqual`; reject with a fixed 401 body.

**Recovery** — read the current lock record; release only when `lockFetch.runId === run.run_id`;
skip on mismatch or unparseable record.

**Failure handling** — best-effort `sink.flush()` inside catch, then the coarse user reply;
never let a flush failure hide the real error.

**Lifecycle** — `AbortSignal.timeout(runTimeoutMs)`; inner finally = heartbeat stop + lock
release; outer finally = concurrency slot release.

**Stream correctness** — `session.idle` = success; EOF without idle = `stream-ended` (throw);
auth detection by `401/403` status, not message text.
