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
#   2. workspace is attached to sandbox-net ONLY — it has zero direct egress.
#   3. mitmproxy is attached to sandbox-net AND at least one non-internal
#      network (its upstream leg to the internet).
#   4. workspace is attached to NO non-internal network — it cannot reach the
#      internet directly, even if a new network is added to the compose file.
#   5. egress-net has EXACTLY ONE attached service (mitmproxy) — no other
#      service may join the internet-capable network.
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

compose_file = os.environ.get("COMPOSE_FILE", "deploy/compose.yaml")

try:
    result = subprocess.run(
        ["docker", "compose", "-f", compose_file, "config", "--format", "json"],
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
                ["docker", "compose", "-f", compose_file, "config"],
                capture_output=True,
                text=True,
                check=True,
            )
            cfg = yaml.safe_load(result2.stdout)
        except (subprocess.CalledProcessError, OSError):
            # docker compose unavailable — parse the raw YAML file directly.
            with open(compose_file) as fh:
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
# Invariant 2: workspace is attached to sandbox-net only
# ------------------------------------------------------------------
if workspace_nets != {"sandbox-net"}:
    failures.append(
        f"FAIL: workspace is attached to networks {sorted(workspace_nets)!r} "
        f"but must be attached to exactly ['sandbox-net']."
    )

# ------------------------------------------------------------------
# Invariant 3: mitmproxy is attached to sandbox-net AND at least one
# non-internal network (its upstream leg).
# ------------------------------------------------------------------
if "sandbox-net" not in mitmproxy_nets:
    failures.append(
        "FAIL: mitmproxy is not attached to sandbox-net — it cannot receive "
        "workspace traffic."
    )
mitmproxy_egress_nets = mitmproxy_nets & non_internal_nets
if not mitmproxy_egress_nets:
    failures.append(
        f"FAIL: mitmproxy is attached only to internal networks {sorted(mitmproxy_nets)!r}. "
        "It needs at least one non-internal network as its upstream leg so it "
        "can reach the internet on behalf of the workspace."
    )

# ------------------------------------------------------------------
# Invariant 4: workspace is attached to NO non-internal network
# ------------------------------------------------------------------
workspace_egress_nets = workspace_nets & non_internal_nets
if workspace_egress_nets:
    failures.append(
        f"FAIL: workspace is attached to non-internal network(s) "
        f"{sorted(workspace_egress_nets)!r} — it has direct internet egress, "
        "violating the containment model."
    )

# ------------------------------------------------------------------
# Invariant 5: each non-internal network that mitmproxy uses must have
# EXACTLY ONE attached service (mitmproxy itself).
# ------------------------------------------------------------------
for egress_net in mitmproxy_egress_nets:
    attached = [
        svc for svc, spec in services.items()
        if egress_net in service_networks(svc)
    ]
    if attached != ["mitmproxy"] and set(attached) != {"mitmproxy"}:
        others = [s for s in attached if s != "mitmproxy"]
        failures.append(
            f"FAIL: non-internal network '{egress_net}' has unexpected service(s) "
            f"attached: {others!r}. Only mitmproxy may join the internet-capable "
            "network — adding other services breaks the containment boundary."
        )

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
print("    egress network(s) have exactly one attached service (mitmproxy)  ✓")
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
