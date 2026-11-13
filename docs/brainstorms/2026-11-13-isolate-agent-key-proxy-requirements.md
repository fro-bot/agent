---
date: 2026-11-13
topic: isolate-agent-key-proxy
---

# isolate-agent: keep the provider key out of the sandbox

## Summary

When `isolate-agent` is on, the Action holds provider keys in a loopback proxy process that runs as the runner user. The proxy adds the real credential only to the model routes it allows. The sandboxed OpenCode server and its tools see only a per-run placeholder, so a model can no longer read a provider key or carry it off. Preflight refusals also name their fix.

---

## Problem Frame

`isolate-agent` (#2135, shipped in v0.140.x) runs the OpenCode V2 server, and every tool it starts, as a throwaway local user. That closes the `/proc/<pid>/environ` token leak, the workflow command files and the runner's private directories. The provider key stays exposed. The server has to read each `auth-json` API key, so the key is written to a `0600` file owned by the sandbox user and referenced from the server config. The model's tools run as that same user, so any shell, or OpenCode's in-process `read` tool, can read the key.

The key is a cliproxy key. One key authenticates every cliproxy route, with no per-key scoping. A key carried off in a run's output, a commit or a network call can be spent anywhere until someone notices and rotates it. Prompt injection through issue, PR and comment text is the realistic way to steer a model into doing that.

---

## Requirements

**What the sandbox can reach**
- R1. With `isolate-agent` on, no provider secret from `auth-json` is readable by the sandbox user. That covers files, environment, argv, the server's config and any server API. The sandbox user has no grant on the real key at all.
- R2. With `isolate-agent` off, credential handling is unchanged.

**Proxy behavior**
- R3. Model requests reach the real provider with the real credential attached outside the sandbox. Streaming, long responses and provider errors behave as they do on a non-isolated run.
- R4. The proxy works for every provider the Action provisions from `auth-json` today. Those are API-type entries such as `anthropic` and `openai`, including one whose base URL comes from the caller's `opencode-config` (for example cliproxy).
- R5. For each provisioned provider, the proxy forwards only an allowlist of method-and-path routes (inference and model listing) to that provider's fixed upstream. It answers anything else locally and never attaches the key to it.
- R6. The proxy discards every client-supplied credential header and hop-by-hop header, then sets its own credential. It accepts origin-form requests only, never follows a redirect, and never logs request or response headers.
- R7. The proxy refuses to start unless every upstream is HTTPS. The upstream map is fixed at start and nothing a request carries can change it.
- R8. The proxy runs as its own process holding only the keys and the upstream map, not the Action's environment. It receives the keys over a channel the sandbox user cannot read, and never through argv.
- R9. The proxy binds an ephemeral loopback port, serves only requests that carry the run's placeholder, lives for the run only, and stops before session state is saved.
- R10. A malformed or oversized request gets an error, and the proxy keeps serving. If the proxy cannot start or stops serving, the run fails closed and never falls back to handing the sandbox the real key.

**Start-up check**
- R11. At start, a bounded auth probe through the proxy proves each required provider accepts its credential, using that provider's model-list route. On a 401 or 403, or no answer within the bound, the run fails before the model starts.

**Errors and docs**
- R12. Every isolation preflight refusal names its fix in the error, for example `persist-credentials: false`, a published `fro-bot/agent@<ref>`, a GitHub-hosted Linux runner, or `isolate-agent: false`.
- R13. The `isolate-agent` docs say what isolation now hides (provider keys) and what stays reachable: the server password, model spend through the proxy during the run, and credentials a trigger provisions on purpose (the `gh` config in provision mode). The docs live in one canonical section that the README links to.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** In an isolated run, a prompt-injected model runs `cat` on every file it can reach, reads `/proc/*/environ`, queries the server's config and provider routes, and uses the `read` tool on the credential paths. None of that output contains the provider key, and the model's normal requests still get streamed answers.
- AE2. **Covers R5.** In an isolated run, the model sends the proxy a request with the placeholder, the correct provider host and a path outside the allowlist (a cliproxy management route, say). The proxy answers locally, and no request carrying the key goes upstream.
- AE3. **Covers R6.** In an isolated run, the model sends a request through the proxy with its own `x-api-key` or `Authorization` header, or an upstream answers with a 3xx. The proxy forwards only its own credential and does not follow the redirect.
- AE4. **Covers R10.** In an isolated run, the model sends the proxy a malformed or oversized request. It gets an error, and later model requests still work. If the proxy process dies, the next model request fails and the run fails.
- AE5. **Covers R11.** In an isolated run whose provider key upstream rejects the key, the run fails at start with a credential error before the model runs.
- AE6. **Covers R2.** In a run with `isolate-agent` off, credential files and config are the same as before this change.

---

## Success Criteria

- A provider key cannot be recovered from inside an isolated run. The real-runner sandbox suite proves this with a positive control (the runner can read the key) and negative controls: the sandbox cannot read it, a non-allowlisted route is refused, and a client-supplied credential header is dropped.
- An isolated run's answers, streaming and failure reporting look the same as a non-isolated run's.
- `ce:plan` can design the proxy without inventing what must be hidden, what may stay visible, or which routes are allowed.

---

## Scope Boundaries

- Making `isolate-agent` the default. That gets a follow-up decision once the proxy ships, weighing a default flip against turning the input on explicitly in every compatible owned caller.
- Per-run revocable provider keys from the broker. This is later defence in depth and needs infra and cliproxy changes.
- A second tool uid, and hiding `OPENCODE_PASSWORD` from tools. The password stays a documented residual.
- Limiting model spend during a run. The proxy prevents exfiltration, not usage.
- Hiding credentials a trigger provisions on purpose, such as the provision-mode `gh` config.

---

## Key Decisions

- **A key-injecting proxy instead of a second tool uid.** Under a second uid, OpenCode's in-process tools (`read`, `edit`, `grep`) would still run as the server uid. They could reach a key file the server can read, and only the `external_directory` permission rule would stop them. The #1970 probes showed that rule is a guardrail for a cooperating model, not a boundary. Keeping the key out of the sandbox closes every path at once.
- **The provider key matters more than the server password.** The key is spendable anywhere once it leaks. The password only lets the model drive its own server, which the permission model already treats as a guardrail.
- **The proxy runs only under isolation.** Without isolation the model runs as the runner user and could read the proxy's process environment, so the proxy would add complexity and protect nothing.
- **Allowlisted routes, not just a pinned host.** The cliproxy key opens every cliproxy route, so a host pin alone would still let an injected model reach management routes with the real key.
- **The flip is a separate decision.** The proxy needs nothing from it. A single operator can get the same coverage by turning the input on in each compatible caller, so whether the flip is worth a breaking release is decided after the proxy ships.
- The isolate-agent plan is recorded as completed in `docs/plans/2026-11-10-001-feat-isolate-agent-uid-plan.md`. It lists a second tool uid as deferred future work; this doc replaces that with the proxy.

---

## Dependencies / Assumptions

- The OpenCode V2 server accepts a per-provider base URL and a placeholder key for each API-type provider the Action provisions. The repo's V2 fixtures already configure `options.baseURL` with a placeholder key. That every provisioned provider honors this is unverified.
- The sandbox user can reach a port the runner user binds on loopback. The sandbox launch drops user and group but creates no network namespace. This is unverified on a real runner, so the sandbox suite should check it.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4, R5][Needs research] Which methods and paths each provider's SDK uses, so the allowlist covers inference and model listing and nothing more. Whether any provider signs requests in a way a header rewrite would break.
- [Affects R5, R9][Technical] Whether the proxy routes by path prefix or uses one port per provider.
- [Affects R11][Needs research] Each provider's model-list route as an auth probe: whether it costs anything and what rate limits apply.
- [Affects R3][Technical] Whether any upstream echoes the credential in an error body or header, and whether the proxy should redact the key from responses.

---

## Sources / Research

- Issue #2135 and the earlier isolate-agent results. The isolate-agent section of `docs/wiki/Setup and Configuration.md`.
- The published-install live check on v0.140.2: fro-bot/.github run 43331564031.
- `src/services/setup/credential-files-v2.ts` writes provider keys today. `packages/runtime/src/agent/credential-gate-v2.ts` (around lines 63-69) is the presence-only credential gate that R11 replaces for isolated runs.
- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md`: a `0600` key file does not protect against code running as its owner.
- `docs/solutions/logic-errors/injected-deny-blocks-own-delivery-path-2026-07-13.md`: a security control can block the Action's own delivery path, so test the proxy against response delivery too.
