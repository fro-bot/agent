---
title: "feat: Broker remote MCP header credentials under isolate-agent"
type: feat
status: active
date: 2026-11-27
---

# feat: Broker remote MCP header credentials under isolate-agent

## Overview

Under `isolate-agent`, each remote MCP server that has `headers` is reached through the key-proxy child. The agent-readable server config points the server at a loopback route and carries no header values. The child holds the values and adds them to every request it forwards to the server's fixed HTTPS upstream. Provider keys already work this way. In this plan, "the broker" means that same child serving MCP routes.

## Problem Frame

Every value in `opencode-config` is readable by the agent in every mode (#2371). The Action passes the merged config to the server as `OPENCODE_CONFIG_CONTENT`. The server's tools inherit it. Under isolation the server and its tools run as the same sandbox user. On `schedule` and `workflow_dispatch` runs, remote MCP servers survive filtering with their `headers` as written, so a bearer token for an MCP server is handed to the model. The docs already say so (#2380). This plan removes that exposure for isolated runs.

The broker hides the credential. It does not limit what the credential can do. The agent's shell can call any tool through the loopback route, so a scoped upstream token is the operator's control over authority. Non-isolated runs don't change: the agent there runs as the runner user and can read the Action's own `INPUT_OPENCODE-CONFIG`.

## Requirements Trace

- R1. On an isolated provisioning run, no remote MCP header value is in anything the Action hands the sandbox: the server config (traced and untraced), the environment, argv, files, logs or traces. An upstream that returns its own credential in a response is outside this promise. It is trusted with the credential, as provider upstreams are.
- R2. Every brokered server still works. OpenCode 2.4.2 initializes, lists tools, calls tools, recovers an expired session and closes through the broker, and the upstream receives the configured headers.
- R3. A run fails if the child can't start. If the child dies mid-run, the run ends unsafe and its session isn't saved, the same as the key proxy today. No run falls back to a direct connection.
- R4. Configurations the broker can't protect are refused before the sandbox starts.
- R5. Provider routes, the key-proxy probe, per-trigger MCP filtering and non-isolated behaviour don't change.
- R6. The docs state what is protected, what isn't, and how to fix each refusal.

## Scope Boundaries

- No tool-level or method-level policy, because the shell has the route anyway. Use a scoped upstream token.
- No OAuth. A brokered entry that carries an `oauth` object is refused. OpenCode's own OAuth login is unchanged for servers without `headers`.
- No containment of credentials an upstream echoes back (see R1).
- Local-server `environment` values stay agent-readable, as documented.
- No change to which triggers keep remote MCP servers (`schedule`, `workflow_dispatch`).
- No legacy two-endpoint HTTP+SSE transport. OpenCode 2.4.2's remote client constructs only Streamable HTTP.

### Deferred to Separate Tasks

- Brokering secrets in local MCP servers' `environment`: this needs a stdio bridge. File an issue if it's wanted.
- A shared supervisor for the key proxy and the trace relay: a refactor, separate PR.

## Context & Research

Research reports (local, untracked): `/tmp/mcp-broker/{repo,external,past,flow}.md`.

### Relevant Code and Patterns

- `src/services/setup/mcp-servers-v2.ts`:
  - parsing (`parseServer`, both the `mcp.<name>` and `mcp.servers.<name>` layouts)
  - reference detection (`isReference`)
  - the `isEnabledOnly` skip in `readMcpLayout`
  - per-trigger filtering (`applyOperatorMcpV2`). On `provision`, it returns the operator config unchanged.
- `src/services/setup/ci-config-v2.ts` (`buildCIConfigV2`): providers get a proxy rewrite, and `mcp` has none. `src/harness/phases/v2-server.ts` calls it twice in `prepareRun`, once traced and once untraced.
- `src/services/setup/key-proxy-providers.ts`: `resolveKeyProxyProviders` refuses bypasses structurally. `checkConfigForKeys` scans the serialized config by value.
- `packages/runtime/src/agent/key-proxy.ts`, `key-proxy-routes.ts`, `key-proxy-wire.ts`, `key-proxy-child.ts`, `forwardable-target.ts`: the child, its exact route table and header allowlist, its refusal of redirects and 101 responses, error-body redaction, and the existing `maxConnections` and timeouts.
- `src/harness/phases/key-proxy-process.ts` and `startProxyUnderLifecycle` in `v2-server.ts`: the supervisor and the one proxy slot in `src/harness/phases/sandbox-lifecycle.ts`, covering `died`, take-back and the crash latch.
- `src/harness/phases/v2-server.sandbox.integration.test.ts`: the key-proxy canary block and its scanner.

### Institutional Learnings

- `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md`: the pattern, its dead ends (a field-name denylist, a placeholder check, failing on 403), and the rule that every `opencode-config` value is agent-readable.
- `docs/solutions/best-practices/separate-uid-is-not-a-boundary-on-hosted-runners-2026-11-17.md`: what isolation does and doesn't separate.

### External References

- MCP Streamable HTTP, revisions 2025-06-18 and 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http. The 2026 revision drops sessions, GET/DELETE and `Last-Event-ID` resume.
- MCP security best practices (token passthrough, SSRF): https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices
- The OpenCode 2.4.2 remote client, `packages/core/src/mcp/client.ts` at tag `v2.4.2`, with anomalyco/opencode#61867. Points that matter here:
  - It uses Streamable HTTP only.
  - It sends `Mcp-Param-*` headers derived from each server's tool schema.
  - It treats a session-bearing 400 whose body contains `Server not initialized` as an expired session, and reconnects.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "fro-bot/agent: packages/runtime/src/agent, src/harness/phases, src/services/setup",
  "freshness": {
    "vcs_reference": "e18e18a9"
  },
  "budget": {
    "max_search_passes": 3,
    "max_candidate_inspections": 8,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "packages/runtime/src/agent/key-proxy.ts",
      "description": "Runner-side loopback child holding provider keys; exact route table, header allowlist, credential injected last, redirect/101 refusal, error-body redaction; one lifecycle slot",
      "disposition": "extend"
    },
    {
      "path_or_symbol": "packages/runtime/src/agent/trace-relay.ts",
      "description": "Runner-side loopback relay to one fixed collector; fail-soft supervisor",
      "disposition": "insufficient",
      "insufficiency_reason": "Fail-soft by design and a single fixed destination; a credential broker must fail closed and serve many routes"
    },
    {
      "path_or_symbol": "src/services/setup/mcp-servers-v2.ts#applyOperatorMcpV2",
      "description": "Per-trigger MCP filtering and parsing for both config layouts",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **Extend the key-proxy child rather than add a third child.** The lifecycle has one proxy slot, and its `died`, take-back and crash-latch handling already protect the run. MCP routes get their own dispatch inside the child, separate from the provider routes.
- **Brokering is automatic, keyed on whether an entry has `headers`.** On an isolated provisioning run, every active remote entry with a `headers` key is brokered, including `headers: {}`. Header names are never used to guess which header is a credential.
- **Refuse every `headers` entry that can't be brokered.** Any `mcp` entry that has `headers` but isn't a brokerable active remote, and isn't definitively disabled, is refused before handoff. That covers:
  - an unresolved `type`
  - an `enabled`-only stub with extra fields
  - a local entry with `headers`
  - an entry under a key that holds a reference

  Otherwise those entries reach `OPENCODE_CONFIG_CONTENT` unscanned. Conflicting disabled flags are refused too.
- **Refuse what a brokered entry can't safely carry:**
  - `{env:}` or `{file:}` anywhere in the entry
  - an `oauth` object (`false` is accepted, and set when absent)
  - a non-HTTPS URL, userinfo or a fragment
  - a query string in the configured URL
  - an invalid header name. This is one rule: the key proxy's forbidden request headers, plus a case-insensitive duplicate check.
- **Route on method and path, not an allowlist.** Each route admits POST, GET and DELETE on its fixed local path, and passes the query through. Request headers are forwarded, except client credentials, cookies, hop-by-hop headers and forwarding headers. Configured headers are set last. A tighter allowlist would protect nothing, because the agent's shell already holds the route. Forwarding by default also carries the schema-derived `Mcp-Param-*` headers.
- **Keep the redirect, upgrade and error rules.** An upstream 3xx or 101 becomes a local 502 with no `Location` and no second request. Error bodies are replaced and `WWW-Authenticate` is dropped. One exception: a session-bearing 400 whose body contains `Server not initialized` gets a fixed body containing that sentinel, so OpenCode's reconnect still works. TLS is always verified.
- **Reuse the key proxy's limits.** It has an existing connection cap and connect, header and idle timeouts. Only the agent opens MCP streams, so the only starvation possible is the agent starving itself. The one tuning question is whether the idle timeout should be longer for MCP GET streams.
- **Mask and scan header values of 8 characters or more, plus the token after a `Bearer`, `Basic` or `Token` scheme.** These values are registered with `core.setSecret` and the trace registry as soon as they're classified, and they join the `checkConfigForKeys` value scan over both final configs. Shorter values are still held only by the broker; they just aren't scanned. That avoids false refusals on values like `1` or `v1`. The 8-character floor matches the one the trace registry uses.
- **Per-server failures stay per-server.** A config refusal, or a child that won't start, fails the run. An upstream 401, 403, 5xx or timeout leaves only that server unavailable inside OpenCode. There is no MCP start-up probe.

## Open Questions

### Resolved During Planning

- **Which child serves MCP:** the key-proxy child.
- **Non-isolated runs:** no broker, and behaviour is unchanged.
- **Echo containment:** none. R1 is narrowed, and this is the owner's decision.
- **Scan floor:** 8 characters, plus scheme tokens. This is the owner's decision.
- **MCP-only runs with no provider keys:** the child starts when either route set is non-empty. The provider probe is skipped when no provider is proxied.

### Deferred to Implementation

- **The default protocol mode on 2.4.2.** The source says `auto` and the docs say `legacy`, where `legacy` most likely means 2025 Streamable HTTP rather than HTTP+SSE. The spike in Unit 2 records it.
- **How 2.4.2 normalizes `enabled: false` against `disabled: true`.** The spike confirms what "definitively disabled" means.
- **The idle timeout for quiet MCP GET streams.** It's set from the spike's observed timings, if the current 10 minutes is too short.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
  participant A as Action (runner)
  participant P as Key-proxy child (runner)
  participant S as OpenCode server (sandbox user)
  participant U as MCP upstream (HTTPS)
  A->>A: parse opencode-config, filter by trigger
  A->>A: classify entries with headers, refuse the unbrokerable, mask values
  A->>P: spawn, one stdin frame {providers, mcp routes + headers}
  P-->>A: ready (loopback port)
  A->>A: rewrite mcp urls to 127.0.0.1:port/mcp/<id>, drop headers, scan both configs
  A->>S: launch (config has no header values)
  S->>P: POST|GET|DELETE /mcp/<id>?... (no credential)
  P->>U: fixed origin + path, client credentials stripped, configured headers last
  U-->>P: JSON or SSE
  P-->>S: streamed through; 3xx/101 -> 502; error bodies replaced
```

## Implementation Units

- [x] **Unit 1: Classify, refuse, rewrite and start the child**

**Goal:** On an isolated provisioning run, every `mcp` entry with `headers` either becomes a broker route plus a rewritten entry (loopback URL, no headers, `oauth: false`) or makes the run fail before handoff. The child starts whenever there are provider routes or MCP routes.

**Requirements:** R1, R3, R4, R5

**Dependencies:** None. Unit 2 consumes the route shape.

**Files:**
- Modify: `src/services/setup/mcp-servers-v2.ts` (classification and refusals, both layouts)
- Modify: `src/services/setup/ci-config-v2.ts` (rewrite step beside the provider rewrite, used by both config variants)
- Modify: `src/services/setup/key-proxy-providers.ts` (`checkConfigForKeys` takes the masked header values and scheme tokens)
- Modify: `src/harness/phases/v2-server.ts` (plan routes before the child starts, start condition, provider probe only when a provider is proxied, mask values)
- Test: `src/services/setup/mcp-servers-v2.test.ts`, `src/services/setup/ci-config-v2.test.ts`, `src/services/setup/key-proxy-providers.test.ts`, `src/harness/phases/v2-server.test.ts`

**Approach:**
- Classify after per-trigger filtering, on the original entries rather than the parsed result. A server dropped on a withholding trigger gets no route and no error.
- Give each brokered entry an opaque route id that can't collide with provider ids.
- Plan routes once. Then start the child, rewrite, and scan both configs. If the scan fails after the child is ready, stop the child before returning.

**Execution note:** Test-first.

**Patterns to follow:** `resolveKeyProxyProviders` and `findProviderBypass`, and the provider rewrite in `buildCIConfigV2`.

**Test scenarios:**
- Happy path: an isolated `workflow_dispatch` run with one remote server and `Authorization: Bearer <token>` produces:
  - URL `http://127.0.0.1:<port>/mcp/<id>`
  - no `headers` key
  - `oauth: false`
  - one route that holds the header
- Happy path: the native `mcp.servers.<name>` layout gets the same result.
- Edge case: a remote without a `headers` key stays direct and unchanged.
- Edge case: `headers: {}` is brokered with zero headers.
- Edge case: two remotes on the same origin with different paths get two routes, each with its own fixed path.
- Edge case: a definitively disabled entry has its headers stripped and gets no route.
- Error path: each of these refuses with a named reason that contains no value:
  - an unresolved `{env:}` `type` carrying `headers`
  - an `enabled`-only stub with `headers`
  - a local entry with `headers`
  - an entry under a key that holds a reference
  - conflicting disabled flags
  - `Bearer {env:TOKEN}`
  - `{file:}` anywhere in the entry
  - `oauth: {}`
  - `http://`
  - userinfo
  - a fragment
  - a configured query string
  - `Host`
  - `Connection`
  - `Transfer-Encoding`
  - two names that differ only in case
- Error path: the bare token from `Bearer <token>`, copied into a local `environment` value, fails `checkConfigForKeys` for both the traced and the untraced config.
- Edge case: a 2-character header value that also appears elsewhere in the config is brokered and doesn't refuse the run.
- Integration: an MCP-only run (no `auth-json` provider) starts the child, skips the provider probe and launches.
- Integration: a run with no routes starts no child.
- Integration: if the child never becomes ready, the run fails with a reason that contains no value, and no server starts.
- Integration: a withholding trigger (`issue_comment`) with a credentialed remote still drops it, with no broker error and no route.
- Integration: a non-isolated run keeps the entry as written.

**Verification:**
- No serialized final config contains any masked value.
- Every refusal reason has a test.

- [x] **Unit 2: Serve MCP routes in the key-proxy child**

**Goal:** The child relays each brokered route to its fixed upstream. It strips client credentials, sets the configured headers last, refuses redirects and upgrades, replaces error bodies, and keeps OpenCode's session recovery working.

**Requirements:** R2, R5

**Dependencies:** Unit 1 (route shape)

**Files:**
- Modify: `packages/runtime/src/agent/key-proxy-wire.ts` (version bump, bounded `mcp` routes)
- Create: `packages/runtime/src/agent/mcp-routes.ts` (route lookup and request/response header rules)
- Modify: `packages/runtime/src/agent/key-proxy.ts` (MCP dispatch separate from provider routes)
- Modify: `packages/runtime/src/agent/key-proxy-child.ts`
- Create: `packages/runtime/src/agent/mcp-wire.fixtures.ts` (exchanges recorded in the spike, used by the replay tests)
- Test: `packages/runtime/src/agent/key-proxy.test.ts`, `packages/runtime/src/agent/mcp-routes.test.ts`

**Approach:**
- Start with a short spike. Run the pinned 2.4.2 binary against a 2025 stateful fake and a 2026 stateless fake, with synthetic values. Record methods, targets, protocol headers, the default protocol mode, disabled-flag handling and stream timings. Re-pin `.slim/clonedeps` to 2.4.2 first. Keep the spike's harness out of the committed tests. Only its recorded exchanges become fixtures.
- Match routes by local path. Admit POST, GET and DELETE, and pass the query through. Forward request headers except `authorization`, cookies, hop-by-hop headers and forwarding headers. Set configured headers last.
- For responses: an upstream 3xx or 101 becomes a 502 with no `Location`. An error body becomes a fixed body. A session-bearing 400 containing `Server not initialized` becomes a fixed body with that sentinel. `WWW-Authenticate` is dropped, and a sanitized `Retry-After` is kept. 2xx JSON and SSE stream through with backpressure.
- Use the existing connection cap and timeouts.

**Patterns to follow:** `key-proxy-routes.ts`, the `upgrade`/`connect`/socket error handling in `key-proxy.ts`, and `https.request` rather than `fetch`.

**Test scenarios:**
- Happy path: each recorded exchange replays through the child to a fake upstream. The upstream gets the configured headers and none of the client's credentials. The client gets the upstream's status, body, `Mcp-Session-Id` and SSE events in order.
- Happy path: a request carrying `Mcp-Param-*` headers arrives upstream with them intact.
- Edge case: a client-sent `Authorization` or `Cookie` is never forwarded, and the configured value wins.
- Edge case: a path that matches no route, or a method other than POST, GET or DELETE, is refused locally with no contact to the upstream.
- Error path: an upstream 302 or 307 to the same origin returns 502 with no `Location`, and the fake sees exactly one request.
- Error path: an upstream 101 returns 502.
- Error path: an upstream 401 with `WWW-Authenticate` and a body containing the credential arrives with the status kept, no challenge header, and the body replaced.
- Error path: a session-bearing 400 with `Server not initialized` arrives with the sentinel body. In the real-binary test (Unit 3), OpenCode then reinitializes.
- Integration: a provider route and an MCP route in the same child don't share state, and the provider tests pass unchanged.

**Verification:**
- The provider route tests pass unchanged, and every response rule has a test.

- [x] **Unit 3: Prove it on a real runner and a real binary**

**Goal:** Show end to end that R1 and R2 hold.

**Requirements:** R1, R2, R3

**Dependencies:** Units 1 and 2

**Files:**
- Modify: `src/harness/phases/v2-server.sandbox.integration.test.ts` (one isolated MCP canary row next to the key-proxy block)
- Modify: `src/harness/phases/execute-v2.integration.test.ts` (a real-binary tool call through the broker)

**Approach:**
- The canary row uses a unique header value and reuses the existing scanner, run as the sandbox user, across the final configs, environment, argv, `/proc`, writable files, logs and the trace sink. Its config also contains the bypass shapes from Unit 1, so that a regression in classification shows up as a refusal and never as a leak.
- In the real-binary test, a scripted model lists and calls a tool on a fake upstream that checks the header. The fake then expires the session once, and the test asserts that OpenCode reinitializes.

**Test scenarios:**
- Integration: with isolation and a brokered MCP server, the canary is `BLOCKED` for the agent user everywhere scanned, and the fake upstream saw it on every request.
- Integration: OpenCode lists and calls a tool through the broker, and the result reaches the transcript.
- Integration: after one `Server not initialized` 400, OpenCode reinitializes and the next call succeeds.

**Verification:**
- The new row passes on both sandbox images in CI.
- The real-binary test passes on the pinned version.

- [x] **Unit 4: Docs**

**Goal:** State the new boundary precisely.

**Requirements:** R6

**Dependencies:** Units 1–3

**Files:**
- Modify: `README.md`
- Modify: `action.yaml` (`opencode-config` and `isolate-agent` help text)
- Modify: `docs/wiki/Setup and Configuration.md` (MCP, isolation and tracing sections)
- Modify: `ARCHITECTURE.md` (the key-proxy entry)
- Modify: `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md` (item 9)

**Approach:** Say what's protected: remote MCP header values under isolation on provisioning triggers. Say what isn't protected:
- non-isolated runs
- local `environment` values
- what the token can do through the loopback route
- an upstream that echoes its own credential
- header values shorter than 8 characters, which aren't scanned or masked even though the broker still holds them

List each refusal with its remedy. Don't suggest turning off isolation as a fix.

**Test expectation:** none, because this unit is docs only. Run the link check, plus `scripts/action-trace-input-docs.test.ts` if `action.yaml` text is pinned.

**Verification:**
- Every refusal reason from Unit 1 has a documented remedy.

## As Built

Implementation changed these points from the plan:

- **Disabled entries.** An entry counts as disabled only in the two forms the 2.4.2 client honours: flat `enabled: false` and native `disabled: true`. Any other form on an entry with `headers` is brokered, or refused if it contradicts itself.
- **Refused before handoff, in addition to the plan's list:**
  - a top-level key built from a reference
  - a provider named `mcp`, when MCP routes exist
  - a cloud metadata host or a non-canonical path
  - more than 32 headers on one server, a value over 4,096 characters, or headers on more than 64 servers
- **Probe default.** The 2.4.2 client defaults to `auto`. It POSTs `server/discover` first and falls back to `initialize` on a non-modern 400. It never adds `?codemode=false` to a loopback URL.
- **Error bodies.** They are redacted the way the key proxy redacts provider error bodies, not replaced. Every configured value of 8 characters or more, and every scheme token, becomes `[redacted]`, and the rest passes through. JSON-RPC errors and the `Bad Request: Server not initialized` recovery body therefore reach the client with no special case.
- **Timeouts.** MCP routes have no first-byte or idle timeout, because a tool call can legitimately run long. Streams end at run teardown.
- **Wire version.** It is not bumped. The previous parser already refused a frame carrying `mcp`.
- **Files.** Unit 1 also changed `packages/runtime/src/agent/key-proxy-wire.ts`, `key-proxy-child.ts`, `index.ts` and `src/harness/phases/key-proxy-process.ts`. Unit 3 added `src/harness/phases/mcp-upstream.fixture.ts`.

## System-Wide Impact

- **Interaction graph:** the config build (both trace variants), child start, the value scan, the sandbox handoff, the server's MCP client, the existing provider probe, and teardown.
- **Error propagation:**
  - A refusal or a child start failure fails the run before launch.
  - If the child dies mid-run, the existing latch ends the run unsafe and skips the session save.
  - An upstream error shows up only as that server being unavailable.
- **State lifecycle risks:** a tool call that was in flight when the child died may already have run upstream. Nothing replays it.
- **API surface parity:** the gateway and the workspace agent don't read `mcp`.
- **Unchanged invariants:**
  - provider routes and probe rules
  - the remote-MCP trigger list
  - the refusal of `{env:}` across the whole config on withholding triggers
  - non-isolated behaviour
  - headerless remotes and their OAuth

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Automatic brokering refuses an existing isolated config (an `http://` upstream, a query string, references in headers) | Each refusal names its remedy and the release note lists them. Before release, check every owned caller's `opencode-config` for a remote MCP server |
| A future OpenCode pin changes the MCP client | Unit 3's real-binary test runs on every pin bump |
| An upstream echoes its credential | Accepted and documented (R1) |
| An MCP bug breaks provider routes | Separate dispatch, and the provider tests unchanged as a gate |

## Documentation / Operational Notes

- The release note says which configs now fail before launch and how to fix each one.
- After release, run one live check on a caller with a remote MCP server on `workflow_dispatch` under isolation. Confirm the tool works, and scan the run's logs for the canary.

## Sources & References

- Related issue: #2371 (its docs fix shipped in #2380).
- Related code: `packages/runtime/src/agent/key-proxy.ts`, `src/services/setup/mcp-servers-v2.ts`.
- Related past work: `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md`, recorded as current. This plan extends the same child to a second route class.
- External: the MCP Streamable HTTP spec (2025-06-18 and 2026-07-28), and the OpenCode 2.4.2 `packages/core/src/mcp/client.ts`.
