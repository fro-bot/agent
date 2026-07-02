---
title: "fix: Reject host-namespace-sharing compose keys in the topology guard (#910)"
type: fix
status: done
date: 2026-06-14
---

> **Status: done.** All 3 units shipped: `ipc: host` rejection + `SYS_PTRACE` added to the banned capability set, guard tests, and docs — verified on `main` (`deploy/validate-stack.sh`, PR #914).

# Reject host-namespace-sharing compose keys in the topology guard (#910)

## Overview

The topology guard now rejects the egress-weakening and egress-escalation compose keys (#909, #911). Review of #908 surfaced a distinct, lower-severity class: host-namespace-sharing keys that enable cross-container / lateral-movement attacks within the host trust boundary rather than direct egress around mitmproxy. This plan closes that class: reject `ipc: host` (new invariant, mirroring the `pid: host` check) and add `SYS_PTRACE` to the banned capability set. Plus tests + docs. Closes #910.

## Problem Frame

- **`ipc: host`** shares the host IPC namespace (shared memory, semaphores, message queues). Not a standalone egress bypass, but combined with `SYS_PTRACE` it enables tracing/inspecting host processes that share IPC — a lateral-movement path within the host trust boundary.
- **`cap_add: SYS_PTRACE`** grants process tracing/inspection; dangerous in combination with shared namespaces.

Different threat class from the egress work (lateral-movement / cross-container, not "reach the internet around mitmproxy"). The primary containment boundary remains `sandbox-net` `internal: true`; this is defense-in-depth for the within-host trust boundary. Deferred from #908 scope and tracked in #910 for deliberate, incremental hardening.

## Requirements Trace

- R1. The guard fails any service declaring `ipc: host`.
- R2. The guard fails any service whose `cap_add` includes `SYS_PTRACE` (normalized for `CAP_` prefix/case by the existing capability invariant).
- R3. Enforcement is blanket (all services), mirroring the existing invariants.
- R4. The real shipped `deploy/compose.yaml` still passes; non-host `ipc` modes (e.g. `ipc: "service:x"`, `shareable`) and benign capabilities are not over-rejected.
- R5. Failure messages name the service + offending key/value and fail closed, consistent with existing invariants.

## Scope Boundaries

- Not changing Invariants 1b-1j or the network-attachment / allowlist logic.
- Reject only `ipc: host` (the host-namespace vector); `ipc: "service:x"`/`"container:x"`/`shareable`/`private` are not host-namespace escapes and stay allowed (parallel to the `pid: host`-only decision in #908).

## Context & Research

### Relevant Code and Patterns

- `deploy/validate-stack.sh` — `check_compose_topology`. Invariant 1h (`pid: host`) is the exact template for `ipc: host`: iterate `sorted(services.keys())`, read the scalar key, reject `== "host"` (strip/lower-tolerant), `failures.append(...)`. New invariant slots in after Invariant 1j, before Invariant 6.
  - `SYS_PTRACE` is not a new invariant — add `"SYS_PTRACE"` to `_BANNED_CAPS` (line 350). Invariant 1d already normalizes `CAP_` prefix + case, so `CAP_SYS_PTRACE`/lowercase is caught.
- Verified key shapes (`docker compose config`): `ipc` is the canonical Compose key (accepted, kept as `ipc: host` in normalized output) — scalar string, like `pid`.
- `deploy/validate-stack.test.sh` — TESTs 49-57 (#908) are the style template. Continue from TEST 57 → TEST 58.
- `deploy/README.md` / `deploy/validate-stack.sh` header comment — invariant enumeration to extend.

### Institutional Learnings

- #899/#908 + their ce:reviews established: blanket-ban-with-actionable-message; defensive scalar/dict/list shape handling; `CAP_`/case capability normalization; and verifying actual normalized compose-config shapes during implementation (the #908 `pid` vs `pid_mode` catch).

### External References

- Issue #910 (the `ipc:host` + `SYS_PTRACE` namespace-sharing class).

## Key Technical Decisions

- **`SYS_PTRACE` via `_BANNED_CAPS`**, not a new invariant — existing 1d normalization covers it; one-line set addition.
- **`ipc`: reject only `host`** — `host` is the namespace-sharing vector; `service:`/`container:`/`shareable`/`private` are not host escapes (parallel to the `pid: host`-only decision).
- **Reuse Invariant 1h's structure** for the `ipc` check.

## Open Questions

### Resolved During Planning

- ipc host-only vs all forms → host only (KTD).
- SYS_PTRACE as invariant vs banned-cap → banned-cap addition (KTD).

### Deferred to Implementation

- Confirm `ipc` normalized shape (scalar string) holds for the raw-YAML fallback path too; handle consistently with Invariant 1h.

## Implementation Units

- [x] **Unit 1: Reject ipc: host and add SYS_PTRACE to the banned caps**

**Goal:** The guard fails any service declaring `ipc: host` or `cap_add: SYS_PTRACE`.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Modify: `deploy/validate-stack.sh` (`_BANNED_CAPS` line 350 + 1d comment; new Invariant 1k for `ipc: host` after 1j; header comment enumeration)

**Approach:**
- Add `"SYS_PTRACE"` to `_BANNED_CAPS`; update the 1d comment to note it enables host-process tracing dangerous with shared namespaces.
- New Invariant 1k: iterate `sorted(services.keys())`, read `ipc` (scalar string), reject when `== "host"` (strip/lower). Do not reject `service:`/`container:`/`shareable`/`private`. Message names the service + `ipc: host` + the host-IPC-namespace / lateral-movement rationale.
- Update the header comment block to enumerate Invariant 1k.

**Patterns to follow:** Invariant 1h (`pid: host`) for the ipc check; Invariant 1d for the cap addition.

**Test scenarios:** (covered by Unit 2)

**Verification:** `ipc: host` fails; `cap_add: [SYS_PTRACE]` fails; `ipc: "service:foo"` passes; real `deploy/compose.yaml` passes.

- [x] **Unit 2: Guard tests**

**Goal:** Lock the two rejections + positive controls.

**Requirements:** R1, R2, R4, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `deploy/validate-stack.test.sh` (continue from TEST 57)

**Approach:** Single-file fixtures docker-free via `--topology-only`; skip-with-notice if a form needs PyYAML/docker. Write failing fixtures first; confirm each fails WITH the fix and would pass WITHOUT it (teeth).

**Test scenarios:**
- Edge: `ipc: host` → fails (names service + ipc:host).
- Edge: `cap_add: [SYS_PTRACE]` → fails.
- Edge: `cap_add: [CAP_SYS_PTRACE]` → fails (prefix normalization).
- Happy path: `ipc: "service:mitmproxy"` → passes (not host-ns escape).
- Happy path: real `deploy/compose.yaml` passes (if TEST 2 covers it, note the dup rather than re-adding).

**Verification:** suite passes; removing the Unit 1 checks makes the fixtures pass (teeth); positive controls pass; pre-existing PyYAML-absent failures unchanged.

- [x] **Unit 3: Document the additional rejected keys**

**Goal:** Operators understand `ipc: host` and `SYS_PTRACE` are forbidden.

**Requirements:** R5

**Dependencies:** Unit 1

**Files:**
- Modify: `deploy/README.md` (egress/topology section), `deploy/validate-stack.sh` header comment

**Approach:** Add to the rejected-keys list: `ipc: host` and `cap_add: SYS_PTRACE`, noting they share host namespaces / enable host-process tracing (lateral-movement defense-in-depth). Operator-facing prose, no plan taxonomy.

**Test scenarios:** Test expectation: none — documentation only.

**Verification:** docs enumerate the new rejected keys; guard header comment matches the invariants.

## System-Wide Impact

- **Interaction graph:** guard runs in the `workspace-smoke` CI job. Additive checks only.
- **Error propagation:** fail-closed.
- **Unchanged invariants:** Invariants 1b-1j, network-attachment allowlist, workspace/mitmproxy/volume invariants untouched; real compose stack continues to pass.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Over-rejecting a non-host `ipc` mode | Reject only `host`; Unit 2 includes an `ipc: service:` positive control |
| New check fails the real stack | Unit 2 asserts real `deploy/compose.yaml` passes |

## Documentation / Operational Notes

- `deploy/README.md` egress section updated. Closes #910.

## Sources & References

- Issue #910 (namespace-sharing compose keys); Fro Bot review of #911.
- Code: `deploy/validate-stack.sh` (Invariant 1h template, `_BANNED_CAPS` line 350), `deploy/validate-stack.test.sh` (TESTs 49-57 style), `deploy/compose.yaml`, `deploy/README.md`.
- Related: #908/#911, #899/#909 (the egress-key rejections this complements).
