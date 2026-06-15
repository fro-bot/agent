---
title: "fix: Reject remaining egress-escalation compose keys in the topology guard (#908)"
type: fix
status: active
date: 2026-06-14
---

# Reject remaining egress-escalation compose keys in the topology guard (#908)

## Overview

#899 added topology-guard rejections for the primary egress-weakening compose keys (`extra_hosts: host-gateway`, `cap_add: NET_ADMIN/NET_RAW`, `/dev/net/tun` devices, `privileged: true` — Invariants 1c-1f). Review of that work surfaced five further escalation vectors that bypass or amplify those controls. This plan closes the class: reject `cap_add: ALL`, `device_cgroup_rules` granting any device, `pid_mode: host`, the IP-forwarding `sysctls` family, and confinement-disabling `security_opt`, all blanket all-services, mirroring the established invariant pattern. Closes #908.

## Problem Frame

Each remaining vector lets a sandbox-net container relay or tunnel egress around mitmproxy, or amplifies the already-blocked keys:
- **`cap_add: ALL` / `CAP_ALL`** — grants every capability including the banned `NET_ADMIN`/`NET_RAW`; same supersetting threat as `privileged: true`, but `_BANNED_CAPS = {"NET_ADMIN","NET_RAW"}` does not include `ALL`.
- **`device_cgroup_rules`** — a cgroup device-allow rule (e.g. `c 10:200 rwm`) grants the TUN device by major:minor independent of a `devices:` mapping; combined with an in-container `mknod`, restores tunnel capability that Invariant 1e blocks.
- **`pid_mode: host`** — with sufficient capability/privilege, a container can `nsenter` into the host namespaces, escaping `internal: true` entirely; the most dangerous escalation when combined with the (now-blocked) `privileged: true`.
- **`sysctls` IP-forwarding** (`net.ipv4.ip_forward=1`, `net.ipv6.conf.*.forwarding=1`) — enables container-as-router behavior for relaying traffic.
- **`security_opt` unconfined** (`seccomp:unconfined`, `apparmor:unconfined`) — relaxes kernel confinement, unblocking operations otherwise restricted that aid bypass.

These are not regressions introduced by #899; they are pre-existing vectors deferred from that PR's scope and tracked in #908 for incremental, deliberate hardening.

## Requirements Trace

- R1. The guard fails any service whose `cap_add` includes `ALL` (normalized for `CAP_` prefix/case, like the existing `NET_ADMIN`/`NET_RAW` check).
- R2. The guard fails any service declaring a `device_cgroup_rules` entry that grants a device (any allow rule; the workspace has no legitimate device-grant need).
- R3. The guard fails any service declaring `pid_mode: host`.
- R4. The guard fails any service declaring an egress-relevant `sysctls` entry: `net.ipv4.ip_forward` or `net.ipv6.conf.<iface>.forwarding` set to an enabling value.
- R5. The guard fails any service declaring a confinement-disabling `security_opt`: `seccomp:unconfined` or `apparmor:unconfined` (case/spacing-tolerant).
- R6. Enforcement is blanket (all services), mirroring Invariants 1c-1f.
- R7. The real shipped `deploy/compose.yaml` still passes (no current service uses these keys); benign uses of these keys (if any exist) are not over-rejected.
- R8. Failure messages name the service + offending key/value and fail closed, consistent with existing invariants.

## Scope Boundaries

- Not changing Invariants 1b-1f or the network-attachment / allowlist logic shipped in #814/#899.
- Not adding proxy-agent or mitmproxy/allowlist behavior.
- Blanket all-services enforcement (not scoped to sandbox-net-reachable only), consistent with the existing invariants.
- `sysctls`: denylist of the IP-forwarding family (not a full allowlist) — the stack may legitimately set other benign sysctls.
- `device_cgroup_rules`: reject any device-granting allow rule (not only the TUN major:minor) — broad/fail-closed, consistent with the blanket posture.

### Deferred to Separate Tasks

- IPv6 `extra_hosts` normalized-split edge (Fro Bot NBC on #909): harmless today (only the `host-gateway` value is checked); revisit only if a future docker version emits IPv6 raw-YAML extra_hosts entries.

## Context & Research

### Relevant Code and Patterns

- `deploy/validate-stack.sh` — `check_compose_topology` embeds Python in a bash heredoc. Invariants 1c-1f (added in #899) are the template: each iterates `sorted(services.keys())`, reads a key via `_svc_cfg.get(...)`, handles compose-config + raw-YAML + scalar-string + dict shapes, and `failures.append(...)` with an actionable message. New invariants slot in after Invariant 1f (~line 408), before Invariant 6.
  - `cap_add: ALL` is the exception — not a new invariant; add `"ALL"` to `_BANNED_CAPS` (line 325). Invariant 1d already normalizes `CAP_` prefix + case, so `CAP_ALL` → `ALL` is caught.
- Shape normalization patterns established in #899: `isinstance(_val, str)` → wrap to single-element list (scalar guard); `os.path.normpath` + leading-slash collapse for device paths; `.upper()` + `CAP_` strip for caps. Reuse the same defensive parsing for the new keys.
- Compose key shapes (verify exact normalized forms during implementation, both `docker compose config` and raw-YAML fallback):
  - `device_cgroup_rules`: list of strings like `"c 10:200 rwm"` / `"a *:* rwm"`. An allow rule grants; the first token is the device type (`a`/`b`/`c`), then `major:minor`, then perms.
  - `pid_mode`: scalar string (`"host"`, `"service:x"`, `"container:x"`). Reject `host` (the netns-escape vector); `service:`/`container:` share another container's PID ns, not the host's — reject only `host` per R3.
  - `sysctls`: map `{name: value}` OR list of `"name=value"` strings (compose normalizes to map). Check `net.ipv4.ip_forward` and `net.ipv6.conf.*.forwarding` for enabling values (`1`/`true`).
  - `security_opt`: list of strings (`"seccomp:unconfined"`, `"apparmor:unconfined"`, `"label:..."`, `"no-new-privileges:true"`). Reject the two unconfined forms; allow label/no-new-privileges.
- `deploy/validate-stack.test.sh` — shell test harness; #899 TESTs 26-37 are the style template (single-file fixtures docker-free via `--topology-only`; skip-with-notice when PyYAML/docker needed). Continue numbering from TEST 37 → TEST 38.
- `deploy/README.md` / `deploy/validate-stack.sh` header comment — egress/topology invariant enumeration to extend.

### Institutional Learnings

- #899 + its ce:review established: blanket-ban-with-actionable-message; defensive shape handling (scalar/dict/list, normalization for case/prefix/path); the `docker compose config` normalization-vs-raw-YAML duality; and the discipline of verifying actual normalized shapes during implementation rather than assuming.

### External References

- Issue #908 (the five vectors + the cap_add:ALL / device_cgroup_rules additions from Fro Bot's #909 review).
- TUN device is canonically major 10, minor 200 (informational; device_cgroup_rules rejection is broad, not TUN-specific).

## Key Technical Decisions

- **`cap_add: ALL` via `_BANNED_CAPS`**, not a new invariant — the existing 1d normalization already covers `CAP_ALL`/case; one-line set addition is the minimal correct fix.
- **`device_cgroup_rules`: reject any device-granting (allow) rule** — broad/fail-closed; the workspace stack has no legitimate device-grant need, consistent with the blanket posture. Avoids brittle major:minor matching.
- **`pid_mode`: reject only `host`** — `host` is the netns-escape vector; `service:`/`container:` forms don't reach the host namespace and aren't egress-relevant.
- **`sysctls`: denylist the IP-forwarding family** — targeted (`net.ipv4.ip_forward`, `net.ipv6.conf.*.forwarding`); a full allowlist risks false-positives on benign sysctls the stack may set.
- **`security_opt`: reject `seccomp:unconfined` / `apparmor:unconfined`** only — allow `label:*` and `no-new-privileges` (the latter strengthens confinement).
- **Reuse #899's defensive shape handling** (scalar/dict/list normalization) rather than assuming a single shape per key.

## Open Questions

### Resolved During Planning

- sysctls denylist vs allowlist → denylist (forwarding family) (KTD).
- device_cgroup_rules TUN-specific vs any → any device-grant rule (KTD).
- pid_mode host-only vs all forms → host only (KTD).

### Deferred to Implementation

- Exact normalized shapes of `device_cgroup_rules` / `sysctls` / `security_opt` / `pid_mode` under `docker compose config` vs raw-YAML — verify both paths during implementation and handle each, as #899 did.
- Exact enabling-value matching for sysctls forwarding (`1`, `"1"`, `true`) — determine during implementation.

## Implementation Units

- [ ] **Unit 1: Add cap_add: ALL to the banned capability set**

**Goal:** `cap_add: ALL` / `CAP_ALL` is rejected by the existing capability invariant.

**Requirements:** R1, R6, R8

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (`_BANNED_CAPS`, line 325; update Invariant 1d comment to mention ALL)

**Approach:** Add `"ALL"` to `_BANNED_CAPS`. Invariant 1d already uppercases + strips `CAP_`, so `CAP_ALL`/`all` normalize to `ALL` and match. Confirm the failure message reads sensibly when the offending cap is `ALL` (it grants all caps including NET_ADMIN/NET_RAW).

**Patterns to follow:** existing Invariant 1d.

**Test scenarios:** (covered by Unit 6)

**Verification:** a service with `cap_add: [ALL]` or `[CAP_ALL]` fails; real compose passes.

- [ ] **Unit 2: Reject device_cgroup_rules that grant devices**

**Goal:** The guard fails any service declaring a `device_cgroup_rules` allow rule.

**Requirements:** R2, R6, R8

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (new Invariant after 1f)

**Approach:** Iterate `sorted(services.keys())`; for each, read `device_cgroup_rules` (handle scalar-string → list, list-of-strings). Each rule is like `"c 10:200 rwm"` / `"a *:* rwm"`. Reject any non-empty rule that grants access (any allow rule — there's no legitimate device-grant in this stack). Message names the service + the rule + why (grants device access bypassing the /dev/net/tun control). Fail closed.

**Patterns to follow:** Invariant 1e (devices) — scalar guard, list iteration, actionable message.

**Test scenarios:** (covered by Unit 6)

**Verification:** a service with `device_cgroup_rules: ["c 10:200 rwm"]` fails; real compose passes.

- [ ] **Unit 3: Reject pid_mode: host**

**Goal:** The guard fails any service declaring `pid_mode: host`.

**Requirements:** R3, R6, R8

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (new Invariant after 1f)

**Approach:** Iterate services; read `pid_mode` (scalar string). Reject when it equals `host` (case/strip-tolerant). Do not reject `service:`/`container:` forms (not host-namespace escape). Message names the service + pid_mode:host + the nsenter/netns-escape rationale.

**Patterns to follow:** Invariant 1f (privileged) — scalar value check.

**Test scenarios:** (covered by Unit 6)

**Verification:** `pid_mode: host` fails; `pid_mode: "service:foo"` passes; real compose passes.

- [ ] **Unit 4: Reject IP-forwarding sysctls**

**Goal:** The guard fails any service enabling IP forwarding via `sysctls`.

**Requirements:** R4, R6, R8

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (new Invariant after 1f)

**Approach:** Iterate services; read `sysctls` (handle map `{name: value}` AND list-of-`"name=value"` strings — compose normalizes to map). For each entry, if the key is `net.ipv4.ip_forward` or matches `net.ipv6.conf.<iface>.forwarding`, and the value is enabling (`1`/`"1"`/`true`), fail. Message names the service + the sysctl + the container-as-router rationale. Don't reject benign sysctls or forwarding set to `0`.

**Patterns to follow:** Invariant 1c (extra_hosts) — handles both dict and list-of-strings shapes.

**Test scenarios:** (covered by Unit 6)

**Verification:** `sysctls: {net.ipv4.ip_forward: 1}` fails; a benign sysctl (or forwarding=0) passes; real compose passes.

- [ ] **Unit 5: Reject confinement-disabling security_opt**

**Goal:** The guard fails any service that disables seccomp or AppArmor confinement.

**Requirements:** R5, R6, R8

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (new Invariant after 1f; update header comment to enumerate all new invariants)

**Approach:** Iterate services; read `security_opt` (scalar guard → list of strings). Normalize each entry (strip/lower), reject `seccomp:unconfined` and `apparmor:unconfined` (tolerate spacing like `seccomp=unconfined`). Allow `label:*` and `no-new-privileges:*`. Message names the service + the offending option + the confinement-relaxation rationale.

**Patterns to follow:** Invariant 1d (cap_add) — normalize then membership/pattern check; scalar guard.

**Test scenarios:** (covered by Unit 6)

**Verification:** `security_opt: ["seccomp:unconfined"]` fails; `["no-new-privileges:true"]` passes; real compose passes.

- [ ] **Unit 6: Guard tests for all five vectors**

**Goal:** Lock each rejection + benign/positive controls with regression tests.

**Requirements:** R1-R5, R7, R8

**Dependencies:** Units 1-5

**Files:**
- Modify: `deploy/validate-stack.test.sh` (continue from TEST 37)

**Approach:** Single-file fixtures, docker-free via `--topology-only`/raw-YAML where possible; skip-with-notice if a form needs PyYAML/docker (per #899 TESTs 36/37). Write failing fixtures first; confirm each fails WITH the fix and would pass WITHOUT the corresponding invariant (teeth).

**Test scenarios:**
- Edge: `cap_add: [ALL]` → fails (names service + ALL).
- Edge: `cap_add: [CAP_ALL]` → fails (prefix normalization).
- Edge: `device_cgroup_rules: ["c 10:200 rwm"]` → fails (names service + rule).
- Edge: `pid_mode: host` → fails.
- Happy path: `pid_mode: "service:foo"` → passes (not host-ns escape).
- Edge: `sysctls: {net.ipv4.ip_forward: 1}` → fails.
- Edge: `sysctls` list form `["net.ipv6.conf.all.forwarding=1"]` → fails (shape + ipv6).
- Happy path: `sysctls: {net.ipv4.ip_forward: 0}` (or a benign sysctl) → passes (no over-rejection).
- Edge: `security_opt: ["seccomp:unconfined"]` → fails.
- Edge: `security_opt: ["apparmor:unconfined"]` → fails.
- Happy path: `security_opt: ["no-new-privileges:true"]` → passes.
- Happy path: real `deploy/compose.yaml` passes (if not already covered by TEST 2/17, note the dup rather than re-adding).

**Verification:** suite passes; removing each Unit 1-5 check makes its fixture pass (teeth); benign/positive controls pass; pre-existing PyYAML-absent failures unchanged.

- [ ] **Unit 7: Document the additional rejected keys**

**Goal:** Operators understand the full set of forbidden egress-weakening keys.

**Requirements:** R8

**Dependencies:** Units 1-5

**Files:**
- Modify: `deploy/README.md` (egress/topology section), `deploy/validate-stack.sh` header comment

**Approach:** Extend the rejected-keys list: the guard rejects `network_mode`, `extra_hosts:host-gateway`, `cap_add:NET_ADMIN/NET_RAW/ALL`, `/dev/net/tun` devices, `privileged:true`, plus `device_cgroup_rules` device grants, `pid_mode:host`, IP-forwarding `sysctls`, and `seccomp/apparmor:unconfined` `security_opt`. Operator-facing prose, no plan taxonomy.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** docs enumerate all rejected keys; guard header comment matches the invariants.

## System-Wide Impact

- **Interaction graph:** guard runs in the `workspace-smoke` CI job (`validate-stack.sh --topology-only` + `validate-stack.test.sh`). Additive checks only.
- **Error propagation:** fail-closed (any offending key → non-zero exit + named failure).
- **API surface parity:** none — internal deploy tooling.
- **Unchanged invariants:** network-attachment allowlist, drift check, Invariants 1b-1f, workspace/mitmproxy/volume invariants untouched; real compose stack continues to pass.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Over-rejecting a benign sysctl/security_opt | Denylist is narrow (forwarding family; only the two unconfined security_opt); Unit 6 includes benign positive-control tests |
| Normalized shape differs (compose-config vs raw-YAML) | Reuse #899 defensive shape handling; deferred-to-implementation note to verify exact shapes |
| New check fails the real stack | Unit 6 asserts real `deploy/compose.yaml` passes; run guard against it |
| device_cgroup_rules broad reject blocks a future legit device | Acceptable: no current device need; a future need would be a deliberate, reviewed change |

## Documentation / Operational Notes

- `deploy/README.md` egress section updated for the additional rejected keys. Closes #908.

## Sources & References

- Issue #908 (egress-escalation compose keys); Fro Bot review of #909 (cap_add:ALL, device_cgroup_rules).
- Code: `deploy/validate-stack.sh` (Invariants 1c-1f as template, `_BANNED_CAPS` line 325), `deploy/validate-stack.test.sh` (TESTs 26-37 style), `deploy/compose.yaml`, `deploy/README.md`.
- Related: #899/#909 (the egress-key rejections this completes), #814/#745.
