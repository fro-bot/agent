---
title: "fix: Workspace egress topology + configurable OpenCode proxy allowlist"
type: fix
status: active
date: 2026-06-03
---

# fix: Workspace egress topology + configurable OpenCode proxy allowlist

## Overview

The deployed gateway stack (`deploy/compose.yaml`) sandboxes a `workspace` executor container that runs OpenCode and performs `git clone`. All workspace egress is forced through an mitmproxy proxy with a hostname allowlist. On v0.51.0+ the proxy itself has **no route to the internet** — it is attached only to an `internal: true` network — so every workspace outbound request fails with `502 CONNECT tunnel failed`. `/fro-bot add-project` cloning and the `@fro-bot` mention loop are both non-functional on the shipped compose.

This plan fixes two coupled defects in a single PR:
1. **Egress topology** — give mitmproxy an internet-capable upstream leg via a dedicated `egress-net`, while keeping the workspace itself with zero direct egress.
2. **Configurable proxy allowlist** — add a `WORKSPACE_EGRESS_HOSTS` env var so deployments that route OpenCode through a self-hosted proxy (e.g. cliproxyapi at `cliproxy.fro.bot`) can allowlist that host, reusing the exact validation pipeline that `OBJECT_STORE_HOSTS` already uses.

It also closes a regression-coverage gap: `deploy/mitmproxy/test_allowlist.py` and `deploy/validate-stack.sh` exist but neither runs in CI, which is why a compose-wiring break shipped undetected.

## Problem Frame

Source: GitHub issue #741 (source-verified against current `main`).

- `mitmproxy.networks` = `[sandbox-net]` only (`deploy/compose.yaml:283-284`).
- `sandbox-net` is `internal: true` (`deploy/compose.yaml:311-313`) — no host/internet gateway, embedded DNS `127.0.0.11` cannot forward external queries.
- mitmproxy is the **only** egress path for the workspace (`HTTPS_PROXY=http://mitmproxy:8080`, `deploy/compose.yaml:196-197`), so it can neither resolve nor dial `github.com` / `api.anthropic.com` / object storage → `502 CONNECT tunnel failed`.
- The `gateway` service is unaffected because it is dual-homed on `gateway-net` (`internal: false`) and `sandbox-net` (`deploy/compose.yaml:177-179`); its Discord/S3 traffic does not route through mitmproxy. This is why the bug stayed latent until the v0.51.0 workspace began making real outbound requests.

Secondary defect (masked by the first): once egress works, the mention loop routes OpenCode through a proxy host supplied via `WORKSPACE_OPENCODE_CONFIG`. The static allowlist in `deploy/mitmproxy/allowlist.py` covers GitHub/npm/Discord and the three first-party model APIs, but not a self-hosted proxy host, and the only env-extensible hook (`OBJECT_STORE_HOSTS`) is scoped to object storage and rejects non-object-store use by documentation. `deploy/README.md:290` currently documents the workaround as "add your cliproxyapi host there if it is not already permitted" — i.e. there is no first-class mechanism.

## Requirements Trace

- R1. The workspace can reach allowlisted external hosts (clone from GitHub, model round-trips) through mitmproxy on the shipped compose, with no manual override required.
- R2. The containment model is preserved: `sandbox-net` stays `internal: true`; the workspace has zero direct egress; all workspace traffic still flows through mitmproxy's allowlist.
- R3. A deployment can allowlist a self-hosted OpenCode proxy host (e.g. `cliproxy.fro.bot`) via a first-class env var, without repurposing `OBJECT_STORE_HOSTS`.
- R4. The new env var enforces the same security validation as `OBJECT_STORE_HOSTS` (wildcard-reject, private/loopback/link-local/reserved-IP-reject, port-reject, RFC 1123 hostname-validate, lowercase-normalize), via a single shared validation implementation (no duplicated machinery).
- R5. A CI regression guard catches this class of defect: (a) a static compose-topology invariant assertion, and (b) the existing `test_allowlist.py` runs in CI.
- R6. Operator-facing docs (`deploy/README.md`, `deploy/.env.example`, compose comments) document the new env var and the corrected topology.
- R7. Operator-supplied allowlist hosts (`OBJECT_STORE_HOSTS`, `WORKSPACE_EGRESS_HOSTS`) are validated at enforcement time against DNS rebinding: a host that resolves to a private/loopback/link-local/reserved IP is rejected (403), not just literal-IP entries at import time.

## Scope Boundaries

- Not changing the workspace's own network attachment — it stays `sandbox-net`-only.
- Not removing or weakening `OBJECT_STORE_HOSTS` — it keeps its exact current contract and semantics.
- Not adding per-client allowlist policy or separate proxy instances for gateway vs workspace (future hardening, noted below).
- Not changing the static `ALLOWLIST` contents (GitHub/npm/Discord/model APIs stay as-is).

### Deferred to Separate Tasks

- **Per-client / per-instance allowlist** (workspace should not need Discord hosts): the shared static allowlist is broader than the workspace strictly needs; tightening to per-client policy or separate proxy instances is future work.

## Context & Research

### Relevant Code and Patterns

- `deploy/compose.yaml` — service/network topology. Networks declared at the bottom (`gateway-net` external-capable, `sandbox-net` `internal: true`). mitmproxy env interpolation pattern to mirror: `OBJECT_STORE_HOSTS: ${OBJECT_STORE_HOSTS:-}` (`deploy/compose.yaml:278`).
- `deploy/mitmproxy/allowlist.py` — static `ALLOWLIST` + the `OBJECT_STORE_HOSTS` merge pipeline (lines ~135-200): empty-skip → wildcard-reject → `_validate_ip_literal_or_none` (private/loopback/link-local/reserved reject) → port-reject → `_is_valid_hostname` (RFC 1123) → lowercase → append. This is the canonical validation to factor into a shared helper.
- `deploy/mitmproxy/test_allowlist.py` — 22KB pytest suite with a `_load_allowlist(extra_env=...)` re-import harness (mocks mitmproxy, re-imports the module with env overrides). Existing `OBJECT_STORE_HOSTS` cases (e.g. `test_object_store_hosts_included_when_set`) are the exact pattern to mirror for `WORKSPACE_EGRESS_HOSTS`.
- `deploy/validate-stack.sh` — existing compose smoke script (validates `compose config`, service status, gateway exit code). The home for the new topology assertion.
- `deploy/scripts/*.test.mjs` + the `workspace-smoke` CI job (`.github/workflows/ci.yaml:336`) — precedent for running deploy-level tests in CI (`node --test deploy/scripts/*.test.mjs`).
- `deploy/.env.example` (`OBJECT_STORE_HOSTS=` at line 9), `deploy/README.md` Egress Allowlist section (lines ~355-376), `deploy/compose.override.example.yaml` — operator-facing surfaces to update.

### Institutional Learnings

- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — operator-supplied config must overlay without breaking baked security invariants; preserve workspace/sandbox isolation, only the proxy gets upstream access.
- `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md` — treat operator-supplied input as hostile; validate cheapest/most-deterministic constraints first, fail closed. Applies to `WORKSPACE_EGRESS_HOSTS` parsing.
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — image/deploy-only issues slip past local tests; add boot-time/deploy smoke coverage and verify the deployed container graph, not just code paths. Directly motivates R5.

### External References

- Oracle strategy consult (this session): dedicated `egress-net` over dual-homing onto `gateway-net` (cleaner audit boundary, avoids future footgun if `gateway-net` gains stateful services); keep `OBJECT_STORE_HOSTS` + add `WORKSPACE_EGRESS_HOSTS` with one shared validator; static compose-invariant guard + targeted mitmproxy-only live smoke (don't boot the whole stack).

### Egress Dependency Coverage

The fix is complete only if every host the workspace + mention loop actually needs is reachable post-fix. Verified coverage against the static `ALLOWLIST` in `deploy/mitmproxy/allowlist.py`:

| Egress dependency | Host(s) | Covered by |
|---|---|---|
| Git clone (add-project) | `github.com`, `api.github.com`, `*.githubusercontent.com` | static ALLOWLIST |
| OpenCode plugin install (Systematic, runtime npm) | `registry.npmjs.org` | static ALLOWLIST |
| Discord (gateway path; not workspace-required) | `discord.com`, `*.discord.gg` | static ALLOWLIST |
| First-party model APIs | `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com` | static ALLOWLIST |
| Object storage (S3-backed state) | deployment-specific bucket host | `OBJECT_STORE_HOSTS` env |
| Self-hosted OpenCode proxy (e.g. cliproxyapi) | e.g. `cliproxy.fro.bot` | `WORKSPACE_EGRESS_HOSTS` env (this plan) |

Implementer must confirm no additional host is reached at runtime before calling the fix complete; if a deployment uses a model provider not in the static list, it goes in `WORKSPACE_EGRESS_HOSTS`.

## Key Technical Decisions

- **Dedicated `egress-net` (not dual-home onto `gateway-net`):** mitmproxy is the component deliberately exposed to untrusted workspace traffic. Giving it adjacency to the gateway's Discord/S3 control-plane network is avoidable. A dedicated `internal: false` `egress-net` keeps the containment story auditable: `workspace → sandbox-net → mitmproxy → egress-net → internet`. Cost is one network declaration.
- **`WORKSPACE_EGRESS_HOSTS` as a new env var, shared validator:** keep `OBJECT_STORE_HOSTS` (shipped, documented, narrow storage semantics) and add `WORKSPACE_EGRESS_HOSTS` (model/proxy egress semantics) as two semantically-distinct config surfaces backed by **one** validation/parse function. This satisfies "collapse complexity at the right layer" (one implementation) without a breaking rename of `OBJECT_STORE_HOSTS` or a broad `ADDITIONAL_ALLOWLIST_HOSTS` that invites allowlist rot.
- **Regression guard split:** a near-zero-cost static compose-invariant assertion (mandatory) plus wiring the existing `test_allowlist.py` into CI. A full-stack live smoke is heavier; the static invariant catches the exact topology regression class. (A targeted mitmproxy-only live smoke is recorded as an optional enhancement, not required for this fix. Tracked as a follow-up in issue #745.)

## Open Questions

### Resolved During Planning

- Dual-home vs dedicated network → dedicated `egress-net` (decision above).
- New env var vs generalize/rename → new `WORKSPACE_EGRESS_HOSTS` + shared validator (decision above).
- Name → `WORKSPACE_EGRESS_HOSTS` (matches containment framing: additional exact hosts the workspace may reach through mitmproxy; broader than "OpenCode proxy" so a deployment can add any required egress host under the same validation). The variable is documented as an escape hatch for explicitly-justified workspace egress hosts (e.g. a self-hosted model proxy), NOT a general-purpose allowlist — Unit 5 docs must state this to avoid the allowlist-rot the broad-rename alternative was rejected for. Validation (wildcard/private-IP/port reject) provides the technical floor; the doc framing provides the operational discipline.

### Deferred to Implementation

- Exact shared-helper function name and signature in `allowlist.py` (refactor detail, settled when the code is touched).
- Whether the static compose-invariant assertion lives in `deploy/validate-stack.sh` (bash + `docker compose config` + yaml parse) or a small `node --test` alongside `deploy/scripts/` — settled by which is cleaner to wire into the `workspace-smoke` job. Both are acceptable; pick the lower-friction one at implementation.

## Implementation Units

- [ ] **Unit 1: Egress topology — dedicated `egress-net` for mitmproxy's upstream leg**

**Goal:** mitmproxy can resolve and reach the internet while the workspace retains zero direct egress and `sandbox-net` stays `internal: true`.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `deploy/compose.yaml`

**Approach:**
- Declare a new top-level network `egress-net` with `internal: false`.
- Add `egress-net` to the `mitmproxy` service `networks` list (so it becomes `[sandbox-net, egress-net]`).
- Leave `workspace.networks` as `[sandbox-net]` and `gateway.networks` as `[gateway-net, sandbox-net]` unchanged.
- Update the inline network comments to state the containment invariant: workspace has no direct egress; only mitmproxy's upstream leg reaches the internet via `egress-net`; `sandbox-net` remains `internal: true`.
- Routing note: Docker does not assign a default gateway to `internal: true` networks, so once mitmproxy is dual-homed on `sandbox-net` (internal) + `egress-net` (internal:false), the `egress-net` gateway becomes the container's default route for outbound traffic. This is the same pattern the `gateway` service already uses successfully (dual-homed on `gateway-net` external + `sandbox-net` internal, reaching Discord/S3) — see `deploy/compose.yaml:177-179`.

**Patterns to follow:**
- Existing `gateway-net` / `sandbox-net` declarations and the gateway's dual-homing as the structural precedent.
- The `gateway` service's existing dual-homing (external `gateway-net` + internal `sandbox-net`) is the proven precedent that an internal+external dual-homed container routes outbound via the external leg.

**Test scenarios:**
- Integration (covered by Unit 4 static guard): rendered `docker compose config` shows `sandbox-net.internal == true`, `workspace.networks == [sandbox-net]`, `mitmproxy.networks` includes both `sandbox-net` and a network with `internal: false`, and `workspace` is attached to no `internal: false` network.
- Verification (manual / live, not CI): `docker compose up -d`, then inside the mitmproxy container `getent hosts github.com` resolves and `curl -sI https://github.com` returns 200.

**Verification:**
- `docker compose -f deploy/compose.yaml config` is valid and shows the new network on mitmproxy only.
- Containment invariants above hold.

- [ ] **Unit 2: `WORKSPACE_EGRESS_HOSTS` env var + shared validation helper in `allowlist.py`**

**Goal:** A deployment can allowlist additional exact egress hosts (e.g. a self-hosted OpenCode proxy) via `WORKSPACE_EGRESS_HOSTS`, with identical security validation to `OBJECT_STORE_HOSTS`, implemented once.

**Requirements:** R3, R4

**Dependencies:** None (independent of Unit 1; both land in the same PR)

**Files:**
- Modify: `deploy/mitmproxy/allowlist.py`
- Test: `deploy/mitmproxy/test_allowlist.py`

**Approach:**
- Extract the existing `OBJECT_STORE_HOSTS` parse/validate pipeline (empty-skip → wildcard-reject → IP-literal private/loopback/link-local/reserved reject → port-reject → RFC 1123 validate → lowercase) into a single shared helper that takes the env-var name (for error-message context) and its raw value, and returns the validated host list (raising `ValueError` with an env-var-specific message on bad input).
- Route both `OBJECT_STORE_HOSTS` and the new `WORKSPACE_EGRESS_HOSTS` through that helper at module import, appending both results to `ALLOWLIST`.
- Preserve `OBJECT_STORE_HOSTS`'s existing error-message wording/semantics (no behavior change for existing deployments).

**Execution note:** Test-first — add the `WORKSPACE_EGRESS_HOSTS` cases mirroring the existing `OBJECT_STORE_HOSTS` tests, watch them fail, then refactor to the shared helper and confirm both sets stay green.

**Patterns to follow:**
- `OBJECT_STORE_HOSTS` merge block in `allowlist.py` and its tests in `test_allowlist.py` (`_load_allowlist(extra_env=...)` re-import harness; `test_object_store_hosts_included_when_set` and the reject cases).

**Test scenarios:**
- Happy path: `WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot` → `cliproxy.fro.bot` is in `ALLOWLIST` and `_is_allowed("cliproxy.fro.bot")` is True; a comma-separated list adds all entries.
- Happy path: unset/empty `WORKSPACE_EGRESS_HOSTS` → no change to `ALLOWLIST` (no error).
- Edge case: case normalization — `WORKSPACE_EGRESS_HOSTS=CliProxy.FRO.bot` is matched case-insensitively (lowercased on merge).
- Error path: wildcard entry (`*.fro.bot`) → `ValueError` naming `WORKSPACE_EGRESS_HOSTS`.
- Error path: private/loopback/link-local/reserved IP literal (`10.0.0.5`, `127.0.0.1`, `169.254.169.254`) → `ValueError`.
- Error path: host with a port (`cliproxy.fro.bot:443`, bracket IPv6+port) → `ValueError`.
- Error path: invalid hostname (leading/trailing/consecutive dots) → rejected.
- Integration: both `OBJECT_STORE_HOSTS` and `WORKSPACE_EGRESS_HOSTS` set together → both host sets present in `ALLOWLIST`; setting only one does not affect the other.
- Regression: all existing `OBJECT_STORE_HOSTS` tests still pass unchanged after the shared-helper refactor.

**Verification:**
- `pytest deploy/mitmproxy/test_allowlist.py` (or `python3 deploy/mitmproxy/test_allowlist.py`) is green, including the new and existing cases.

- [ ] **Unit 3: DNS-rebinding defense — resolved-IP validation at enforcement time**

**Goal:** An operator-supplied allowlist host that resolves to a private/loopback/link-local/reserved IP is rejected at connect time, closing the DNS-rebinding gap for `OBJECT_STORE_HOSTS` and `WORKSPACE_EGRESS_HOSTS`.

**Requirements:** R7

**Dependencies:** Unit 2 (the env-var-supplied host set + the shared validation helper)

**Files:**
- Modify: `deploy/mitmproxy/allowlist.py`
- Test: `deploy/mitmproxy/test_allowlist.py`

**Approach:**
- Extract the range-checking core of `_validate_ip_literal_or_none` into a shared `_ip_is_disallowed(ip_str) -> bool` helper so literal-IP import validation and resolved-IP enforcement share one range definition.
- Track the set of operator-supplied hosts (from `OBJECT_STORE_HOSTS` + `WORKSPACE_EGRESS_HOSTS`) at module import.
- In `AllowlistAddon._enforce` (or a helper it calls), after a host passes `_is_allowed`, if the host is in the operator-supplied set, resolve it via `socket.getaddrinfo` and return 403 if ANY resolved address is disallowed. Vendor static-ALLOWLIST hosts (github/npm/discord/model-APIs) are not resolved-checked.
- Fail closed on resolution: if resolution fails for an operator-supplied host, block (the addon already short-circuits via `flow.response`).

**Execution note:** Test-first — add resolved-IP rejection cases (mock `socket.getaddrinfo`) before the enforcement code.

**Patterns to follow:**
- `_validate_ip_literal_or_none` range logic in `allowlist.py` (reuse via the extracted helper); `AllowlistAddon._enforce` / `http_connect` / `request` hooks; the `_load_allowlist(extra_env=...)` test harness.

**Test scenarios:**
- Happy path: an operator-supplied host resolving to a public IP is allowed through.
- Error path: an operator-supplied host (in `WORKSPACE_EGRESS_HOSTS`) resolving to 127.0.0.1 / 10.0.0.5 / 169.254.169.254 / ::1 is rejected with 403 (mock `getaddrinfo`).
- Error path: an operator-supplied host with MULTIPLE A-records where ANY is private → rejected.
- Edge case: a vendor static-ALLOWLIST host (e.g. github.com) is NOT resolved-checked (no getaddrinfo gate) — only operator-supplied hosts are.
- Error path: resolution failure for an operator-supplied host → fail closed (403/block).
- Regression: existing literal-IP import-time rejection tests still pass after the `_ip_is_disallowed` extraction.

**Verification:**
- `python3 deploy/mitmproxy/test_allowlist.py` green including the new resolved-IP cases; the shared range helper backs both literal and resolved checks.

- [ ] **Unit 4: CI regression guard — compose-topology invariant + run allowlist tests**

**Goal:** This defect class fails CI: a static assertion on the compose network topology, and the existing `test_allowlist.py` runs on deploy-touching changes.

**Requirements:** R5

**Dependencies:** Unit 1 (asserts the corrected topology), Unit 2 + Unit 3 (the allowlist tests to run, including the DNS-rebinding cases)

**Files:**
- Modify: `deploy/validate-stack.sh` (add a static topology-invariant assertion using `docker compose config` output) — or add a small `node --test` / shell check; settle at implementation.
- Modify: `.github/workflows/ci.yaml` (run the allowlist pytest and the static topology assertion in the `workspace-smoke` job, which already does `node --test deploy/scripts/*.test.mjs`)

**Approach:**
- Add a static assertion (no running containers needed) that parses `docker compose -f deploy/compose.yaml config` and verifies: `sandbox-net.internal == true`; `workspace` attaches only to `sandbox-net`; `mitmproxy` attaches to `sandbox-net` plus at least one `internal: false` network; `workspace` is on no `internal: false` network; `egress-net` has exactly one attached service (`mitmproxy`) — no other service may join the internet-capable network.
- Wire the allowlist tests into the `workspace-smoke` job using the no-dependency runner: `python3 deploy/mitmproxy/test_allowlist.py` (the test file mocks the `mitmproxy` package via `sys.modules` injection and runs on any standard Python 3.11+, which ubuntu-latest provides — no pytest install needed). Use this exact command rather than `pytest` to avoid a dependency-install step.
- Keep the guard cheap: no full `docker compose up` of the stack.

**Execution note:** Verify the new CI steps would have failed against the pre-fix topology (sanity-check the assertion catches the original bug).

**Patterns to follow:**
- The `workspace-smoke` job's existing `node --test deploy/scripts/*.test.mjs` step and the paths-filter gating for deploy changes.

**Test scenarios:**
- Integration: the static assertion passes on the corrected `deploy/compose.yaml` (post-Unit-1) and would fail on the pre-fix topology (mitmproxy on `sandbox-net` only). Prove both directions.
- Integration: `test_allowlist.py` runs and passes in the `workspace-smoke` job.
- Integration: the static assertion fails if any service other than `mitmproxy` is attached to `egress-net` (proves the single-member containment invariant).
- Test expectation: the workflow-yaml and script wiring itself is validated by the job running green in CI on the PR.

**Verification:**
- The `workspace-smoke` (or appropriate deploy) CI job runs the allowlist tests and the topology assertion and is green on the PR; both gates are present in `.github/workflows/ci.yaml`.

- [ ] **Unit 5: Operator-facing docs — env var, topology, provider-proxy example**

**Goal:** Deployers can discover and correctly use `WORKSPACE_EGRESS_HOSTS`, and the corrected egress topology is reflected in docs.

**Requirements:** R6

**Dependencies:** Units 1-3 (documents their behavior)

**Files:**
- Modify: `deploy/.env.example` (add `WORKSPACE_EGRESS_HOSTS=` with a short comment)
- Modify: `deploy/README.md` (Egress Allowlist section: document `WORKSPACE_EGRESS_HOSTS` alongside `OBJECT_STORE_HOSTS` with the same validation rules; update the cliproxyapi provider-config note at ~line 290 to point at `WORKSPACE_EGRESS_HOSTS` instead of "add your cliproxyapi host to the static allowlist"; note the corrected topology if operator-visible)
- Modify: `deploy/compose.yaml` (env interpolation entry `WORKSPACE_EGRESS_HOSTS: ${WORKSPACE_EGRESS_HOSTS:-}` on the mitmproxy service, mirroring `OBJECT_STORE_HOSTS`) — and `deploy/compose.override.example.yaml` comment if it documents allowlist envs
- Optionally Modify: `docs/solutions/` is **not** updated here (compounding is a separate post-merge step)

**Approach:**
- Mirror the existing `OBJECT_STORE_HOSTS` documentation structure exactly: purpose, format (comma-separated exact hostnames), validation/rejection rules, fail-closed-when-unset behavior.
- Make the cliproxyapi example concrete: `WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot`.
- The `WORKSPACE_EGRESS_HOSTS: ${WORKSPACE_EGRESS_HOSTS:-}` compose entry is the runtime wiring that makes the env var reach the mitmproxy addon — without it, Unit 2's code never sees the value. (This is functional, not just docs — but it's a one-line mirror of the `OBJECT_STORE_HOSTS` interpolation, grouped here with the operator-facing surface.)
- Frame `WORKSPACE_EGRESS_HOSTS` in docs as an escape hatch for explicitly-justified egress hosts only (not a general allowlist), so operators don't accumulate unrelated hosts over time.

**Patterns to follow:**
- `deploy/README.md` Egress Allowlist section (lines ~355-376), `deploy/.env.example:9`, and the `OBJECT_STORE_HOSTS: ${OBJECT_STORE_HOSTS:-}` compose interpolation (`deploy/compose.yaml:278`).

**Test scenarios:**
- Test expectation: none — documentation and a compose env-interpolation passthrough. The passthrough is exercised end-to-end by Unit 2's tests (the var must be present for the addon to read it) and by the live verification in Unit 1.

**Verification:**
- `docker compose -f deploy/compose.yaml config` still valid with the new interpolation entry.
- README and `.env.example` describe `WORKSPACE_EGRESS_HOSTS` with the same rigor as `OBJECT_STORE_HOSTS`; the cliproxyapi note points at the new var.

## System-Wide Impact

- **Interaction graph:** Network change affects only mitmproxy's reachability; no application-code paths change. The allowlist change affects the mitmproxy addon's import-time `ALLOWLIST` construction.
- **Error propagation:** Bad `WORKSPACE_EGRESS_HOSTS` input fails closed at mitmproxy import (raises `ValueError`, addon fails to load) — same fail-closed posture as `OBJECT_STORE_HOSTS`. Document that a malformed value prevents proxy startup (intentional).
- **State lifecycle risks:** None — no persistent state touched.
- **API surface parity:** `OBJECT_STORE_HOSTS` and `WORKSPACE_EGRESS_HOSTS` now share one validator; any future change to validation rules must apply to both via the shared helper.
- **Integration coverage:** The compose-topology invariant (Unit 4) is the cross-cutting guard that unit tests alone cannot prove.
- **Resolution-time cost:** operator-supplied allowlist hosts incur a `socket.getaddrinfo` lookup at enforcement; vendor static-ALLOWLIST hosts are unaffected (not resolved-checked).
- **Unchanged invariants:** `sandbox-net` stays `internal: true`; `workspace` stays `sandbox-net`-only with zero direct egress; the static `ALLOWLIST` contents are unchanged; `OBJECT_STORE_HOSTS` contract and error messages are unchanged. The new work only adds an upstream leg to mitmproxy and a second validated env-var source. mitmproxy remains a regular-mode CONNECT proxy enforcing the hostname allowlist (it does not act as a general forward/transparent router); dual-homing it onto `egress-net` only gives its allowlisted upstream dials a route, it does not turn it into a bridge between sandbox-net and egress-net.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `egress-net` inadvertently lets the workspace reach the internet directly | Workspace stays `sandbox-net`-only; only mitmproxy joins `egress-net`. Unit 4 static guard asserts the workspace is on no `internal: false` network. |
| Shared-helper refactor breaks existing `OBJECT_STORE_HOSTS` behavior | Test-first: keep all existing `OBJECT_STORE_HOSTS` tests; they must stay green unchanged (Unit 2 regression scenario). |
| Allowlisted hostname resolves to a private IP (DNS rebinding) | Addressed in Unit 3: resolved-IP validation rejects operator-supplied hosts resolving to private/loopback/link-local/reserved IPs. Residual TOCTOU (mitmproxy re-resolves for the actual dial) documented as accepted — addon-layer pinning is not available; this is defense-in-depth, not hermetic. |
| Shared allowlist is broader than the workspace needs (e.g. Discord hosts) | Noted as deferred future hardening (per-client policy / separate proxy instances); not a regression introduced here. |
| CI lacks Python/pytest in the smoke job | Use the test file's no-dependency `__main__` runner (`python3 deploy/mitmproxy/test_allowlist.py`) or add a minimal pytest install; ubuntu-latest ships Python. |

## Documentation / Operational Notes

- After merge, this is a strong candidate for a `ce:compound` best-practices entry (egress topology + dual-network proxy containment + shared validated allowlist env vars), since `learnings-researcher` found no existing doc covering mitmproxy allowlisting or the `internal:true`/`internal:false` proxy topology.
- Operators on v0.51.0/v0.52.0 must redeploy with the new compose to get egress working; the `WORKSPACE_EGRESS_HOSTS` var is required only for deployments using a self-hosted OpenCode proxy.
- DNS-rebinding defense (Unit 3) validates resolved IPs at the addon hook, but mitmproxy performs its own resolution for the upstream dial (TOCTOU). This raises the bar against operator-misconfiguration and naive rebinding but is not a hermetic guarantee; full IP-pinning would require deeper mitmproxy integration (future hardening).

## Sources & References

- **Origin:** GitHub issue #741 + Fro Bot triage comment + Oracle strategy consult (this session)
- Related code: `deploy/compose.yaml`, `deploy/mitmproxy/allowlist.py`, `deploy/mitmproxy/test_allowlist.py`, `deploy/validate-stack.sh`, `.github/workflows/ci.yaml` (`workspace-smoke` job)
- Related learnings: `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md`, `docs/solutions/best-practices/signed-webhook-ingress-hardening-2026-05-29.md`, `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md`
