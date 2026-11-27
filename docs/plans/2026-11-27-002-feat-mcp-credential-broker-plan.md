---
title: "feat: Broker remote MCP header credentials under isolate-agent"
type: feat
status: active
date: 2026-11-27
---

# feat: Broker remote MCP header credentials under isolate-agent

## Overview

Under `isolate-agent`, each remote MCP server that has `headers` is reached through the runner-side key-proxy child. The server config the agent can read points that server at a loopback route and carries no header values. The child holds the values and adds them to each request it forwards to the server's fixed HTTPS upstream. Provider keys already work this way. The same child now serves MCP routes too.

## Problem Frame

Every value in `opencode-config` is readable by the agent in every mode (#2371). The Action passes the merged config to the server as `OPENCODE_CONFIG_CONTENT`. The server's tools inherit it, and under isolation the server and its tools run as the same sandbox user. On `schedule` and `workflow_dispatch` runs, remote MCP servers survive filtering with their `headers` as written, so a bearer token for an MCP server is handed to the model. The docs already say so (#2380). This plan removes the exposure for isolated runs.

Hiding the credential does not limit what it can do. The agent's shell can call any tool through the loopback route, so the operator's control over authority is a scoped upstream token. Non-isolated runs are unchanged. There, the agent runs as the runner user and can read the Action's own `INPUT_OPENCODE-CONFIG`.

## Requirements Trace

- R1. Under `isolate-agent` on a provisioning trigger, no remote MCP header value reaches anything the sandbox can read. That covers the server config (traced and untraced), the environment, argv, files, logs and traces.
- R2. Each brokered server still works. OpenCode 2.4.2 can initialize, list tools, call tools and close a session through the broker, with the upstream receiving the configured headers.
- R3. A broker that can't start, or that dies mid-run, fails the run. No run falls back to a direct connection.
- R4. Configurations the broker can't protect are refused before the sandbox starts. That covers references in brokered entries, OAuth objects, non-HTTPS upstreams and reserved header names.
- R5. Provider routes, the key-proxy probe, per-trigger MCP filtering and non-isolated behaviour stay as they are.
- R6. The docs state what is protected, what is not, and why.

## Scope Boundaries

- No tool-level or method-level policy. The broker relays bytes, and a scoped upstream token is the control.
- No OAuth. A brokered server with an `oauth` object is refused. OpenCode's own OAuth login is unchanged for servers without `headers`.
- Local-server `environment` values stay agent-readable, as documented.
- No change to which triggers keep remote MCP servers (`schedule`, `workflow_dispatch`).
- No legacy two-endpoint HTTP+SSE transport. OpenCode 2.4.2 doesn't use it.
- No containment of a credential that an upstream echoes back in a successful response. The upstream is trusted with its credential, as with the key proxy.

### Deferred to Separate Tasks

- Brokering secrets in local MCP servers' `environment` (it needs a stdio bridge): a separate issue if wanted.
- A shared supervisor for the key proxy and the trace relay: a refactor, separate PR.

## Context & Research

Research reports (local, untracked): `/tmp/mcp-broker/{repo,external,past,flow}.md`.

### Relevant Code and Patterns

- `src/services/setup/mcp-servers-v2.ts`: parsing (`parseServer`, both `mcp.<name>` and `mcp.servers.<name>` layouts), reference detection (`isReference`) and per-trigger filtering (`applyOperatorMcpV2`). Remote servers survive only on `provision`, with `headers` passed through as written.
- `src/services/setup/ci-config-v2.ts` (`buildCIConfigV2`): providers get a proxy rewrite, and `mcp` has none. It's called twice in `src/harness/phases/v2-server.ts` (`prepareRun`), once for the traced config and once for the untraced one.
- `src/services/setup/key-proxy-providers.ts`: `resolveKeyProxyProviders` (refuses any bypass) and `checkConfigForKeys` (scans the serialized config by value).
- `packages/runtime/src/agent/key-proxy.ts`, `key-proxy-routes.ts`, `key-proxy-wire.ts`, `key-proxy-child.ts`, `forwardable-target.ts`: the child, its exact route table, header allowlist, redirect/101 refusal and error-body redaction.
- `src/harness/phases/key-proxy-process.ts` and `startProxyUnderLifecycle` in `v2-server.ts`: the supervisor and the one proxy slot in `src/harness/phases/sandbox-lifecycle.ts`, covering `died`, take-back and the crash latch.
- `src/harness/phases/v2-server.sandbox.integration.test.ts`: the real-runner canary rows and the key-proxy block, which are the patterns to extend.

### Institutional Learnings

- `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md`: the pattern, its dead ends (field-name denylist, placeholder check, failing on 403) and the rule that every `opencode-config` value is agent-readable.
- `docs/solutions/best-practices/separate-uid-is-not-a-boundary-on-hosted-runners-2026-11-17.md`: what isolation does and doesn't separate.
- `docs/solutions/workflow-issues/run-tracing-live-check-2026-11-23.md`: canary checks against the published Action.

### External References

- MCP Streamable HTTP, 2025-06-18 and 2026-07-28 revisions: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http and the 2026-07-28 changelog. The 2026 revision drops sessions, GET/DELETE and `Last-Event-ID` resume.
- MCP security best practices (token passthrough, SSRF): https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices
- OpenCode 2.4.2 remote client, which uses Streamable HTTP only with no legacy SSE fallback: `packages/core/src/mcp/client.ts` at tag `v2.4.2`, and anomalyco/opencode#61867.

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

- **Extend the key-proxy child; don't add a third child.** The lifecycle has one proxy slot, and its `died`, take-back and crash-latch handling already cover the run's integrity. A third child would need either an N-ary slot or the weaker `registerSignalStop`. MCP routes get their own dispatch and state inside the child, kept apart from the provider routes.
- **Brokering is automatic, keyed on the presence of `headers`.** On an isolated provisioning run, every active remote entry that has a `headers` key is brokered, including `headers: {}`. Header names aren't used to guess which one is a credential.
- **Upstreams are trusted with their credential.** As with the key proxy, a 2xx response passes through uninspected, and error bodies are replaced. The promise is that the credential isn't in the agent's config or environment, not that an upstream can never echo it.
- **Refuse what can't be protected.** In a brokered entry the following are refused before handoff:
  - `{env:}`/`{file:}` anywhere in the entry
  - an `oauth` object (`false` is accepted, and is set when absent)
  - a non-HTTPS URL, userinfo or a fragment
  - a query string in the configured URL
  - header names that are hop-by-hop, framing, `Host` or reserved MCP protocol fields, or that collide case-insensitively

  Failing closed is the same rule `resolveKeyProxyProviders` follows.
- **Routes come from Unit 1's capture.** The allowed methods, request headers and query forms are what the pinned 2.4.2 binary was observed to send against 2025 and 2026 fakes. They don't come from the spec alone. The key proxy's provider routes were fixed the same way, against stock 2.2.7.
- **Per-server failures stay per-server.** Invalid config, or a broker that won't start, fails the run. An upstream 401, 403, 5xx or timeout leaves only that server unavailable to OpenCode. There's no MCP start-up probe, so remote servers keep connecting in the background as they do today.
- **Header values are masked on the trusted side.** They're registered with `core.setSecret` and the trace registry as soon as they're classified, and they join the `checkConfigForKeys` value scan over both final configs.

## Open Questions

### Resolved During Planning

- **Which child serves MCP?** The key-proxy child (see Key Technical Decisions).
- **What about non-isolated runs?** No broker. Behaviour is unchanged, and the docs already warn.
- **Echo containment?** Not attempted. The upstream is trusted, following the key proxy's precedent.
- **An MCP-only run with no provider keys?** The child starts when either route set is non-empty, and skips the provider probe when no provider is proxied.

### Deferred to Implementation

- **The exact route table:** methods, the `?codemode=false` variants, the protocol headers (`Mcp-Session-Id`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Last-Event-ID`) and whether OpenCode sends GET or DELETE. Unit 1 decides these.
- **The OpenCode 2.4.2 default protocol mode** (the source says `auto` and the docs say `legacy`). Unit 1 observes it.
- **Stream deadlines and caps:** idle bounds, plus per-route and aggregate stream limits that leave headroom for provider and DELETE traffic. These are set from Unit 1's fixture timings.
- **Effective disabled-state normalization** (`enabled: false` versus native `disabled: true`) on 2.4.2. Unit 1 confirms it, and a definitively disabled entry gets no route.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
  participant A as Action (runner)
  participant P as Credential proxy child (runner)
  participant S as OpenCode server (sandbox user)
  participant U as MCP upstream (HTTPS)
  A->>A: parse opencode-config, filter by trigger
  A->>A: classify remotes with headers, validate, register values as secrets
  A->>P: spawn, one stdin frame {providers, mcp routes + headers}
  P-->>A: ready (loopback port)
  A->>A: rewrite mcp urls to 127.0.0.1:port/mcp/<id>, drop headers, scan both configs by value
  A->>S: launch (config has no header values)
  S->>P: POST /mcp/<id>?codemode=false (no credential)
  P->>U: same request, fixed origin+path, configured headers set last
  U-->>P: JSON or SSE
  P-->>S: streamed through; 3xx/101 -> 502; error bodies replaced
```

## Implementation Units

- [ ] **Unit 1: Capture what OpenCode 2.4.2 sends to a remote MCP server**

**Goal:** Record the real wire contract before freezing routes. That means the methods, the raw request targets, the protocol headers, the ordering across connect, `tools/list`, `tools/call`, SSE responses, session expiry and close, and how the client reacts to a redirect, a 401 with `WWW-Authenticate`, or a 404 or 405 on GET or DELETE.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Create: `packages/runtime/src/agent/mcp-wire.fixtures.ts`, holding the recorded exchanges as test fixtures.
- Create: `src/harness/phases/mcp-broker.probe.integration.test.ts`, a real-binary capture that is skipped without a binary.

**Approach:**
- Run the digest-pinned 2.4.2 binary against two controlled fake servers: a 2025 stateful one (sessions, GET stream, DELETE) and a 2026 stateless one. Config is Action-shaped and covers both layouts, `oauth` omitted and `false`, and `codemode` omitted, true and false. Include a headerless control.
- Use synthetic header values only. Mark explicitly which features the client never exercised.
- Re-pin `.slim/clonedeps` to 2.4.2 first, so the source read matches the binary.

**Test scenarios:**
- Integration: a 2025 fake sees `initialize`, then `notifications/initialized`, then `tools/list`, then `tools/call`. The recorded method, target and protocol headers of each are asserted.
- Integration: the 2026 fake sees the stateless form, and the presence or absence of `Mcp-Session-Id` is recorded.
- Edge case: a 3xx from the fake. Record whether the client follows it, sending a second request and to where.
- Edge case: a 401 with `WWW-Authenticate`. Record whether the client starts OAuth when `oauth: false` is set.
- Edge case: a 404 or 405 on GET and DELETE. Record whether the client reinitializes or retries.

**Verification:**
- The fixtures file names every method, header and query form the client sent. The test fails if a rerun on the pinned binary records anything outside it.

- [ ] **Unit 2: Classify, validate and rewrite brokered MCP servers**

**Goal:** On an isolated provisioning run, turn every active remote entry with `headers` into a broker route plus a rewritten entry that has a loopback URL, no headers and `oauth: false`. Refuse entries the broker can't protect.

**Requirements:** R1, R4, R5

**Dependencies:** Unit 1, for the reserved-header list and the allowed query forms.

**Files:**
- Modify: `src/services/setup/mcp-servers-v2.ts` (classification and validation, both layouts).
- Modify: `src/services/setup/ci-config-v2.ts` (rewrite step beside the provider rewrite, so both the traced and untraced configs get it).
- Modify: `src/services/setup/key-proxy-providers.ts` (`checkConfigForKeys` also takes the brokered header values).
- Modify: `src/harness/phases/v2-server.ts` (plan routes before the proxy starts, mask values, scan both configs).
- Test: `src/services/setup/mcp-servers-v2.test.ts`, `src/services/setup/ci-config-v2.test.ts`, `src/services/setup/key-proxy-providers.test.ts`.

**Approach:**
- Classify after per-trigger filtering, so a server dropped on a withholding trigger gets no route and no error.
- Give each brokered entry an opaque route id that doesn't collide with provider ids. Classify by the entry's original identity and presence, not by the parsed `headers ?? {}`.
- Header values are registered as secrets as soon as they're classified.

**Execution note:** Test-first. Write the refusal and rewrite cases before the code.

**Patterns to follow:** `resolveKeyProxyProviders` and `findProviderBypass` (refuse bypasses structurally), and the provider rewrite in `buildCIConfigV2`.

**Test scenarios:**
- Happy path: an isolated `workflow_dispatch` run with one remote server and an `Authorization` header produces a rewritten URL `http://127.0.0.1:<port>/mcp/<id>`, no `headers` key, `oauth: false`, and one route carrying the header.
- Happy path: the native `mcp.servers.<name>` layout gets the same rewrite.
- Edge case: a remote with no `headers` key stays direct and unchanged. A remote with `headers: {}` is brokered with zero headers.
- Edge case: two remotes with the same origin and different paths get two distinct routes, each with its own fixed path.
- Edge case: a definitively disabled entry has its headers stripped and gets no route.
- Error path: any of the following fails before handoff with a named, value-free reason:
  - `Bearer {env:TOKEN}` in a header
  - `{file:}` anywhere in the entry
  - `oauth: {}`
  - an `http://` URL
  - userinfo in the URL
  - a URL with a query string
  - a `Host` or `Mcp-Session-Id` header
  - two headers that differ only in case
- Error path: a header value copied elsewhere in the config (another entry, or a local `environment`) fails `checkConfigForKeys`, for both the traced and untraced configs.
- Integration: a withheld trigger (`issue_comment`) with a credentialed remote still drops it, raises no broker error, and starts no route.
- Integration: a non-isolated run keeps the remote entry as written (unchanged behaviour).

**Verification:**
- No serialized final config contains any configured header value.
- Every refusal reason appears in a test, and no log line contains a value.

- [ ] **Unit 3: Serve MCP routes in the credential proxy child**

**Goal:** The child relays each brokered route to its fixed upstream, using exactly the request forms Unit 1 recorded. It sets the configured headers last, refuses redirects and upgrades, and bounds its streams.

**Requirements:** R2, R5

**Dependencies:** Unit 1, Unit 2 (route shape)

**Files:**
- Modify: `packages/runtime/src/agent/key-proxy-wire.ts` (bump the version and add bounded `mcp` routes).
- Create: `packages/runtime/src/agent/mcp-routes.ts` (exact matching and the per-route request and response header rules).
- Modify: `packages/runtime/src/agent/key-proxy.ts` (dispatch MCP routes separately from provider routes, plus per-route stream limits and idle deadlines).
- Modify: `packages/runtime/src/agent/key-proxy-child.ts`.
- Test: `packages/runtime/src/agent/key-proxy.test.ts`, `packages/runtime/src/agent/mcp-routes.test.ts`.

**Approach:**
- Match on exact local path, method and admitted query. The upstream origin, path and headers are fixed per route.
- Strip client credentials, cookies and forwarding metadata. Build the host and framing. Set configured headers last.
- An upstream 3xx or 101 becomes a local 502 with no `Location` and no second request.
- An error body is replaced with a fixed body. The status is kept, plus a sanitized `Retry-After`. `WWW-Authenticate` is dropped.
- 2xx JSON and SSE stream through with backpressure. There's no total byte cap on a stream. Per-event and header limits apply.
- Separate connect, first-byte and stream-idle deadlines. MCP stream caps leave headroom for provider and DELETE requests.

**Patterns to follow:** `key-proxy-routes.ts` (exact table), the `upgrade`, `connect` and socket error handling in `key-proxy.ts`, and the use of `https.request` instead of `fetch`.

**Test scenarios:**
- Happy path: each fixture exchange from Unit 1 replays through the child to a fake upstream. The upstream receives the configured headers and none of the client's credentials. The client gets the upstream's status, body and `Mcp-Session-Id`.
- Happy path: an SSE response streams event by event without buffering, and a quiet stream within the idle bound stays open.
- Edge case: an unknown method, an unadmitted query parameter, a duplicate query key or an absolute-form target is refused locally with no upstream contact.
- Edge case: a client-sent `Authorization` is never forwarded, and the configured value wins.
- Error path: an upstream 302 or 307 to the same origin becomes a 502 with no `Location`, and the fake sees exactly one request.
- Error path: an upstream 101 becomes a 502.
- Error path: an upstream 401 with `WWW-Authenticate` and a body containing the credential reaches the client with its status kept and no challenge, and the body is replaced.
- Error path: a stream that is silent past the idle bound is closed on both sides.
- Error path: when MCP streams hit their cap, a provider request still succeeds, and the next MCP request gets a bounded 503.
- Integration: a provider route and an MCP route in one child don't share state, and the provider tests pass unchanged.

**Verification:**
- The existing provider route tests pass unchanged, and each new refusal has a test.

- [ ] **Unit 4: Start the child for MCP-only runs and keep it fail-closed**

**Goal:** The child starts when either route set is non-empty, and the run fails closed in every state of the child's life.

**Requirements:** R3, R5

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `src/harness/phases/v2-server.ts` (start condition, both config variants, provider probe only when a provider is proxied).
- Modify: `src/harness/phases/key-proxy-process.ts` (wire config, log summary with counts only).
- Modify: `src/harness/phases/sandbox-lifecycle.ts` only if the slot's naming or teardown needs it.
- Test: `src/harness/phases/v2-server.test.ts`, `src/harness/phases/key-proxy-process.test.ts`.

**Approach:**
- Plan the routes once, then start the child, then rewrite, then scan. A scan failure after the child is ready stops it before returning.
- Crash handling reuses the existing `died` latch, the take-back veto and cache-save refusal.

**Test scenarios:**
- Happy path: an MCP-only run (no `auth-json` provider) starts the child, skips the provider probe and launches.
- Happy path: a mixed run (provider plus MCP) uses one child and runs the provider probe as today.
- Edge case: a run with no routes starts no child.
- Error path: if the child never becomes ready, or exits before ready, the run fails with a value-free reason and the server never launches.
- Error path: if the child dies mid-run, the run ends unsafe and the session cache isn't saved.
- Error path: if the scan fails after ready, the child is stopped and the run fails.
- Integration: a signal during handoff, or after launch, stops the child through the existing teardown, and the port is closed.

**Verification:**
- The start/gate/release/finally paths each have a test with an MCP-only child.

- [ ] **Unit 5: Prove it on a real runner and a real binary**

**Goal:** End-to-end evidence that R1 and R2 hold.

**Requirements:** R1, R2, R3

**Dependencies:** Units 2–4

**Files:**
- Modify: `src/harness/phases/v2-server.sandbox.integration.test.ts` (add MCP canary rows next to the key-proxy block).
- Modify: `src/harness/phases/execute-v2.integration.test.ts` (a real-binary tool call through the broker).

**Approach:**
- Use a unique canary header value. The scanner looks for it as the sandbox user across final configs, the environment, argv, `/proc`, writable files, logs and the trace sink. Include a non-isolated control row that does find it.
- In the real-binary test, a scripted model calls an MCP tool on a fake upstream that asserts the header. A second call from the agent's shell to the loopback route also succeeds (accepted authority), which shows the route works without the credential being visible.

**Test scenarios:**
- Integration: isolated with brokered MCP, the canary is `BLOCKED` for the agent user everywhere scanned, and the fake upstream saw it on every request.
- Integration: the non-isolated control row reports the canary `OPEN` in the config environment.
- Integration: OpenCode lists and calls a tool through the broker, and the tool result reaches the transcript.
- Integration: the upstream returns a 302, and the run's tool call fails with no second upstream request.

**Verification:**
- Both sandbox images pass the new rows in CI. The real-binary test passes on the pinned version.

- [ ] **Unit 6: Docs**

**Goal:** State the new boundary precisely.

**Requirements:** R6

**Dependencies:** Units 2–5

**Files:**
- Modify: `README.md`, `action.yaml` (`opencode-config` and `isolate-agent` help), `docs/wiki/Setup and Configuration.md` (MCP, isolation and tracing sections), `ARCHITECTURE.md` (key-proxy entry).
- Modify: `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md` (item 9: remote MCP headers are brokered under isolation).

**Approach:** Say what's protected (remote MCP header values under isolation on provisioning triggers) and what isn't. Not protected:
- non-isolated runs
- local `environment` values
- secrets in a URL
- what the token can do through the loopback route
- an upstream echoing its own credential

List each refusal with its remedy, without suggesting turning off isolation as the fix.

**Test expectation:** none (docs only). Run the link check and `action-trace-input-docs.test.ts` if `action.yaml` text is pinned.

**Verification:**
- Every refusal reason from Unit 2 has a documented remedy.

## System-Wide Impact

- **Interaction graph:** Config build (both trace variants), proxy start, the value scan, sandbox handoff, the server's MCP client, the existing provider probe and teardown.
- **Error propagation:** A refusal or broker start failure fails the run before launch. A broker death mid-run marks the run unsafe through the existing latch. An upstream error shows up as that server being unavailable inside OpenCode.
- **State lifecycle risks:** A tool call that is in flight when the broker dies may already have run upstream. Nothing replays it.
- **API surface parity:** The gateway and the workspace agent don't read `mcp`, so there's nothing to change there.
- **Unchanged invariants:**
  - provider routes and the key-proxy probe rules
  - remote MCP surviving only on `schedule` and `workflow_dispatch`
  - whole-config `{env:}` refusal on withholding triggers
  - non-isolated behaviour
  - headerless remotes and their OAuth

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| OpenCode sends a request form Unit 1 didn't see, which strands sessions | The fixture test fails on a pin bump when the client's traffic changes, and a refused request names the method and target shape |
| A future OpenCode pin changes MCP transport | The same fixture test, plus the real-binary test in Unit 5 |
| A long silent MCP stream starves provider traffic | Per-route caps with provider headroom (Unit 3) |
| An upstream echoes the credential in a 2xx | Accepted and documented: the upstream is trusted with its own credential |
| A broker bug breaks provider routes | Separate dispatch and state, with the provider tests unchanged as a gate |

## Documentation / Operational Notes

- The release note should say which configs now fail closed (refusals) and how to fix each one.
- After release, run a live check on one owned caller with a remote MCP server on `workflow_dispatch` under isolation. Confirm the tool works, and scan the run's logs for the canary.

## Sources & References

- Related issue: #2371. Its docs fix shipped in #2380.
- Related code: `packages/runtime/src/agent/key-proxy.ts`, `src/services/setup/mcp-servers-v2.ts`.
- Related past work: `docs/solutions/best-practices/key-proxy-keeps-provider-keys-out-of-the-agent-sandbox-2026-11-17.md`, recorded as current. This plan extends the same child to a second route class.
- External: the MCP Streamable HTTP spec (2025-06-18 and 2026-07-28), and the OpenCode 2.4.2 `packages/core/src/mcp/client.ts`.
