---
title: "fix: Reject egress-weakening compose keys in the topology guard (#899)"
type: fix
status: active
date: 2026-06-14
---

# Reject egress-weakening compose keys in the topology guard (#899)

## Overview

The compose topology guard (`deploy/validate-stack.sh`, `check_compose_topology`) enforces that workspace egress flows through mitmproxy by policing network attachments (only allowlisted `(service, network)` pairs on non-internal networks, plus a blanket `network_mode` ban). But it does not inspect other compose keys that can grant a sandbox-net-reachable container an egress path around mitmproxy. This plan adds defense-in-depth rejections for three such keys — `extra_hosts` using `host-gateway`, `cap_add` of `NET_ADMIN`/`NET_RAW`, and `/dev/net/tun` device mappings — on all services, mirroring the existing blanket `network_mode` rejection (Invariant 1b). Closes #899.

## Problem Frame

`network_mode` is already blanket-rejected (Invariant 1b, `deploy/validate-stack.sh`), but adjacent egress-weakening keys are blind spots. A compose override that passes the current guard can still:
- **`extra_hosts: ["proxy.local:host-gateway"]`** — give the workspace the Docker host's bridge IP; if the host runs any forward proxy/SOCKS/tunnel bound to `0.0.0.0`, the workspace relays egress around mitmproxy (cleartext HTTP; HTTPS fails CA validation).
- **`cap_add: [NET_ADMIN]` (or `NET_RAW`) + `devices: ["/dev/net/tun:/dev/net/tun"]`** — with a custom image carrying a VPN client, build a tunnel that bypasses mitmproxy.

The inconsistency (the most obvious bypass banned, adjacent ones open) is the gap #899 tracks. Surfaced by the ce:review adversarial pass on the #814/#745 fix and intentionally deferred from that PR to keep it scoped to the network-attachment class.

## Requirements Trace

- R1. The guard fails any service declaring an `extra_hosts` entry that maps to `host-gateway`.
- R2. The guard fails any service whose `cap_add` includes `NET_ADMIN` or `NET_RAW`.
- R3. The guard fails any service declaring a device mapping for `/dev/net/tun`.
- R4. Enforcement is blanket (all services), mirroring the `network_mode` ban — these keys have no legitimate use in this stack.
- R5. The real shipped `deploy/compose.yaml` still passes (no current service uses these keys).
- R6. Failure messages are actionable (name the service + the offending key/value) and fail closed, consistent with the existing invariants.

## Scope Boundaries

- Not changing the existing network-attachment / `network_mode` invariants (already shipped via #814).
- Not adding proxy-agent config or touching mitmproxy/allowlist behavior.
- Blanket all-services enforcement (not scoped to sandbox-net-reachable only) — confirmed scope decision.

### Deferred to Separate Tasks

- IPv6 egress-path check (issue #899 mentioned it): separate concern about mitmproxy's IPv4 listener scope / allowlist coverage, not a compose-key check. Out of scope here; track separately if IPv6 egress becomes a real path.

## Context & Research

### Relevant Code and Patterns

- `deploy/validate-stack.sh` — `check_compose_topology` embeds Python in a bash heredoc. Invariant 1b (`network_mode_services` loop) is the exact template: iterate `sorted(services.keys())`, read a key via `svc_cfg.get(...)`, `failures.append(...)` with a clear message. The new checks slot in as sibling invariants.
- `service_networks(svc)`, `non_internal_nets`, `network_mode_services`, `services`, `networks`, `failures` — existing locals available to reuse.
- Compose key shapes (under `docker compose config` normalization — verify exact normalized forms during implementation):
  - `extra_hosts`: normalized to a list of `"host:ip"` strings (or possibly a map) — check for a value of `host-gateway`.
  - `cap_add`: list of capability strings.
  - `devices`: list of `"host:container[:perms]"` strings (or normalized dicts) — check for `/dev/net/tun`.
  Account for the raw-YAML fallback path too (when docker compose config is unavailable), as the existing invariants do.
- `deploy/validate-stack.test.sh` — existing shell test harness; the #814 tests (TEST 20-26) are the style template (single-file fixtures docker-free via `--topology-only`; docker-gated / PyYAML-skip pattern where needed). Continue numbering from the current highest TEST.
- `deploy/README.md` / `deploy/compose.yaml` comments — egress/topology section to note the additional rejected keys.

### Institutional Learnings

- The #814 fix family (network-attachment global invariant + drift check) and its ce:review established the blanket-ban-with-actionable-message pattern and the docker-gated-vs-raw-YAML test discipline.

### External References

- Issue #899 (the three egress-weakening keys + the `network_mode`-consistency argument).

## Key Technical Decisions

- **Blanket all-services enforcement**, mirroring Invariant 1b — simplest, fail-closed, and these keys have no legit use in this stack (workspace is sandbox-net-only; no service needs host-gateway/NET_ADMIN/tun).
- **Include `NET_RAW` alongside `NET_ADMIN`** — both enable raw-socket/routing manipulation relevant to tunneling; cheap to cover both.
- **Reuse the existing invariant structure** (Python-in-heredoc, `failures.append`, sorted-services loop) rather than a new mechanism.
- **Defer IPv6** — distinct from compose-key inspection; would pull in mitmproxy listener/allowlist scope.

## Open Questions

### Resolved During Planning

- All-services vs sandbox-net-reachable enforcement: resolved to blanket all-services (KTD).
- IPv6: deferred (Scope Boundaries).

### Deferred to Implementation

- Exact normalized shapes of `extra_hosts` / `cap_add` / `devices` under `docker compose config` vs the raw-YAML fallback — verify both paths during implementation and handle each (the existing invariants already branch on the fallback). Determine whether `extra_hosts` normalizes to list-of-strings or a map in this compose/docker version.

## Implementation Units

- [ ] **Unit 1: Add egress-weakening compose-key rejections to the guard**

**Goal:** The guard fails closed on `extra_hosts` host-gateway, `cap_add` NET_ADMIN/NET_RAW, and `/dev/net/tun` device mappings, on any service.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (add sibling invariants after the `network_mode` block / alongside the existing checks)

**Approach:**
- Add a loop over `sorted(services.keys())` (or fold into the existing service iteration) that, per service config, checks:
  - `extra_hosts`: handle both list-of-`"name:value"` and map forms; fail if any entry's value is `host-gateway`.
  - `cap_add`: fail if it contains `NET_ADMIN` or `NET_RAW`.
  - `devices`: handle list-of-strings (`"/dev/net/tun:..."`) and normalized-dict forms; fail if any maps `/dev/net/tun`.
- Each failure: `failures.append(f"FAIL: service '{svc}' ...")` naming the key + offending value, mirroring Invariant 1b's wording.
- Ensure the raw-YAML fallback path (no docker compose config) also sees these keys, consistent with existing invariants.

**Patterns to follow:** the `network_mode_services` block in `deploy/validate-stack.sh` (sorted iteration, `svc_cfg.get`, actionable failure message).

**Test scenarios:** (covered by Unit 2)

**Verification:** running the guard against current `deploy/compose.yaml` exits 0; against each malicious fixture exits non-zero naming the service + key.

- [ ] **Unit 2: Guard tests for the new rejections**

**Goal:** Lock the three rejections + the real-stack-passes behavior with regression tests.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `deploy/validate-stack.test.sh` (continue TEST numbering from the current highest)

**Approach:** Single-file fixtures, docker-free via `--topology-only`/raw-YAML where possible (follow the existing skip-with-notice pattern if PyYAML/docker is needed). One fixture per key plus a passing case.

**Execution note:** Write the failing fixtures first (they encode #899), confirm they fail with the fix and would pass (guard exit 0) without it — i.e., the test actually guards the new behavior.

**Test scenarios:**
- Edge: service with `extra_hosts: ["proxy.local:host-gateway"]` → fails, message names the service + `host-gateway`.
- Edge: service with `cap_add: [NET_ADMIN]` → fails, names the service + `NET_ADMIN`.
- Edge: service with `cap_add: [NET_RAW]` → fails (covers the second capability).
- Edge: service with `devices: ["/dev/net/tun:/dev/net/tun"]` → fails, names the service + `/dev/net/tun`.
- Happy path: an `extra_hosts` entry that is NOT host-gateway (e.g. `"db:10.0.0.5"`) → passes (don't over-reject benign extra_hosts).
- Happy path: the real `deploy/compose.yaml` passes (if not already covered by the existing real-compose test, add it; otherwise note the dup).

**Verification:** the suite passes; removing the Unit 1 checks makes the malicious fixtures pass (proving the tests guard the bug); benign `extra_hosts` is not falsely rejected.

- [ ] **Unit 3: Document the additional rejected keys**

**Goal:** Operators understand which compose keys the guard forbids and why.

**Requirements:** R6

**Dependencies:** Unit 1

**Files:**
- Modify: `deploy/README.md` (egress/topology section), `deploy/validate-stack.sh` header comment if it enumerates invariants

**Approach:** Add a brief line to the egress containment docs: the guard rejects `network_mode`, plus `extra_hosts: host-gateway`, `cap_add: NET_ADMIN/NET_RAW`, and `/dev/net/tun` device mappings, because each can relay or tunnel workspace egress around mitmproxy.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** the docs list the newly rejected keys alongside `network_mode`.

## System-Wide Impact

- **Interaction graph:** guard runs in the `workspace-smoke` CI job (`bash deploy/validate-stack.sh --topology-only` + `bash deploy/validate-stack.test.sh`). Additive checks only.
- **Error propagation:** fail-closed (any offending key → non-zero exit + named failure).
- **API surface parity:** none — internal deploy tooling.
- **Unchanged invariants:** the network-attachment allowlist, drift check, `network_mode` ban, and workspace/mitmproxy/volume invariants are untouched; the real compose stack continues to pass.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Over-rejecting benign `extra_hosts` (non-host-gateway) | Unit 2 includes a benign-extra_hosts passing test; only `host-gateway` value triggers failure |
| Normalized key shape differs (docker compose config vs raw YAML) | Unit 1 handles both forms; deferred-to-implementation note flags verifying exact shapes |
| New check accidentally fails the real stack | Unit 2 asserts real `deploy/compose.yaml` passes; run guard against it |

## Documentation / Operational Notes

- `deploy/README.md` egress section updated for the additional rejected keys. Closes #899.

## Sources & References

- Issue #899 (egress-weakening compose keys).
- Code: `deploy/validate-stack.sh` (Invariant 1b `network_mode` block as template), `deploy/validate-stack.test.sh` (TEST 20-26 style), `deploy/compose.yaml`, `deploy/README.md`.
- Related: #814/#745 (the network-attachment fix this extends), PR #901.
