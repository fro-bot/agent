---
module: deploy
date: 2026-06-14
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "writing or extending a denylist/allowlist guard over a normalized declarative config (Docker Compose, K8s, Terraform, OPA)"
  - "adding invariants to deploy/validate-stack.sh check_compose_topology()"
  - "guarding against container-escape, egress-bypass, or namespace-sharing compose keys"
  - "running security-weighted review on guard code (capability/path/value normalization, scalar-vs-list shape, superset capabilities)"
  - "deciding whether a flagged config key is real or an invalid-key false-positive"
related_components:
  - deploy/validate-stack.sh
  - deploy/compose.yaml
tags:
  - compose-topology
  - docker-compose
  - security-guard
  - egress-bypass
  - normalization
  - fail-closed
  - container-escape
---

# Hardening a Docker Compose topology guard against container-escape keys

## Context

The fro-bot agent stack confines a workspace container so it can only reach the internet through a mitmproxy allowlist:

```
workspace → sandbox-net (internal:true) → mitmproxy → egress-net → internet
```

`sandbox-net internal:true` is the primary boundary — a network with no gateway. The topology guard (`deploy/validate-stack.sh`, `check_compose_topology`, run in the `workspace-smoke` CI job) is defense-in-depth: it rejects any compose key that could re-introduce a path around mitmproxy. Any overlooked key collapses the whole containment model — a TUN device + `NET_ADMIN` builds a tunnel; `pid: host` + a capability enables `nsenter` into host namespaces; `device_cgroup_rules` + `mknod` recreates `/dev/net/tun` even when the device mapping is blocked.

A hardening arc across three PRs (#899/#909, #908/#911, #910/#914) extended the guard from the network-attachment checks to the full escape surface (Invariants 1b–1m). Security-weighted `ce:review` on that arc caught **9 real bypasses** of the naive checks before they shipped — each one would have shipped as *false security*.

## Guidance

### 1. Match the ACTUAL normalized shape — and handle both the tool path and the raw fallback

`docker compose config --format json` normalizes the file into specific shapes that differ from authored YAML, and the guard also has a raw-YAML fallback (for CI without Docker). The same logical key takes different shapes in each path:

| Key | compose-config shape | raw-YAML shape |
|-----|----------------------|----------------|
| `extra_hosts` | list of `"name=value"` | list of `"name:value"`, dict, or scalar |
| `devices` | list of dicts `{source,target,permissions}` | list of `"host:container[:perms]"` or scalar |
| `cap_add` | list (`CAP_` prefix + case preserved) | list or scalar |
| `sysctls` | dict `{name: value}` (ints coerced to str) | dict or list of `"name=value"` |
| `security_opt` | list of strings | list or scalar |
| `pid`/`ipc`/`userns_mode`/`uts` | scalar string | scalar string |

Write every check `isinstance`-branched and handle every shape in both paths. Don't infer shapes from docs — read `docker compose config --format json`.

### 2. Verify a key is VALID before guarding it

Compose silently drops unknown keys as schema errors, so a guard over an invalid key is dead code: the file passes because the key is gone from the normalized config, and the developer assumes protection. The arc hit this exactly — three reviewers proposed guarding `pid_mode: host`, but `docker compose config` **rejects** `pid_mode` (`additional properties 'pid_mode' not allowed`); the valid key is `pid`. Guarding `pid_mode` would always read `None` and never fire.

Verification technique: write a negative test with the *real* key, run it through `docker compose config`, and confirm the guard fires. The test that *should* fail but silently passes is the bug.

### 3. Normalize capability names AND ban supersets

Capabilities have equivalent forms (`NET_ADMIN` / `cap_net_admin` / `CAP_NET_ADMIN`) and supersets that imply the dangerous ones. Strip `CAP_`, uppercase, then check membership — and put the supersets in the banned set:

```python
_BANNED_CAPS = {"NET_ADMIN", "NET_RAW", "SYS_MODULE", "SYS_ADMIN", "SYS_PTRACE", "ALL"}
for _cap in (_cap_add if isinstance(_cap_add, list) else [_cap_add]):
    _cap_norm = str(_cap).strip().upper()
    if _cap_norm.startswith("CAP_"):
        _cap_norm = _cap_norm[4:]
    if _cap_norm in _BANNED_CAPS:
        failures.append(...); break
```

`ALL` grants everything; `SYS_MODULE` loads kernel modules (allowed by Docker's default seccomp when the cap is present); `SYS_ADMIN` enables the `nsenter` namespace-escape chain. `privileged: true` is a separate top-level invariant even though it implies all of these — belt and suspenders, because it is not a `cap_add` entry.

### 4. Normalize paths and values the kernel/daemon treat as equivalent

A literal `==` misses equivalent forms the runtime collapses:

- Device paths: `//dev/net/tun`, `/dev/./net/tun` all resolve to `/dev/net/tun`. Normalize with leading-slash collapse + `os.path.normpath` before comparing. (`os.path.normpath` alone does NOT collapse a leading `//` — POSIX leaves it implementation-defined.)
- Sysctls: the kernel aliases `net.ipv4.conf.all.forwarding` and `net.ipv4.conf.<iface>.forwarding` to `net.ipv4.ip_forward`. Match all three (plus the IPv6 family) by regex.
- Enabling values: `1`, `"1"`, `True`, `"true"` all mean enabled. Check the post-normalization value.

### 5. Fail closed, blanket all services, with positive controls

Reject on **all** services, not just the sandboxed one — a banned key on a sibling (the proxy, a gateway) is also a regression. Append a failure and `exit 1`; no warn-only mode. Pair every negative test with **positive controls** proving non-host modes are not over-rejected: `ipc: none/shareable/service:x`, `pid: service:x`, `sysctls forwarding=0`, `security_opt seccomp:default` / `no-new-privileges`, a benign cap like `SYS_TIME`, benign `extra_hosts`. The `security_opt` "anything but default" check uses a negative lookahead:

```python
_SECOPT_CUSTOM_RE = re.compile(r'^(seccomp|apparmor)[:=](?!default$).+', re.IGNORECASE)
```

This rejects the prefixed `seccomp:unconfined`/`apparmor:unconfined` forms and custom profile paths (`seccomp=/path.json`) while allowing the implicit/explicit default.

### 6. Security-weighted review on guard code is high-value

A guard over a normalized config is only as good as the negative tests for the **equivalence classes** the normalizer creates. Review must enumerate every shape, not just the canonical form. The arc's caught bypasses, each now locked by a named test:

| Bypass | Fix |
|--------|-----|
| `cap_add: [CAP_NET_ADMIN]` / `[cap_net_admin]` | strip `CAP_` + uppercase |
| `cap_add: NET_ADMIN` (scalar) | wrap scalar → 1-element list |
| `cap_add: [ALL]` / `[CAP_ALL]` | add `ALL` to banned set |
| `cap_add: SYS_MODULE` / `SYS_ADMIN` | add to banned set (kernel-module load / nsenter escape) |
| `devices: ["//dev/net/tun"]` / `["/dev/./net/tun"]` | leading-slash collapse + `os.path.normpath` |
| `extra_hosts: {h: host-gateway}` (dict) | dict branch via `.values()` |
| `sysctls: ["net.ipv6.conf.all.forwarding=1"]` (list) | list→dict branch + IPv6 regex |
| `net.ipv4.conf.all.forwarding=1` | kernel-alias regex alongside the global flag |
| `security_opt: ["seccomp=/profile.json"]` | reject any non-`default` seccomp/apparmor |

Disproved false-positive: `pid_mode: host` — an invalid compose key, inert, not a bypass (see rule 2).

## Why This Matters

A guard that looks like it blocks an attack but is bypassable is worse than none — it produces false confidence. A developer reads its existence as "we're protected", changes a key to an equivalent form, sees the suite pass, and ships. Each bypass is a complete sandbox escape (e.g. `cap_add: [ALL]` → `SYS_MODULE` → load a tunnel module → full egress around mitmproxy). The test suite must enumerate the equivalence classes the normalizer creates, not just the spec's canonical form.

## When to Apply

Any denylist/allowlist guard over a declarative config that a tool **normalizes before enforcement**: Docker Compose (`docker compose config`), Kubernetes (`kubectl --dry-run=server -o json`, plus admission mutations), Terraform (`terraform plan`), OPA/Rego, or CI lint over normalized YAML. The five rules generalize: match every normalized shape; verify the key is valid; normalize set-membership values for the runtime's equivalence classes; normalize paths/value strings; fail closed + blanket all entities with positive controls.

## Related

- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — adjacent workspace/deploy hardening (config/auth provisioning, different failure class)
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — sibling Docker/deploy image-safety
- `docs/solutions/best-practices/cross-libc-build-and-release-safety-2026-06-14.md` — same deploy surface, build/release verification
- Source: `deploy/validate-stack.sh` (Invariants 1b–1m), `deploy/validate-stack.test.sh`
- Issues: #899, #908, #910 (and the egress topology work in #745/#814)
