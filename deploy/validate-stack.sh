#!/usr/bin/env bash
# validate-stack.sh — Smoke-test the fro-bot compose stack.
#
# Assumes the stack is already running:
#   docker compose -f deploy/compose.yaml up -d
#
# Usage (from repo root):
#   bash deploy/validate-stack.sh
#
# To run only the static network-topology check (no running stack required):
#   bash deploy/validate-stack.sh --topology-only
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-deploy/compose.yaml}"
PYTHON3_BIN="${PYTHON3_BIN:-python3}"

# ---------------------------------------------------------------------------
# check_compose_topology — static network-topology and persistence invariant assertion.
#
# Parses `docker compose config` output (no running containers needed) and
# enforces the containment model:
#
#   workspace → sandbox-net (internal:true) → mitmproxy → egress-net → internet
#
# Invariants checked:
#   1. sandbox-net is internal:true — no direct internet gateway for any
#      container on this network.
#   1b. NO service may declare network_mode — bypasses the network-attachment
#      model entirely (host/shared networking).
#   1c. NO service may declare extra_hosts with a host-gateway value — gives
#      the container the Docker host's bridge IP, enabling egress relay around
#      mitmproxy via any host-bound proxy/tunnel.
#   1d. NO service may declare cap_add with NET_ADMIN, NET_RAW, or ALL —
#      enables raw-socket/routing manipulation used to build VPN tunnels that
#      bypass mitmproxy.  ALL grants every capability including NET_ADMIN and
#      NET_RAW.  CAP_ prefix and case variants are normalized before checking.
#   1e. NO service may map the /dev/net/tun device — the TUN/TAP interface
#      used by VPN clients to construct egress tunnels around mitmproxy.
#      Path normalization catches //, /./ and similar variants.
#   1f. NO service may declare privileged: true — grants ALL capabilities and
#      ALL host devices, nullifying Invariants 1d and 1e entirely.
#   1g. NO service may declare device_cgroup_rules with any device-grant rule —
#      a cgroup allow rule (e.g. "c 10:200 rwm") grants device access by
#      major:minor independent of a devices: mapping; combined with mknod it
#      restores tunnel capability that Invariant 1e blocks.
#   1h. NO service may declare pid: host — with sufficient capability a
#      container can nsenter into host namespaces, escaping internal:true
#      entirely.  pid: service:<x>/container:<x> is not rejected.
#   1i. NO service may declare an IP-forwarding sysctl (net.ipv4.ip_forward or
#      net.ipv6.conf.<iface>.forwarding) set to an enabling value — enables
#      container-as-router behavior for relaying traffic.
#   1j. NO service may declare a confinement-disabling security_opt
#      (seccomp:unconfined or apparmor:unconfined) — relaxes kernel confinement
#      and unblocks operations that aid egress bypass.
#   2. workspace is attached to sandbox-net ONLY — it has zero direct egress.
#   3. mitmproxy is attached to sandbox-net AND at least one non-internal
#      network (its upstream leg to the internet).
#   4. workspace is attached to NO non-internal network — it cannot reach the
#      internet directly, even if a new network is added to the compose file.
#   5. Only allowlisted (service, network) pairs may attach to any non-internal
#      network: {mitmproxy→egress-net, gateway→gateway-net}. Any other service
#      on any non-internal network fails closed. Unknown non-internal network
#      declarations also fail (drift check).
#   6. workspace mounts the named volume 'workspace-repos' at exactly
#      '/workspace/repos' — repo checkouts must survive container recreation.
#
# Exit non-zero with a descriptive message if any invariant fails.
# ---------------------------------------------------------------------------
check_compose_topology() {
  echo "==> Checking compose network topology invariants..."

  COMPOSE_FILE="${COMPOSE_FILE}" "${PYTHON3_BIN}" - <<'PYEOF'
import json
import os
import subprocess
import sys

compose_file_env = os.environ.get("COMPOSE_FILE", "deploy/compose.yaml")

# Support Docker's native multi-file COMPOSE_FILE: files are separated by
# COMPOSE_PATH_SEPARATOR (default ':' on Linux/macOS, ';' on Windows).
# When multiple files are specified, docker compose merges them in order
# (later files override earlier ones), exactly as `docker compose -f a -f b`.
path_sep = os.environ.get("COMPOSE_PATH_SEPARATOR", ":")
compose_files = [f for f in compose_file_env.split(path_sep) if f]

# Build the list of -f args for docker compose invocations.
# Single-file case produces exactly ["-f", "<file>"] — byte-for-byte identical
# to the previous behaviour.
f_args = sum([["-f", f] for f in compose_files], [])

try:
    result = subprocess.run(
        ["docker", "compose"] + f_args + ["config", "--format", "json"],
        capture_output=True,
        text=True,
        check=True,
    )
    cfg = json.loads(result.stdout)
except (subprocess.CalledProcessError, OSError):
    # Fall back to YAML parse if:
    #   - docker/compose is not installed (OSError/FileNotFoundError), or
    #   - --format json is not supported by this docker compose version
    #     (CalledProcessError), or
    #   - docker compose is otherwise unavailable.
    try:
        import yaml
        try:
            result2 = subprocess.run(
                ["docker", "compose"] + f_args + ["config"],
                capture_output=True,
                text=True,
                check=True,
            )
            cfg = yaml.safe_load(result2.stdout)
        except (subprocess.CalledProcessError, OSError):
            # docker compose unavailable — parse the raw YAML file(s) directly.
            # docker-present multi-file: `docker compose -f a -f b config` performs
            #   an authoritative merge (stays correct above in the docker-present path).
            # docker-absent single-file: parse the raw YAML directly (safe).
            # docker-absent multi-file: FAIL CLOSED — raw YAML shallow-merge replaces
            #   whole service dicts and cannot faithfully reproduce Docker Compose merge
            #   semantics; a partial override would be misread as a full replacement,
            #   producing false failures on valid configs.
            if len(compose_files) > 1:
                print(
                    "ERROR: COMPOSE_FILE lists multiple files but docker compose is "
                    "unavailable. The raw-YAML fallback cannot faithfully reproduce "
                    "Docker Compose merge semantics. Install docker compose, or "
                    "validate a single fully-rendered compose file.",
                    file=sys.stderr,
                )
                sys.exit(1)
            with open(compose_files[0]) as fh:
                cfg = yaml.safe_load(fh)
    except Exception as e2:
        print(f"ERROR: could not parse compose config: {e2}", file=sys.stderr)
        sys.exit(1)
except json.JSONDecodeError as e:
    print(f"ERROR: compose config JSON parse failed: {e}", file=sys.stderr)
    sys.exit(1)

networks = cfg.get("networks", {})
services = cfg.get("services", {})

failures = []

# ------------------------------------------------------------------
# Invariant 1: sandbox-net must be internal:true
# ------------------------------------------------------------------
sandbox = networks.get("sandbox-net", {})
if not sandbox.get("internal", False):
    failures.append(
        "FAIL: sandbox-net is not internal:true — containers on this network "
        "have a host gateway and can reach the internet directly."
    )

# ------------------------------------------------------------------
# Helper: collect the set of non-internal network names.
# A network is non-internal when internal is absent or false.
# ------------------------------------------------------------------
non_internal_nets = {
    name for name, spec in networks.items()
    if not (spec or {}).get("internal", False)
}

# ------------------------------------------------------------------
# Helper: get the network names a service is attached to.
# docker compose config normalises service.networks to a dict keyed
# by network name; the value may be None or a config dict.
# ------------------------------------------------------------------
def service_networks(svc_name):
    svc = services.get(svc_name, {})
    nets = svc.get("networks", {})
    if isinstance(nets, list):
        return set(nets)
    return set(nets.keys())

workspace_nets = service_networks("workspace")
mitmproxy_nets = service_networks("mitmproxy")

# ------------------------------------------------------------------
# Invariant 1b: NO service may declare network_mode.
#
# A compose override can set network_mode: host (or service:<x> /
# container:<x>) on any service.  Such a service has NO 'networks' key,
# so the network-attachment invariants below pass VACUOUSLY while the
# container actually has host/shared networking — bypassing containment
# entirely.  Reject any network_mode declaration on ANY service,
# regardless of value.  Service names are sorted for deterministic output.
#
# Capture the set of services that declare network_mode so that the
# per-service network-attachment invariants below can skip them — a
# service with network_mode produces EXACTLY ONE failure line (this one),
# not confusing secondary attachment messages.
# ------------------------------------------------------------------
network_mode_services = set()
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _nm = _svc_cfg.get("network_mode")
    if _nm:
        network_mode_services.add(_svc)
        failures.append(
            f"FAIL: service '{_svc}' declares network_mode '{_nm}' — "
            "network_mode bypasses the sandbox/egress network-attachment model "
            "and is not permitted."
        )

# ------------------------------------------------------------------
# Invariant 2: workspace is attached to sandbox-net only
# (skipped when workspace declares network_mode — Invariant 1b already
# covers that case and workspace_nets would be empty/misleading)
# ------------------------------------------------------------------
if "workspace" not in network_mode_services and workspace_nets != {"sandbox-net"}:
    failures.append(
        f"FAIL: workspace is attached to networks {sorted(workspace_nets)!r} "
        f"but must be attached to exactly ['sandbox-net']."
    )

# ------------------------------------------------------------------
# Invariant 3: mitmproxy is attached to sandbox-net AND at least one
# non-internal network (its upstream leg).
# (skipped when mitmproxy declares network_mode — Invariant 1b covers it)
# ------------------------------------------------------------------
if "mitmproxy" not in network_mode_services:
    if "sandbox-net" not in mitmproxy_nets:
        failures.append(
            "FAIL: mitmproxy is not attached to sandbox-net — it cannot receive "
            "workspace traffic."
        )
mitmproxy_egress_nets = mitmproxy_nets & non_internal_nets
if "mitmproxy" not in network_mode_services and not mitmproxy_egress_nets:
    failures.append(
        f"FAIL: mitmproxy is attached only to internal networks {sorted(mitmproxy_nets)!r}. "
        "It needs at least one non-internal network as its upstream leg so it "
        "can reach the internet on behalf of the workspace."
    )

# ------------------------------------------------------------------
# Invariant 4: workspace is attached to NO non-internal network
# (skipped when workspace declares network_mode — Invariant 1b covers it)
# ------------------------------------------------------------------
workspace_egress_nets = workspace_nets & non_internal_nets
if "workspace" not in network_mode_services and workspace_egress_nets:
    failures.append(
        f"FAIL: workspace is attached to non-internal network(s) "
        f"{sorted(workspace_egress_nets)!r} — it has direct internet egress, "
        "violating the containment model."
    )

# ------------------------------------------------------------------
# Invariant 5: only allowlisted (service, network) pairs may attach to
# any non-internal network.  The allowlist is the minimal trusted set:
#   mitmproxy → egress-net  (the workspace's only internet chokepoint)
#   gateway   → gateway-net (trusted first-party TCB; see deploy/README.md)
# Any other service on any non-internal network fails closed, including
# services on non-internal networks that mitmproxy is not on.
# Services that declare network_mode are already rejected by Invariant 1b.
# ------------------------------------------------------------------
allowed_non_internal_attachments = {("mitmproxy", "egress-net"), ("gateway", "gateway-net")}
for svc in sorted(services):
    if svc in network_mode_services:
        continue
    for net in sorted(service_networks(svc) & non_internal_nets):
        if (svc, net) not in allowed_non_internal_attachments:
            failures.append(
                f"FAIL: service '{svc}' attached to non-internal network '{net}'; "
                f"only these (service, network) pairs are permitted: {sorted(allowed_non_internal_attachments)!r}"
            )

# Drift check: fail any declared non-internal network not in the known set,
# so a shadow egress network cannot be introduced even before a service joins it.
allowed_non_internal_nets = {"egress-net", "gateway-net"}
for net in sorted(non_internal_nets - allowed_non_internal_nets):
    failures.append(
        f"FAIL: unknown non-internal network '{net}' declared; "
        "only egress-net/gateway-net are permitted"
    )

# ------------------------------------------------------------------
# Invariant 1c: NO service may declare extra_hosts with a host-gateway mapping.
#
# extra_hosts: ["proxy.local:host-gateway"] gives the container the Docker
# host's bridge IP.  If the host runs any forward proxy/SOCKS/tunnel bound
# to 0.0.0.0, the workspace can relay egress around mitmproxy.  Reject any
# extra_hosts entry whose value is "host-gateway" on ANY service.
#
# Normalized shape (docker compose config JSON): list of "name=value" strings.
# Raw-YAML fallback shape: list of "name:value" strings OR a dict {name: value}.
# ------------------------------------------------------------------
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _extra_hosts = _svc_cfg.get("extra_hosts") or []
    if isinstance(_extra_hosts, dict):
        # Raw-YAML dict form: {hostname: value}
        _extra_hosts_items = list(_extra_hosts.values())
    else:
        # Scalar-string guard: a bare string (e.g. extra_hosts: "proxy.local:host-gateway")
        # would be iterated character-by-character without this wrap.
        if isinstance(_extra_hosts, str):
            _extra_hosts = [_extra_hosts]
        # Normalized list form: ["name=value", ...] or raw-YAML ["name:value", ...]
        _extra_hosts_items = []
        for _entry in _extra_hosts:
            if isinstance(_entry, dict):
                # Possible future dict-list form
                _extra_hosts_items.append(_entry.get("ip") or _entry.get("value") or "")
            elif isinstance(_entry, str):
                # Split on first '=' (normalized) or first ':' (raw YAML)
                if "=" in _entry:
                    _extra_hosts_items.append(_entry.split("=", 1)[1])
                elif ":" in _entry:
                    _extra_hosts_items.append(_entry.split(":", 1)[1])
    for _val in _extra_hosts_items:
        if str(_val).strip() == "host-gateway":
            failures.append(
                f"FAIL: service '{_svc}' declares extra_hosts with value 'host-gateway' — "
                "host-gateway gives the container the Docker host's bridge IP and can relay "
                "workspace egress around mitmproxy. Remove the host-gateway extra_hosts entry."
            )
            break

# ------------------------------------------------------------------
# Invariant 1d: NO service may declare cap_add with NET_ADMIN or NET_RAW.
#
# NET_ADMIN and NET_RAW enable raw-socket and routing-table manipulation.
# Combined with a VPN client image and /dev/net/tun, they can build a tunnel
# that bypasses mitmproxy.  Reject either capability on ANY service.
#
# Normalization: Docker Compose may preserve the CAP_ prefix (e.g.
# CAP_NET_ADMIN) or lowercase variants (cap_net_admin) from raw YAML.
# Strip a leading CAP_ prefix and uppercase before checking the banned set
# so all forms are caught.  ALL is included because it grants every capability
# including NET_ADMIN and NET_RAW — same supersetting threat as privileged:true.
#
# Scalar-string guard: if cap_add is a bare string (not a list), wrap it
# into a single-element list before iterating so scalar YAML values are
# not silently missed by character-iteration.
# ------------------------------------------------------------------
_BANNED_CAPS = {"NET_ADMIN", "NET_RAW", "ALL"}
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _cap_add = _svc_cfg.get("cap_add") or []
    if isinstance(_cap_add, str):
        _cap_add = [_cap_add]
    for _cap in _cap_add:
        _cap_norm = str(_cap).strip().upper()
        if _cap_norm.startswith("CAP_"):
            _cap_norm = _cap_norm[4:]
        if _cap_norm in _BANNED_CAPS:
            failures.append(
                f"FAIL: service '{_svc}' declares cap_add '{_cap}' — "
                "NET_ADMIN, NET_RAW, and ALL enable raw-socket/routing manipulation that can "
                "tunnel workspace egress around mitmproxy and are not permitted. "
                "(ALL grants every capability including NET_ADMIN and NET_RAW.)"
            )
            break

# ------------------------------------------------------------------
# Invariant 1e: NO service may map the /dev/net/tun device.
#
# /dev/net/tun is the kernel TUN/TAP interface used by VPN clients to build
# tunnels.  Combined with NET_ADMIN/NET_RAW, it provides a complete egress
# bypass path.  Reject any device mapping whose host path resolves to
# /dev/net/tun on ANY service.
#
# Normalized shape (docker compose config JSON): list of dicts {source, target, permissions}.
# Raw-YAML fallback shape: list of "host:container[:perms]" strings.
#
# Path normalization: collapse multiple leading slashes to one (POSIX treats
# // as implementation-defined, but Docker normalizes it to /), then apply
# os.path.normpath to collapse /./ and similar segments.  This catches
# //dev/net/tun, /dev/./net/tun, /dev/net/./tun, etc.
#
# Scalar-string guard: if devices is a bare string (not a list), wrap it
# into a single-element list before iterating.
# ------------------------------------------------------------------
import re as _re

def _norm_dev_path(p):
    """Normalize a device host path: collapse leading // to /, then normpath."""
    p = _re.sub(r'^/+', '/', str(p).strip())
    return os.path.normpath(p)

_TUN_PATH = _norm_dev_path("/dev/net/tun")
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _devices = _svc_cfg.get("devices") or []
    if isinstance(_devices, str):
        _devices = [_devices]
    for _dev in _devices:
        if isinstance(_dev, dict):
            _host_path = _dev.get("source") or ""
        elif isinstance(_dev, str):
            _host_path = _dev.split(":")[0]
        else:
            _host_path = ""
        if _norm_dev_path(_host_path) == _TUN_PATH:
            failures.append(
                f"FAIL: service '{_svc}' maps device '/dev/net/tun' — "
                "the TUN/TAP interface enables VPN tunnel construction that can bypass "
                "mitmproxy egress containment and is not permitted."
            )
            break

# ------------------------------------------------------------------
# Invariant 1f: NO service may declare privileged: true.
#
# privileged: true grants the container ALL Linux capabilities (including
# NET_ADMIN and NET_RAW) plus access to ALL host devices (including
# /dev/net/tun).  It nullifies Invariants 1d and 1e entirely.  Reject
# any service that declares privileged as boolean True or the string "true".
# ------------------------------------------------------------------
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _privileged = _svc_cfg.get("privileged")
    if _privileged is True or str(_privileged).lower() == "true":
        failures.append(
            f"FAIL: service '{_svc}' declares privileged: true — "
            "privileged mode grants all Linux capabilities (including NET_ADMIN and NET_RAW) "
            "and access to all host devices (including /dev/net/tun), bypassing the egress "
            "containment controls enforced by Invariants 1d and 1e. Remove privileged: true."
        )

# ------------------------------------------------------------------
# Invariant 1g: NO service may declare device_cgroup_rules with any
# device-grant (allow) rule.
#
# A cgroup device-allow rule (e.g. "c 10:200 rwm") grants the container
# access to a device by major:minor number, independent of any devices:
# mapping.  Combined with an in-container mknod, this restores tunnel
# capability that Invariant 1e blocks (e.g. recreating /dev/net/tun via
# major 10, minor 200).  The workspace stack has no legitimate device-grant
# need, so any non-empty allow rule is rejected (broad/fail-closed).
#
# Normalized shape (docker compose config JSON): list of strings like
# "c 10:200 rwm" or "a *:* rwm".
# Raw-YAML fallback shape: same list of strings, or a bare scalar string.
#
# Scalar-string guard: wrap a bare string into a single-element list.
# ------------------------------------------------------------------
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _dcgr = _svc_cfg.get("device_cgroup_rules") or []
    if isinstance(_dcgr, str):
        _dcgr = [_dcgr]
    for _rule in _dcgr:
        _rule_s = str(_rule).strip()
        if _rule_s:
            failures.append(
                f"FAIL: service '{_svc}' declares device_cgroup_rules '{_rule_s}' — "
                "device cgroup allow rules grant device access by major:minor number "
                "independent of the devices: mapping; combined with mknod this can "
                "restore tunnel capability bypassing the /dev/net/tun control "
                "(Invariant 1e). Remove all device_cgroup_rules entries."
            )
            break

# ------------------------------------------------------------------
# Invariant 1h: NO service may declare pid: host.
#
# pid: host shares the host's PID namespace with the container.
# With sufficient capability or privilege, a process inside the container
# can nsenter into host namespaces, escaping the internal:true network
# isolation entirely.  This is the most dangerous escalation when combined
# with the (now-blocked) privileged: true.
#
# pid: service:<x> and pid: container:<x> share another container's PID
# namespace (not the host's) and are not rejected here.
#
# Normalized shape (docker compose config JSON): scalar string "host" or
# "service:<x>".  Raw-YAML fallback shape: same scalar string.
# ------------------------------------------------------------------
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _pid = _svc_cfg.get("pid")
    if _pid is not None and str(_pid).strip().lower() == "host":
        failures.append(
            f"FAIL: service '{_svc}' declares pid: host — "
            "pid: host shares the host PID namespace; with sufficient capability "
            "a container process can nsenter into host namespaces and escape the "
            "internal:true network isolation. Remove pid: host."
        )

# ------------------------------------------------------------------
# Invariant 1i: NO service may declare an IP-forwarding sysctl set to an
# enabling value.
#
# net.ipv4.ip_forward=1 and net.ipv6.conf.<iface>.forwarding=1 enable
# container-as-router behavior, allowing the container to relay traffic
# between network interfaces and bypass the mitmproxy chokepoint.
#
# Normalized shape (docker compose config JSON): dict {name: value}.
# Raw-YAML fallback shape: dict {name: value} OR list of "name=value" strings.
# Compose normalizes list form to dict; we handle both defensively.
#
# Enabling values: integer 1, string "1", boolean True/"true".
# Forwarding=0 and all other sysctls are not rejected.
# ------------------------------------------------------------------
import re as _re_sysctl

_IPV6_FWD_RE = _re_sysctl.compile(r'^net\.ipv6\.conf\.[^.]+\.forwarding$')

def _is_enabling_sysctl_value(v):
    """Return True if the sysctl value enables forwarding."""
    if v is True:
        return True
    s = str(v).strip().lower()
    return s in ("1", "true")

for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _sysctls = _svc_cfg.get("sysctls") or {}
    # Handle list-of-"name=value" strings (raw-YAML form)
    if isinstance(_sysctls, list):
        _sysctls_dict = {}
        for _entry in _sysctls:
            if isinstance(_entry, str) and "=" in _entry:
                _k, _v = _entry.split("=", 1)
                _sysctls_dict[_k.strip()] = _v.strip()
        _sysctls = _sysctls_dict
    for _sysctl_key, _sysctl_val in (_sysctls or {}).items():
        _k = str(_sysctl_key).strip()
        if (_k == "net.ipv4.ip_forward" or _IPV6_FWD_RE.match(_k)) and _is_enabling_sysctl_value(_sysctl_val):
            failures.append(
                f"FAIL: service '{_svc}' declares sysctl '{_k}={_sysctl_val}' — "
                "enabling IP forwarding turns the container into a router that can "
                "relay traffic between network interfaces, bypassing the mitmproxy "
                "egress chokepoint. Remove or disable the IP-forwarding sysctl."
            )
            break

# ------------------------------------------------------------------
# Invariant 1j: NO service may declare a confinement-disabling security_opt.
#
# seccomp:unconfined disables the seccomp syscall filter, unblocking
# operations otherwise restricted that aid egress bypass.
# apparmor:unconfined disables the AppArmor MAC profile, similarly
# relaxing kernel confinement.
# label:* and no-new-privileges:* are allowed (the latter strengthens
# confinement).
#
# Normalized shape: list of strings like "seccomp:unconfined",
# "apparmor:unconfined", "label:disable", "no-new-privileges:true".
# Raw-YAML fallback shape: same list, or a bare scalar string.
#
# Scalar-string guard: wrap a bare string into a single-element list.
# Normalization: strip whitespace, lowercase, tolerate = separator.
# ------------------------------------------------------------------
_BANNED_SECURITY_OPTS = {"seccomp:unconfined", "apparmor:unconfined",
                         "seccomp=unconfined", "apparmor=unconfined"}
for _svc in sorted(services.keys()):
    _svc_cfg = services.get(_svc) or {}
    _sec_opts = _svc_cfg.get("security_opt") or []
    if isinstance(_sec_opts, str):
        _sec_opts = [_sec_opts]
    for _opt in _sec_opts:
        _opt_norm = str(_opt).strip().lower()
        if _opt_norm in _BANNED_SECURITY_OPTS:
            failures.append(
                f"FAIL: service '{_svc}' declares security_opt '{_opt}' — "
                "seccomp:unconfined and apparmor:unconfined disable kernel confinement "
                "profiles, unblocking syscalls and operations that aid egress bypass. "
                "Remove the unconfined security_opt entry."
            )
            break

# ------------------------------------------------------------------
# Invariant 6: workspace must mount the named volume 'workspace-repos'
# at exactly '/workspace/repos'.
#
# docker compose config normalises volumes to a list of dicts with
# 'type', 'source', and 'target' keys.  A short-form volume entry
# (e.g. "workspace-repos:/workspace/repos") is expanded to:
#   {"type": "volume", "source": "workspace-repos", "target": "/workspace/repos"}
#
# However, when falling back to raw YAML parsing (docker compose unavailable),
# volume entries may remain as short-form strings:
#   "workspace-repos:/workspace/repos"
#   "workspace-repos:/workspace/repos:ro"
# We must handle both dict entries and short-form string entries.
# ------------------------------------------------------------------
workspace_svc = services.get("workspace", {})
workspace_vols = workspace_svc.get("volumes", [])

REQUIRED_SOURCE = "workspace-repos"
REQUIRED_TARGET = "/workspace/repos"

def parse_volume_entry(v):
    """Return (source, target) from a volume entry that is either a dict or a short-form string."""
    if isinstance(v, dict):
        return (v.get("source"), v.get("target"))
    if isinstance(v, str):
        # Short-form: "source:target" or "source:target:mode"
        parts = v.split(":")
        if len(parts) >= 2:
            return (parts[0], parts[1])
    return (None, None)

repos_mount_found = any(
    (
        # Dict form: type must be "volume" (or absent in raw YAML short-form fallback)
        (not isinstance(v, dict) or (v or {}).get("type") in ("volume", None))
        and parse_volume_entry(v) == (REQUIRED_SOURCE, REQUIRED_TARGET)
    )
    for v in workspace_vols
)

if not repos_mount_found:
    # Provide a targeted message: distinguish missing-entirely from wrong-path/wrong-name.
    has_source = any(
        parse_volume_entry(v)[0] == REQUIRED_SOURCE for v in workspace_vols
    )
    has_target = any(
        parse_volume_entry(v)[1] == REQUIRED_TARGET for v in workspace_vols
    )
    if has_source and not has_target:
        failures.append(
            f"FAIL: workspace mounts volume '{REQUIRED_SOURCE}' but not at "
            f"'{REQUIRED_TARGET}'. Repo checkouts will not survive container "
            "recreation. Mount workspace-repos at /workspace/repos."
        )
    elif has_target and not has_source:
        failures.append(
            f"FAIL: workspace has a volume mounted at '{REQUIRED_TARGET}' but it "
            f"is not the named volume '{REQUIRED_SOURCE}'. Repo checkouts will not "
            "survive container recreation. Use the workspace-repos named volume."
        )
    else:
        failures.append(
            f"FAIL: workspace does not mount the named volume '{REQUIRED_SOURCE}' "
            f"at '{REQUIRED_TARGET}'. Repo checkouts will not survive container "
            "recreation. Add workspace-repos:/workspace/repos to the workspace "
            "service volumes."
        )

# ------------------------------------------------------------------
# Report
# ------------------------------------------------------------------
if failures:
    for msg in failures:
        print(msg, file=sys.stderr)
    sys.exit(1)

print("    sandbox-net: internal=true  ✓")
print(f"    workspace networks: {sorted(workspace_nets)!r}  ✓")
print(f"    mitmproxy networks: {sorted(mitmproxy_nets)!r}  ✓")
print(f"    mitmproxy egress leg(s): {sorted(mitmproxy_egress_nets)!r}  ✓")
print("    workspace has no direct egress  ✓")
print(f"    non-internal network attachments: only allowlisted pairs {sorted(allowed_non_internal_attachments)!r}  ✓")
print(f"    workspace mounts {REQUIRED_SOURCE!r} at {REQUIRED_TARGET!r}  ✓")
PYEOF

  echo "    Topology invariants: OK"
}

# If --topology-only was passed, skip the Docker config validation (which
# requires a working Docker/compose installation) and go straight to the
# raw-YAML topology check.  The topology check itself has a Docker-free
# fallback path, so it works in environments without Docker.
if [[ "${1:-}" == "--topology-only" ]]; then
  check_compose_topology
  echo ""
  echo "==> Topology-only check complete."
  exit 0
fi

# Full validation: require Docker compose to be available and the config to
# be syntactically valid before running the topology check.
echo "==> Validating compose config..."
docker compose -f "${COMPOSE_FILE}" config > /dev/null
echo "    OK"

# Run the topology check — it is cheap (no running stack needed).
check_compose_topology

echo "==> Service status:"
docker compose -f "${COMPOSE_FILE}" ps

echo ""
echo "==> Recent logs (last 20 lines per service):"
docker compose -f "${COMPOSE_FILE}" logs --tail=20 mitmproxy gateway workspace

echo ""
echo "==> Checking gateway exit status (last 30s)..."

# Determine if the gateway container exited non-zero in the last 30 seconds.
GATEWAY_STATE=$(docker compose -f "${COMPOSE_FILE}" ps --format json gateway 2>/dev/null || echo "{}")

EXIT_CODE=$(echo "${GATEWAY_STATE}" | \
  python3 -c "
import json, sys
data = sys.stdin.read().strip()
if not data or data == '{}':
    print('unknown')
    sys.exit(0)
# docker compose ps --format json may return a list or single object
try:
    obj = json.loads(data)
    if isinstance(obj, list):
        obj = obj[0] if obj else {}
    code = obj.get('ExitCode', -1)
    state = obj.get('State', '')
    if state == 'exited' and code != 0:
        print(str(code))
    else:
        print('ok')
except Exception as e:
    print('unknown')
" 2>/dev/null || echo "unknown")

if [[ "${EXIT_CODE}" != "ok" && "${EXIT_CODE}" != "unknown" ]]; then
  echo "ERROR: gateway service exited with code ${EXIT_CODE}" >&2
  exit 1
fi

echo "    Gateway state: ${EXIT_CODE}"
echo ""
echo "==> Stack validation passed."
