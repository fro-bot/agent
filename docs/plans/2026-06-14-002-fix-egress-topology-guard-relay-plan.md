---
title: "fix: Close egress-relay bypass in the compose topology guard (#814) + live egress smoke (#745)"
type: fix
status: done
date: 2026-06-14
deepened: 2026-06-14
---

> **Status: done.** All 4 units shipped: the global non-internal-attachment allowlist + drift check replacing Invariant 5, guard tests, the gateway TCB-exception docs + ingress pinning test, and the live workspace egress smoke — verified on `main` (`deploy/validate-stack.sh`, `deploy/egress-smoke.sh`, PR #901).

# Close the egress-relay bypass in the topology guard (#814) + live egress smoke (#745)

## Overview

The compose topology guard (`deploy/validate-stack.sh`, `check_compose_topology`) is supposed to enforce that all workspace egress flows through mitmproxy. Its Invariant 5 only inspects the non-internal networks **mitmproxy itself** is attached to, so a service bridging `sandbox-net` to a *different* non-internal network (one mitmproxy is not on) is never inspected — an unguarded egress relay reachable from the workspace. This plan replaces Invariant 5 with a global invariant: no service may attach to any non-internal network except an explicit allowlist of trusted `(service, network)` pairs — `{mitmproxy→egress-net, gateway→gateway-net}`. It documents the gateway as a deliberate trusted-TCB exception, corrects the now-inaccurate topology comments, and adds a runtime egress smoke (#745) that proves the workspace's only internet path is mitmproxy.

Decision basis: Option B from issue #814, chosen after threat-model analysis confirmed the untrusted workspace cannot induce the trusted first-party gateway to make caller-directed outbound requests (gateway↔sandbox-net traffic is gateway-initiated, plus one HMAC/replay-gated announce endpoint that posts a fixed embed). Option A (route all gateway egress through mitmproxy, enforce "only mitmproxy on any non-internal net") was rejected as over-engineering with real outage risk — the Discord/Octokit/S3 clients configure no proxy agent today, and persistent Discord WSS through a CONNECT proxy is unverified.

## Problem Frame

`deploy/validate-stack.sh:228-239` (Invariant 5) iterates only `mitmproxy_egress_nets` (the non-internal networks mitmproxy uses). A compose override adding `leakproxy: {networks: [sandbox-net, shadow-egress]}` where mitmproxy is not on `shadow-egress` passes the guard (exits 0): the workspace stays sandbox-net-only, mitmproxy keeps its egress leg, and the new non-internal network is never inspected. The workspace can reach `leakproxy` over `sandbox-net`, and `leakproxy` has direct internet egress — defeating the containment model. The current guard also lacks any runtime proof that egress containment actually holds; `workspace-smoke` runs only static allowlist unit tests (`deploy/mitmproxy/test_allowlist.py`).

## Requirements Trace

- R1. The topology guard fails any service (other than the allowlisted pairs) attached to any non-internal network — including a non-internal network mitmproxy is not on. (#814)
- R2. The allowlist is explicit and minimal: `{mitmproxy→egress-net, gateway→gateway-net}`. Any other `(service, non-internal-net)` attachment fails closed.
- R3. The guard also fails declaration of an unknown non-internal network (not in `{egress-net, gateway-net}`), so a `shadow-egress` network can't be introduced even before a service joins it (drift check).
- R4. The shipped production stack (gateway on gateway-net + sandbox-net, mitmproxy on sandbox-net + egress-net, workspace sandbox-net-only) still passes.
- R5. The gateway's non-internal attachment is documented as a deliberate trusted-TCB exception, with the constraint that the workspace must never be given a gateway endpoint that performs caller-directed outbound requests. Inaccurate "only mitmproxy touches the internet" comments are corrected. The constraint is backed by a pinning test (see R7), not prose alone.
- R7. A regression/pinning test asserts the gateway's only sandbox-net-reachable HTTP ingress is the HMAC/replay-gated announce endpoint (gateway↔workspace is otherwise gateway-initiated), so a future workspace-reachable gateway endpoint that performs caller-directed outbound fails CI rather than silently reopening the trust boundary. (security-lens + adversarial finding)
- R6. A live egress smoke (#745) proves, from the workspace's vantage, that direct internet egress fails, a blocked host through mitmproxy returns 403, and an allowlisted host through mitmproxy succeeds.

## Scope Boundaries

- Not removing the gateway from `gateway-net` (that is Option A; explicitly rejected for #814).
- Not adding proxy-agent configuration to the Discord/Octokit/S3 clients (Option A plumbing).
- The live egress smoke proves the **workspace** containment model only; it does not assert gateway traffic routes through mitmproxy (the gateway is an explicit exception).

### Deferred to Separate Tasks

- Revisiting strict single-chokepoint topology (Option A) only if a future gateway endpoint accepts workspace-directed outbound — tracked as the documented constraint, not active work.

## Context & Research

### Relevant Code and Patterns

- `deploy/validate-stack.sh:228-239` — Invariant 5 (the flawed per-mitmproxy-net check) to replace; surrounding invariants 1/3/4 at lines ~190-220 show the established `failures.append(...)` pattern, `service_networks(svc)`, `non_internal_nets`, and `network_mode_services` helpers to reuse.
- `deploy/compose.yaml` — topology: `workspace` networks `[sandbox-net]` (internal), `mitmproxy` `[sandbox-net, egress-net]`, `gateway` `[gateway-net, sandbox-net]`; `sandbox-net: {internal: true}`, `egress-net`/`gateway-net` non-internal. Topology comments (~lines 339-351) that say only mitmproxy is internet-capable need correction.
- `deploy/mitmproxy/allowlist.py` — CONNECT + plain-HTTP allowlist enforcement; existing allowed hosts (Discord/GitHub/LLM) — the smoke's allowed/blocked host choices should align with this.
- `deploy/mitmproxy/test_allowlist.py` — existing static allowlist unit tests run by `workspace-smoke`.
- `.github/workflows/ci.yaml:341-360` — `workspace-smoke` job (runs allowlist tests + builds workspace image); `.github/workflows/ci.yaml:241+` — `gateway-smoke`. The live egress smoke is a new step/job here.
- Guard test pattern: check how `deploy/validate-stack.sh` is currently tested (look for `deploy/scripts/*.test.mjs` or a validate-stack test harness) and follow it; `deploy/scripts/` uses Node's built-in `node --test` runner per AGENTS.md, not Vitest.

### Institutional Learnings

- `docs/solutions/best-practices/cross-libc-build-and-release-safety-2026-06-14.md` and the egress-hardening history (#741/#746/#815) — prior topology-guard work; fail-closed multi-file validation and `network_mode` rejection already shipped.

### External References

- Issue #814 (the bypass + A/B decision), issue #745 (live egress smoke).

## Key Technical Decisions

- **Option B (allowlist exception), not A (strict chokepoint).** Threat-model-justified: workspace cannot use the gateway as a relay; A risks outages with no proxy-agent config present.
- **Global invariant with an explicit `(service, network)` allowlist set.** Replaces the per-mitmproxy-net loop; closes the shadow-egress class entirely.
- **Drift check on network declarations.** Fail any declared non-internal network not in `{egress-net, gateway-net}`, so the hole can't be reintroduced by declaration.
- **Gateway documented as trusted TCB exception** with the explicit forward constraint (no workspace-directed-outbound gateway endpoint), so the weaker-than-strict posture is deliberate and auditable.
- **Live smoke proves the workspace model only.** Gateway egress is an explicit exception, so the smoke does not assert proxy-only routing for gateway traffic.

## Open Questions

### Resolved During Planning

- Strict vs allowlist posture (#814 A/B): resolved to B (see KTD).
- Does the workspace have a relay path via the gateway? No — verified gateway ingress from sandbox-net is gateway-initiated + HMAC-gated announce only.

### Deferred to Implementation

- Exact allowed/blocked host choices for the live smoke: pick from `deploy/mitmproxy/allowlist.py` at implementation (e.g., an allowlisted LLM/GitHub host for the 200 case, an arbitrary non-allowlisted host for the 403 case).
- Whether the live smoke runs as a new step inside `workspace-smoke` or a dedicated job: decide when wiring, based on what infra the smoke needs (it must `docker compose up` the stack).

## Implementation Units

- [x] **Unit 1: Replace Invariant 5 with a global non-internal-attachment allowlist + drift check**

**Goal:** The guard fails any non-allowlisted service on any non-internal network, and any unknown non-internal network declaration.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (replace Invariant 5 block ~228-239; add the drift check)

**Approach:**
- Define `allowed_non_internal_attachments = {("mitmproxy","egress-net"), ("gateway","gateway-net")}` and `allowed_non_internal_nets = {"egress-net","gateway-net"}`.
- Global loop over all services (skipping `network_mode_services`): for each non-internal network the service is attached to, fail if the `(svc, net)` pair is not in the allowlist — naming the offending pair and the allowed set.
- Drift check: fail any declared network in `non_internal_nets` not in `allowed_non_internal_nets`.
- Remove the old per-`mitmproxy_egress_nets` loop. Keep invariants 1/3/4 intact.

**Technical design:** *(directional, not implementation spec)*
```python
allowed_non_internal_attachments = {("mitmproxy", "egress-net"), ("gateway", "gateway-net")}
for svc in sorted(services):
    if svc in network_mode_services: continue
    for net in sorted(service_networks(svc) & non_internal_nets):
        if (svc, net) not in allowed_non_internal_attachments:
            failures.append(f"FAIL: service '{svc}' attached to non-internal network '{net}'; allowed: {sorted(allowed_non_internal_attachments)!r}")
# drift check
for net in sorted(non_internal_nets - {"egress-net", "gateway-net"}):
    failures.append(f"FAIL: unknown non-internal network '{net}' declared; only egress-net/gateway-net are permitted")
```

**Patterns to follow:** existing `failures.append(...)` / `service_networks` / `non_internal_nets` usage in the same file.

**Test scenarios:**
- Happy path: real shipped topology (workspace sandbox-net; mitmproxy sandbox+egress; gateway gateway+sandbox) → passes.
- Edge: `sidecar: [sandbox-net, shadow-egress]` (mitmproxy not on shadow-egress) → fails with the sidecar/shadow-egress pair named.
- Edge: `sidecar: [sandbox-net, gateway-net]` (joining the gateway's allowed net) → fails (only gateway may join gateway-net).
- Edge: declaring `shadow-egress` with no service attached → fails (drift check).
- Edge: mitmproxy on egress-net + gateway on gateway-net → both pass (allowlisted pairs).
- Error path: workspace on a non-internal net → still fails (invariant 4 unaffected).

**Verification:** running the guard against current `deploy/compose.yaml` exits 0; against each malicious fixture exits non-zero with the precise failing pair/network.

- [x] **Unit 2: Guard tests for the global invariant**

**Goal:** Lock the new invariant + drift check behavior with regression tests.

**Requirements:** R1, R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `deploy/validate-stack.test.sh` (the EXISTING shell test harness — not `deploy/scripts/*.test.mjs`, which was a misstatement; add fixture cases here)

**Approach:** Drive the guard with minimal compose fixtures for each scenario in Unit 1's test list; assert exit code + the specific failure message substring. The guard supports `--topology-only` with a raw-YAML fallback, so **single-file** fixtures run docker-free. CAVEAT (feasibility/adversarial): the no-docker raw-YAML path fail-closes on **multi-file** input, and #814's bypass class depends on `docker compose config` **merge** semantics — so the override-merge regression (base compose + a malicious override file) MUST run through real `docker compose config`. If compose is unavailable in the harness environment, that specific case must **hard-skip with a visible notice or fail**, never silently downgrade to the raw-YAML path (which would give false confidence). Single-file fixtures (shadow-egress declared inline, gateway-net sidecar inline, drift) cover the rest docker-free.

**Execution note:** Write the shadow-egress and gateway-net-sidecar failing fixtures first (they encode the #814 bug), then confirm they fail before/after to prove the fix.

**Test scenarios:** mirror Unit 1's six scenarios as discrete test cases with exit-code + message assertions; include at least one **multi-file override** case (docker-gated) since that is the literal #814 reproduction.

**Verification:** the test suite passes; removing the Unit 1 fix makes the shadow-egress test fail (the test actually guards the bug); the multi-file override case runs through `docker compose config` (or is explicitly skipped, not silently raw-YAML'd).

- [x] **Unit 3: Document the gateway TCB exception + correct topology comments + pin the gateway ingress surface**

**Goal:** Make the deliberate weaker-than-strict posture explicit and auditable; remove false "only mitmproxy reaches the internet" statements; back the TCB assumption with a pinning test so it can't silently erode.

**Requirements:** R5, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `deploy/compose.yaml` (topology comments ~339-351), `deploy/validate-stack.sh` (header comment ~33-34), `deploy/README.md` (egress/topology section)
- Create/Modify: a gateway-ingress pinning test in `packages/gateway/` (follow existing gateway test conventions) asserting the sandbox-net-reachable HTTP ingress surface is exactly the HMAC/replay-gated announce endpoint

**Approach:**
- Docs: state that the gateway attaches to gateway-net as a trusted first-party TCB because it must reach Discord/GitHub/object storage; the containment guarantee is "the **workspace** reaches the internet only via mitmproxy." Add the forward constraint: never give the workspace a gateway endpoint that performs caller-directed outbound requests; if that changes, revisit strict topology (Option A). Correct any comment asserting only mitmproxy is internet-capable.
- Pinning test (R7): assert the gateway's HTTP server (the `src/http/` ingress, currently only `POST /v1/announce`, HMAC/timestamp/replay/schema-gated, posting a fixed embed) is its only inbound HTTP surface reachable from sandbox-net, and that the gateway→workspace direction (clone/readyz/opencode-proxy) is gateway-initiated. The test should fail if a new route is added to the gateway HTTP ingress without updating the pin — forcing a deliberate security review of any new workspace-reachable endpoint. Right-size it: a route-inventory assertion against the registered HTTP handlers, not a heuristic "detects arbitrary-URL" analyzer.

**Test scenarios:**
- Happy path: the gateway HTTP ingress route inventory equals {announce} → pin passes.
- Edge/guard: adding a hypothetical second ingress route → pin fails (forces review). (Express this as the assertion that locks the current route set.)

**Verification:** no remaining comment claims "only mitmproxy" reaches the internet; the gateway exception + constraint is stated in compose, guard header, and README; the gateway ingress pin passes for the current surface and would fail on an unreviewed new route.

- [x] **Unit 4: Live workspace egress smoke (#745)**

**Goal:** Prove at runtime that the workspace's only internet path is mitmproxy.

**Requirements:** R6

**Dependencies:** Unit 1 (topology must be guard-valid first)

**Files:**
- Modify: `.github/workflows/ci.yaml` (`workspace-smoke` job, or a new dedicated egress-smoke job) — bring the stack up and run the probes
- Create (if a script is cleaner than inline): `deploy/egress-smoke.sh` (workspace-vantage probes)

**Approach:** Bring up the relevant compose services (sandbox-net + mitmproxy + egress-net). Run probes from the **actual workspace container** (it carries the mitmproxy CA trust + proxy env via its entrypoint; an arbitrary throwaway container would not, and would make the HTTPS 200 case fail for the wrong reason). The smoke must **prove routing, not just absence of direct egress** — because `sandbox-net` is `internal: true`, a "direct request fails" check can pass trivially (no route at all) even if proxying is broken (security/adversarial finding). So assert: (a) direct internet request with proxy env unset → fails/refused (containment baseline); (b) request to a non-allowlisted host **through mitmproxy** → 403; (c) request to an allowlisted host **through mitmproxy** → 200 AND mitmproxy logged the allowed flow; (d) the 200 case proves mitmproxy is the path (it succeeds only via the proxy). Sequence the smoke AFTER mitmproxy is healthy and its CA is generated/installed (the 200 HTTPS case depends on the workspace trusting the mitmproxy CA). Keep it hermetic and bounded (timeouts). Do not require gateway traffic to route through mitmproxy.

**Execution note:** This is integration/runtime — it must actually `docker compose up`; verify it fails if mitmproxy is removed or the allowlist is set to allow-all (the negative control must have teeth: an allow-all allowlist makes case (b) return non-403 and the smoke fails).

**Test scenarios:**
- Integration: workspace direct egress (no proxy) → connection fails (baseline, not the routing proof).
- Integration: workspace → blocked host via mitmproxy → 403.
- Integration: workspace → allowlisted host via mitmproxy → 200, succeeds only through the proxy, and mitmproxy logs the allowed flow (this is the routing proof).
- Integration (negative control, teeth): allow-all allowlist → blocked-host case returns non-403 → smoke fails. mitmproxy removed → allowlisted-host 200 case fails (no path).

**Verification:** the CI job passes on the real stack; allow-all allowlist OR removing mitmproxy makes it fail; the 200 case is observable in mitmproxy logs (proves routing, not just isolation).

## System-Wide Impact

- **Interaction graph:** guard runs in `workspace-smoke`/validate-stack CI path; the live smoke adds a `docker compose up` runtime surface in CI.
- **Error propagation:** guard remains fail-closed (any violation → non-zero exit + named failure).
- **API surface parity:** none — internal deploy tooling only.
- **Integration coverage:** Unit 4 provides the runtime proof unit tests can't (the static guard checks declarations; the smoke checks actual packet flow).
- **Unchanged invariants:** invariants 1 (workspace sandbox-only), 3 (mitmproxy upstream leg), 4 (workspace no direct egress), 6 (workspace-repos volume) are untouched; the gateway's existing gateway-net membership is preserved (now explicitly allowlisted).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Global invariant too strict → fails the real stack | Unit 1 test + run guard against current compose.yaml; allowlist includes the two real pairs |
| Live smoke flaky in CI (network/timeouts) | Bounded timeouts, hermetic stack, allow retry on transport flake; assert on mitmproxy decision logs not just status |
| Gateway TCB exception misread as "secure as strict" | Unit 3 documents the residual risk + forward constraint explicitly |
| Future gateway endpoint enables workspace-directed outbound | Documented constraint; revisit Option A if it changes |

## Documentation / Operational Notes

- `deploy/README.md` egress section updated for the gateway exception + the workspace-only containment guarantee.
- Closes #814 and #745.

## Sources & References

- Issue #814 (egress-relay bypass + A/B decision), Issue #745 (live egress smoke).
- Oracle analysis (2026-06-14): Option B recommendation, gateway-ingress threat-model verification, exact guard rewrite.
- Code: `deploy/validate-stack.sh:228-239`, `deploy/compose.yaml`, `deploy/mitmproxy/allowlist.py`, `.github/workflows/ci.yaml:341-360`.
