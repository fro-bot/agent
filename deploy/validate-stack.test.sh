#!/usr/bin/env bash
# validate-stack.test.sh — Topology-guard and persistence-guard negative + positive tests.
#
# Tests that validate-stack.sh --topology-only:
#   (a) EXITS NON-ZERO when workspace is attached to a non-internal network
#       (the regression the topology guard exists to catch).
#   (b) EXITS NON-ZERO when workspace has no workspace-repos volume mounted at
#       /workspace/repos (the regression the persistence guard exists to catch).
#   (c) EXITS NON-ZERO when workspace mounts the wrong volume or wrong target path.
#   (d) EXITS ZERO for the real compose.yaml (positive control).
#   (e) EXITS ZERO for --topology-only when Docker/compose is absent from PATH
#       (raw YAML fallback must handle both dict and short-form volume entries).
#   (f) EXITS NON-ZERO for long-form bind mounts at /workspace/repos.
#   (g) EXITS NON-ZERO for --topology-only without Docker when workspace-repos
#       mount is missing (raw YAML fallback must still catch the invariant).
#   (h) EXITS NON-ZERO when ANY service (not just workspace/mitmproxy) declares
#       network_mode (broadened Invariant 1b scope).
#   (i) EXITS NON-ZERO (fail-closed) when docker is absent and COMPOSE_FILE lists
#       multiple files — raw-YAML shallow-merge cannot reproduce Docker Compose
#       merge semantics and must not silently produce wrong results.
#   (j) When docker IS available, multi-file topology violations are still caught
#       via the authoritative docker compose merge (gated on docker presence).
#   (k) Single-file raw YAML fallback (no docker) is unchanged — still exits zero
#       for a valid single compose file.
#
# Run from repo root:
#   bash deploy/validate-stack.test.sh
set -euo pipefail

PASS=0
FAIL=0
BASH_BIN="$(command -v bash)"
PYTHON3_BIN="$(command -v python3)"

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Crafted insecure compose: workspace is attached to egress-net (non-internal)
# — a direct violation of Invariant 4.
# ---------------------------------------------------------------------------
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_TEST}"' EXIT

INSECURE_COMPOSE="${TMPDIR_TEST}/compose.yaml"
cat > "${INSECURE_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
      - egress-net

networks:
  sandbox-net:
    internal: true
  egress-net: {}
YAML

# ---------------------------------------------------------------------------
# TEST 1 — Negative: insecure compose must be rejected (exit non-zero).
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 1: topology guard rejects workspace-on-non-internal-net ---"

NEGATIVE_OUTPUT=""
NEGATIVE_EXIT=0
NEGATIVE_OUTPUT="$(COMPOSE_FILE="${INSECURE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || NEGATIVE_EXIT=$?

if [[ "${NEGATIVE_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${NEGATIVE_EXIT}) for insecure compose"
else
  fail "validate-stack.sh exited ZERO for insecure compose — guard did NOT fire"
fi

# Confirm the failure message mentions the workspace/egress violation.
if echo "${NEGATIVE_OUTPUT}" | grep -qi "workspace"; then
  pass "failure message mentions 'workspace'"
else
  fail "failure message does not mention 'workspace' — output: ${NEGATIVE_OUTPUT}"
fi

if echo "${NEGATIVE_OUTPUT}" | grep -qi "egress\|non-internal\|direct internet"; then
  pass "failure message mentions egress/non-internal violation"
else
  fail "failure message does not mention egress violation — output: ${NEGATIVE_OUTPUT}"
fi

echo ""
echo "  Negative-test output (stderr+stdout combined):"
echo "${NEGATIVE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 2 — Positive: real compose.yaml must pass (exit zero).
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 2: topology guard accepts the real compose.yaml ---"

POSITIVE_OUTPUT=""
POSITIVE_EXIT=0
POSITIVE_OUTPUT="$(COMPOSE_FILE=deploy/compose.yaml bash deploy/validate-stack.sh --topology-only 2>&1)" || POSITIVE_EXIT=$?

if [[ "${POSITIVE_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for real compose.yaml"
else
  fail "validate-stack.sh exited non-zero (${POSITIVE_EXIT}) for real compose.yaml — output: ${POSITIVE_OUTPUT}"
fi

# ---------------------------------------------------------------------------
# TEST 3 — Negative: compose with workspace-repos volume absent must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 3: persistence guard rejects compose missing workspace-repos volume ---"

NO_REPOS_COMPOSE="${TMPDIR_TEST}/compose-no-repos.yaml"
cat > "${NO_REPOS_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - mitmproxy-certs:/run/mitmproxy-certs:ro

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  mitmproxy-certs:
YAML

NO_REPOS_OUTPUT=""
NO_REPOS_EXIT=0
NO_REPOS_OUTPUT="$(COMPOSE_FILE="${NO_REPOS_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || NO_REPOS_EXIT=$?

if [[ "${NO_REPOS_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${NO_REPOS_EXIT}) for compose missing workspace-repos"
else
  fail "validate-stack.sh exited ZERO for compose missing workspace-repos — guard did NOT fire"
fi

if echo "${NO_REPOS_OUTPUT}" | grep -q "/workspace/repos"; then
  pass "failure message mentions '/workspace/repos'"
else
  fail "failure message does not mention '/workspace/repos' — output: ${NO_REPOS_OUTPUT}"
fi

echo ""
echo "  No-repos-test output (stderr+stdout combined):"
echo "${NO_REPOS_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 4 — Negative: compose mounting wrong volume name at /workspace/repos
#          must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 4: persistence guard rejects compose with wrong volume name at /workspace/repos ---"

WRONG_VOL_COMPOSE="${TMPDIR_TEST}/compose-wrong-vol.yaml"
cat > "${WRONG_VOL_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - mitmproxy-certs:/run/mitmproxy-certs:ro
      - some-other-volume:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  mitmproxy-certs:
  some-other-volume:
YAML

WRONG_VOL_OUTPUT=""
WRONG_VOL_EXIT=0
WRONG_VOL_OUTPUT="$(COMPOSE_FILE="${WRONG_VOL_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || WRONG_VOL_EXIT=$?

if [[ "${WRONG_VOL_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${WRONG_VOL_EXIT}) for compose with wrong volume name"
else
  fail "validate-stack.sh exited ZERO for compose with wrong volume name — guard did NOT fire"
fi

if echo "${WRONG_VOL_OUTPUT}" | grep -q "workspace-repos"; then
  pass "failure message mentions 'workspace-repos'"
else
  fail "failure message does not mention 'workspace-repos' — output: ${WRONG_VOL_OUTPUT}"
fi

echo ""
echo "  Wrong-vol-test output (stderr+stdout combined):"
echo "${WRONG_VOL_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 5 — Negative: compose mounting workspace-repos at wrong target path
#          must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 5: persistence guard rejects compose with workspace-repos at wrong target ---"

WRONG_TARGET_COMPOSE="${TMPDIR_TEST}/compose-wrong-target.yaml"
cat > "${WRONG_TARGET_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - mitmproxy-certs:/run/mitmproxy-certs:ro
      - workspace-repos:/data/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  mitmproxy-certs:
  workspace-repos:
YAML

WRONG_TARGET_OUTPUT=""
WRONG_TARGET_EXIT=0
WRONG_TARGET_OUTPUT="$(COMPOSE_FILE="${WRONG_TARGET_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || WRONG_TARGET_EXIT=$?

if [[ "${WRONG_TARGET_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${WRONG_TARGET_EXIT}) for compose with workspace-repos at wrong target"
else
  fail "validate-stack.sh exited ZERO for compose with workspace-repos at wrong target — guard did NOT fire"
fi

if echo "${WRONG_TARGET_OUTPUT}" | grep -q "/workspace/repos"; then
  pass "failure message mentions '/workspace/repos'"
else
  fail "failure message does not mention '/workspace/repos' — output: ${WRONG_TARGET_OUTPUT}"
fi

echo ""
echo "  Wrong-target-test output (stderr+stdout combined):"
echo "${WRONG_TARGET_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 6 — Positive: compose using raw short-form volume string
#          "workspace-repos:/workspace/repos" must be accepted.
#
# When docker compose is unavailable (e.g. CI without Docker), the script
# falls back to parsing the raw YAML file directly. Raw YAML may contain
# short-form volume strings like "workspace-repos:/workspace/repos[:ro]"
# instead of the normalized dict form. The invariant check must handle both.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 6: persistence guard accepts raw short-form volume string ---"

RAW_SHORTFORM_COMPOSE="${TMPDIR_TEST}/compose-raw-shortform.yaml"
cat > "${RAW_SHORTFORM_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

RAW_SHORTFORM_OUTPUT=""
RAW_SHORTFORM_EXIT=0
RAW_SHORTFORM_OUTPUT="$(COMPOSE_FILE="${RAW_SHORTFORM_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || RAW_SHORTFORM_EXIT=$?

if [[ "${RAW_SHORTFORM_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for compose with raw short-form volume string"
else
  fail "validate-stack.sh exited non-zero (${RAW_SHORTFORM_EXIT}) for raw short-form volume — output: ${RAW_SHORTFORM_OUTPUT}"
fi

echo ""
echo "  Raw-shortform-test output (stderr+stdout combined):"
echo "${RAW_SHORTFORM_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 7 — Negative: raw short-form volume with wrong target must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 7: persistence guard rejects raw short-form volume with wrong target ---"

RAW_WRONG_TARGET_COMPOSE="${TMPDIR_TEST}/compose-raw-wrong-target.yaml"
cat > "${RAW_WRONG_TARGET_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/data/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

RAW_WRONG_TARGET_OUTPUT=""
RAW_WRONG_TARGET_EXIT=0
RAW_WRONG_TARGET_OUTPUT="$(COMPOSE_FILE="${RAW_WRONG_TARGET_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || RAW_WRONG_TARGET_EXIT=$?

if [[ "${RAW_WRONG_TARGET_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${RAW_WRONG_TARGET_EXIT}) for raw short-form volume with wrong target"
else
  fail "validate-stack.sh exited ZERO for raw short-form volume with wrong target — guard did NOT fire"
fi

echo ""
echo "  Raw-wrong-target-test output (stderr+stdout combined):"
echo "${RAW_WRONG_TARGET_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 8 — Negative: long-form bind mount at /workspace/repos must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 8: persistence guard rejects long-form bind mount at /workspace/repos ---"

BIND_REPOS_COMPOSE="${TMPDIR_TEST}/compose-bind-repos.yaml"
cat > "${BIND_REPOS_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - type: bind
        source: ./repos
        target: /workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}
YAML

BIND_REPOS_OUTPUT=""
BIND_REPOS_EXIT=0
BIND_REPOS_OUTPUT="$(COMPOSE_FILE="${BIND_REPOS_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || BIND_REPOS_EXIT=$?

if [[ "${BIND_REPOS_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${BIND_REPOS_EXIT}) for bind mount at /workspace/repos"
else
  fail "validate-stack.sh exited ZERO for bind mount at /workspace/repos — guard DID NOT require named volume"
fi

if echo "${BIND_REPOS_OUTPUT}" | grep -qi "named volume\|workspace-repos"; then
  pass "bind-mount failure message mentions named workspace-repos volume"
else
  fail "bind-mount failure message does not mention named workspace-repos volume — output: ${BIND_REPOS_OUTPUT}"
fi

echo ""
echo "  Bind-repos-test output (stderr+stdout combined):"
echo "${BIND_REPOS_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# Helper: build a PATH that strips Docker and docker-compose binaries so we
# can simulate a no-Docker environment while keeping Python (and other tools)
# available.  We filter out any PATH component that contains a 'docker'
# binary, which covers /usr/local/bin, /usr/bin, and Homebrew prefixes.
# ---------------------------------------------------------------------------
NO_DOCKER_PATH="$(
  echo "$PATH" | tr ':' '\n' | while IFS= read -r dir; do
    if [[ -n "${dir}" ]] && [[ ! -x "${dir}/docker" ]]; then
      echo "${dir}"
    fi
  done | tr '\n' ':' | sed 's/:$//'
)"

# ---------------------------------------------------------------------------
# TEST 9 — Positive (no Docker): --topology-only must succeed via raw YAML
#          fallback when Docker is absent from PATH.
#          Uses a compose file with a short-form volume entry to exercise the
#          short-form string parsing path in the invariant check.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 9: --topology-only succeeds via raw YAML fallback (no Docker in PATH) ---"

NO_DOCKER_SHORTFORM_COMPOSE="${TMPDIR_TEST}/compose-no-docker-shortform.yaml"
cat > "${NO_DOCKER_SHORTFORM_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

NO_DOCKER_OUTPUT=""
NO_DOCKER_EXIT=0
NO_DOCKER_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${NO_DOCKER_SHORTFORM_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || NO_DOCKER_EXIT=$?

if [[ "${NO_DOCKER_EXIT}" -eq 0 ]]; then
  pass "--topology-only exited zero via raw YAML fallback (no Docker in PATH)"
else
  fail "--topology-only exited non-zero (${NO_DOCKER_EXIT}) via raw YAML fallback — output: ${NO_DOCKER_OUTPUT}"
fi

if echo "${NO_DOCKER_OUTPUT}" | grep -q "workspace-repos"; then
  pass "raw YAML fallback output confirms workspace-repos mount"
else
  fail "raw YAML fallback output does not confirm workspace-repos mount — output: ${NO_DOCKER_OUTPUT}"
fi

echo ""
echo "  No-Docker-shortform-test output (stderr+stdout combined):"
echo "${NO_DOCKER_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 10 — Negative (no Docker): --topology-only must FAIL via raw YAML
#          fallback when workspace-repos mount is missing.
#          Proves the invariant check still fires without Docker.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 10: --topology-only rejects missing workspace-repos via raw YAML fallback (no Docker in PATH) ---"

NO_DOCKER_NO_REPOS_COMPOSE="${TMPDIR_TEST}/compose-no-docker-no-repos.yaml"
cat > "${NO_DOCKER_NO_REPOS_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - mitmproxy-certs:/run/mitmproxy-certs:ro

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  mitmproxy-certs:
YAML

NO_DOCKER_NO_REPOS_OUTPUT=""
NO_DOCKER_NO_REPOS_EXIT=0
NO_DOCKER_NO_REPOS_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${NO_DOCKER_NO_REPOS_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || NO_DOCKER_NO_REPOS_EXIT=$?

if [[ "${NO_DOCKER_NO_REPOS_EXIT}" -ne 0 ]]; then
  pass "--topology-only exited non-zero (${NO_DOCKER_NO_REPOS_EXIT}) for missing workspace-repos via raw YAML fallback"
else
  fail "--topology-only exited ZERO for missing workspace-repos via raw YAML fallback — guard did NOT fire"
fi

if echo "${NO_DOCKER_NO_REPOS_OUTPUT}" | grep -q "/workspace/repos"; then
  pass "raw YAML fallback failure message mentions '/workspace/repos'"
else
  fail "raw YAML fallback failure message does not mention '/workspace/repos' — output: ${NO_DOCKER_NO_REPOS_OUTPUT}"
fi

echo ""
echo "  No-Docker-no-repos-test output (stderr+stdout combined):"
echo "${NO_DOCKER_NO_REPOS_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 11 — Negative (no Docker): --topology-only must FAIL via raw YAML
#           fallback when workspace is on a non-internal network.
#           Proves topology invariant 4 still fires without Docker.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 11: --topology-only rejects workspace-on-egress-net via raw YAML fallback (no Docker in PATH) ---"

NO_DOCKER_INSECURE_COMPOSE="${TMPDIR_TEST}/compose-no-docker-insecure.yaml"
cat > "${NO_DOCKER_INSECURE_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
      - egress-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

NO_DOCKER_INSECURE_OUTPUT=""
NO_DOCKER_INSECURE_EXIT=0
NO_DOCKER_INSECURE_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${NO_DOCKER_INSECURE_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || NO_DOCKER_INSECURE_EXIT=$?

if [[ "${NO_DOCKER_INSECURE_EXIT}" -ne 0 ]]; then
  pass "--topology-only exited non-zero (${NO_DOCKER_INSECURE_EXIT}) for workspace-on-egress-net via raw YAML fallback"
else
  fail "--topology-only exited ZERO for workspace-on-egress-net via raw YAML fallback — guard did NOT fire"
fi

if echo "${NO_DOCKER_INSECURE_OUTPUT}" | grep -qi "egress\|non-internal\|direct internet"; then
  pass "raw YAML fallback failure message mentions egress/non-internal violation"
else
  fail "raw YAML fallback failure message does not mention egress violation — output: ${NO_DOCKER_INSECURE_OUTPUT}"
fi

echo ""
echo "  No-Docker-insecure-test output (stderr+stdout combined):"
echo "${NO_DOCKER_INSECURE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 12 — Negative: network_mode:host on workspace must be rejected.
#
# An override can set network_mode: host on workspace, giving it full host
# networking.  Because network_mode replaces the 'networks' key entirely,
# the existing network-attachment invariants would pass vacuously.  The new
# Invariant 1b must catch this regardless of the docker/no-docker path.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 12: topology guard rejects workspace with network_mode:host ---"

NM_WORKSPACE_COMPOSE="${TMPDIR_TEST}/compose-nm-workspace.yaml"
cat > "${NM_WORKSPACE_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    network_mode: host
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

NM_WORKSPACE_OUTPUT=""
NM_WORKSPACE_EXIT=0
NM_WORKSPACE_OUTPUT="$(COMPOSE_FILE="${NM_WORKSPACE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || NM_WORKSPACE_EXIT=$?

if [[ "${NM_WORKSPACE_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${NM_WORKSPACE_EXIT}) for workspace with network_mode:host"
else
  fail "validate-stack.sh exited ZERO for workspace with network_mode:host — guard did NOT fire"
fi

if echo "${NM_WORKSPACE_OUTPUT}" | grep -qi "network_mode"; then
  pass "failure message mentions 'network_mode'"
else
  fail "failure message does not mention 'network_mode' — output: ${NM_WORKSPACE_OUTPUT}"
fi

# Blocking fix: network_mode services must NOT produce misleading secondary
# attachment failures — exactly ONE failure line (the 1b network_mode FAIL).
if echo "${NM_WORKSPACE_OUTPUT}" | grep -q "must be attached to exactly"; then
  fail "workspace network_mode test: spurious Invariant 2 message 'must be attached to exactly' present — secondary failure not suppressed"
else
  pass "workspace network_mode test: no spurious 'must be attached to exactly' message (Invariant 2 correctly skipped)"
fi

echo ""
echo "  network_mode-workspace-test output (stderr+stdout combined):"
echo "${NM_WORKSPACE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 13 — Negative: network_mode:host on mitmproxy must be rejected.
#
# Same bypass vector as TEST 12 but targeting mitmproxy.  An operator could
# set network_mode: host on mitmproxy to give it unrestricted host networking,
# which also breaks the containment model.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 13: topology guard rejects mitmproxy with network_mode:host ---"

NM_MITM_COMPOSE="${TMPDIR_TEST}/compose-nm-mitm.yaml"
cat > "${NM_MITM_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    network_mode: host
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

NM_MITM_OUTPUT=""
NM_MITM_EXIT=0
NM_MITM_OUTPUT="$(COMPOSE_FILE="${NM_MITM_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || NM_MITM_EXIT=$?

if [[ "${NM_MITM_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${NM_MITM_EXIT}) for mitmproxy with network_mode:host"
else
  fail "validate-stack.sh exited ZERO for mitmproxy with network_mode:host — guard did NOT fire"
fi

if echo "${NM_MITM_OUTPUT}" | grep -qi "network_mode"; then
  pass "failure message mentions 'network_mode'"
else
  fail "failure message does not mention 'network_mode' — output: ${NM_MITM_OUTPUT}"
fi

# Blocking fix: network_mode services must NOT produce misleading secondary
# attachment failures — exactly ONE failure line (the 1b network_mode FAIL).
if echo "${NM_MITM_OUTPUT}" | grep -q "is not attached to sandbox-net"; then
  fail "mitmproxy network_mode test: spurious Invariant 3 message 'is not attached to sandbox-net' present — secondary failure not suppressed"
else
  pass "mitmproxy network_mode test: no spurious 'is not attached to sandbox-net' message (Invariant 3 correctly skipped)"
fi

echo ""
echo "  network_mode-mitmproxy-test output (stderr+stdout combined):"
echo "${NM_MITM_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 14 — Negative: network_mode:host on a non-workspace/mitmproxy service
#           (e.g. a sidecar) must be rejected.
#
# Proves the broadened Invariant 1b scope: ANY service with network_mode is
# rejected, not just workspace and mitmproxy.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 14: topology guard rejects sidecar service with network_mode:host ---"

NM_SIDECAR_COMPOSE="${TMPDIR_TEST}/compose-nm-sidecar.yaml"
cat > "${NM_SIDECAR_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos
  sidecar:
    image: ubuntu:22.04
    network_mode: host

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

NM_SIDECAR_OUTPUT=""
NM_SIDECAR_EXIT=0
NM_SIDECAR_OUTPUT="$(COMPOSE_FILE="${NM_SIDECAR_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || NM_SIDECAR_EXIT=$?

if [[ "${NM_SIDECAR_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${NM_SIDECAR_EXIT}) for sidecar with network_mode:host"
else
  fail "validate-stack.sh exited ZERO for sidecar with network_mode:host — broadened guard did NOT fire"
fi

if echo "${NM_SIDECAR_OUTPUT}" | grep -qi "network_mode"; then
  pass "failure message mentions 'network_mode' for sidecar service"
else
  fail "failure message does not mention 'network_mode' — output: ${NM_SIDECAR_OUTPUT}"
fi

echo ""
echo "  network_mode-sidecar-test output (stderr+stdout combined):"
echo "${NM_SIDECAR_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 18 — Negative: network_mode:service:<x> on a service must be rejected.
#
# Confirms the guard is value-agnostic: any truthy network_mode string is
# rejected, not just "host".
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 18: topology guard rejects service with network_mode:service:mitmproxy ---"

NM_SERVICE_COMPOSE="${TMPDIR_TEST}/compose-nm-service.yaml"
cat > "${NM_SERVICE_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    network_mode: "service:mitmproxy"
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

NM_SERVICE_OUTPUT=""
NM_SERVICE_EXIT=0
NM_SERVICE_OUTPUT="$(COMPOSE_FILE="${NM_SERVICE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || NM_SERVICE_EXIT=$?

if [[ "${NM_SERVICE_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${NM_SERVICE_EXIT}) for network_mode:service:mitmproxy"
else
  fail "validate-stack.sh exited ZERO for network_mode:service:mitmproxy — guard did NOT fire"
fi

if echo "${NM_SERVICE_OUTPUT}" | grep -qi "network_mode"; then
  pass "failure message mentions 'network_mode' for service:<x> value"
else
  fail "failure message does not mention 'network_mode' — output: ${NM_SERVICE_OUTPUT}"
fi

echo ""
echo "  network_mode-service-test output (stderr+stdout combined):"
echo "${NM_SERVICE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 19 — Negative: network_mode:container:<x> on a service must be rejected.
#
# Confirms the guard is value-agnostic for the container:<x> form as well.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 19: topology guard rejects service with network_mode:container:foo ---"

NM_CONTAINER_COMPOSE="${TMPDIR_TEST}/compose-nm-container.yaml"
cat > "${NM_CONTAINER_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    network_mode: "container:foo"
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

NM_CONTAINER_OUTPUT=""
NM_CONTAINER_EXIT=0
NM_CONTAINER_OUTPUT="$(COMPOSE_FILE="${NM_CONTAINER_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || NM_CONTAINER_EXIT=$?

if [[ "${NM_CONTAINER_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${NM_CONTAINER_EXIT}) for network_mode:container:foo"
else
  fail "validate-stack.sh exited ZERO for network_mode:container:foo — guard did NOT fire"
fi

if echo "${NM_CONTAINER_OUTPUT}" | grep -qi "network_mode"; then
  pass "failure message mentions 'network_mode' for container:<x> value"
else
  fail "failure message does not mention 'network_mode' — output: ${NM_CONTAINER_OUTPUT}"
fi

echo ""
echo "  network_mode-container-test output (stderr+stdout combined):"
echo "${NM_CONTAINER_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# Shared fixture for multi-file tests (base compose with valid topology).
# ---------------------------------------------------------------------------
MULTI_BASE_COMPOSE="${TMPDIR_TEST}/compose-multi-base.yaml"
cat > "${MULTI_BASE_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

# ---------------------------------------------------------------------------
# TEST 15 — Negative (multi-file, docker-present): override attaches workspace
#           to egress-net → must be rejected via docker compose real merge.
#
# When docker compose is available it performs the authoritative merge and the
# guard must catch the topology violation in the merged result.
# Skipped with a clear message when docker is absent from PATH.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 15: multi-file (docker-present) — override attaches workspace to egress-net (must be rejected) ---"

MULTI_OVERRIDE_COMPOSE="${TMPDIR_TEST}/compose-multi-override.yaml"
cat > "${MULTI_OVERRIDE_COMPOSE}" <<'YAML'
services:
  workspace:
    networks:
      - sandbox-net
      - egress-net
    volumes:
      - workspace-repos:/workspace/repos
YAML

if command -v docker &>/dev/null; then
  MULTI_OUTPUT=""
  MULTI_EXIT=0
  MULTI_OUTPUT="$(COMPOSE_FILE="${MULTI_BASE_COMPOSE}:${MULTI_OVERRIDE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || MULTI_EXIT=$?

  if [[ "${MULTI_EXIT}" -ne 0 ]]; then
    pass "multi-file (docker): validate-stack.sh exited non-zero (${MULTI_EXIT}) for override attaching workspace to egress-net"
  else
    fail "multi-file (docker): validate-stack.sh exited ZERO — merged topology violation was NOT caught"
  fi

  if echo "${MULTI_OUTPUT}" | grep -qi "egress\|non-internal\|direct internet"; then
    pass "multi-file (docker): failure message mentions egress/non-internal violation"
  else
    fail "multi-file (docker): failure message does not mention egress violation — output: ${MULTI_OUTPUT}"
  fi

  echo ""
  echo "  multi-file-docker-test output (stderr+stdout combined):"
  echo "${MULTI_OUTPUT}" | sed 's/^/    /'
else
  echo "  SKIP: multi-file (docker): docker not in PATH — docker-present multi-file test requires docker compose"
fi

# ---------------------------------------------------------------------------
# TEST 16 — Negative (multi-file, docker-absent): fail-closed when docker is
#           unavailable and COMPOSE_FILE lists multiple files.
#
# The raw-YAML fallback cannot faithfully reproduce Docker Compose merge
# semantics (shallow dict-update replaces whole service dicts, producing
# false failures on valid partial overrides).  The guard must exit non-zero
# with a clear error message mentioning "multiple files" and
# "docker compose is unavailable".
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 16: multi-file (no docker) — fail-closed with clear error message ---"

MULTI_NODOCK_OUTPUT=""
MULTI_NODOCK_EXIT=0
MULTI_NODOCK_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${MULTI_BASE_COMPOSE}:${MULTI_OVERRIDE_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || MULTI_NODOCK_EXIT=$?

if [[ "${MULTI_NODOCK_EXIT}" -ne 0 ]]; then
  pass "multi-file (no docker): validate-stack.sh exited non-zero (${MULTI_NODOCK_EXIT}) — fail-closed as expected"
else
  fail "multi-file (no docker): validate-stack.sh exited ZERO — should have failed closed"
fi

if echo "${MULTI_NODOCK_OUTPUT}" | grep -qi "multiple files\|docker compose is unavailable"; then
  pass "multi-file (no docker): error message mentions 'multiple files' / 'docker compose is unavailable'"
else
  fail "multi-file (no docker): error message missing expected text — output: ${MULTI_NODOCK_OUTPUT}"
fi

echo ""
echo "  multi-file-no-docker-test output (stderr+stdout combined):"
echo "${MULTI_NODOCK_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 17 — Positive (single-file, no docker): single-file raw YAML fallback
#           must still succeed for a valid compose file when docker is absent.
#
# Confirms the single-file path is byte-for-byte unchanged by the fail-closed
# multi-file change.  Uses the real deploy/compose.yaml as the positive control.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 17: single-file (no docker) — raw YAML fallback still exits zero for real compose.yaml ---"

SINGLE_NODOCK_OUTPUT=""
SINGLE_NODOCK_EXIT=0
SINGLE_NODOCK_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="deploy/compose.yaml" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || SINGLE_NODOCK_EXIT=$?

if [[ "${SINGLE_NODOCK_EXIT}" -eq 0 ]]; then
  pass "single-file (no docker): validate-stack.sh exited zero for real compose.yaml via raw YAML fallback"
else
  fail "single-file (no docker): validate-stack.sh exited non-zero (${SINGLE_NODOCK_EXIT}) — output: ${SINGLE_NODOCK_OUTPUT}"
fi

echo ""
echo "  single-file-no-docker-test output (stderr+stdout combined):"
echo "${SINGLE_NODOCK_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 20 — Negative: sidecar attached to [sandbox-net, shadow-egress]
#           must be rejected by the global non-internal-attachment invariant.
#
# This is the core #814 bypass class: a service bridges sandbox-net to a
# non-internal network that mitmproxy is NOT on.  The old per-mitmproxy-net
# loop would miss this; the new global allowlist must catch it.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 20: global invariant rejects sidecar on [sandbox-net, shadow-egress] ---"

SHADOW_EGRESS_COMPOSE="${TMPDIR_TEST}/compose-shadow-egress.yaml"
cat > "${SHADOW_EGRESS_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos
  leakproxy:
    image: ubuntu:22.04
    networks:
      - sandbox-net
      - shadow-egress

networks:
  sandbox-net:
    internal: true
  egress-net: {}
  shadow-egress: {}

volumes:
  workspace-repos:
YAML

SHADOW_EGRESS_OUTPUT=""
SHADOW_EGRESS_EXIT=0
SHADOW_EGRESS_OUTPUT="$(COMPOSE_FILE="${SHADOW_EGRESS_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SHADOW_EGRESS_EXIT=$?

if [[ "${SHADOW_EGRESS_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${SHADOW_EGRESS_EXIT}) for sidecar on shadow-egress"
else
  fail "validate-stack.sh exited ZERO for sidecar on shadow-egress — global invariant did NOT fire"
fi

if echo "${SHADOW_EGRESS_OUTPUT}" | grep -q "leakproxy"; then
  pass "failure message names the offending service 'leakproxy'"
else
  fail "failure message does not name 'leakproxy' — output: ${SHADOW_EGRESS_OUTPUT}"
fi

if echo "${SHADOW_EGRESS_OUTPUT}" | grep -q "shadow-egress"; then
  pass "failure message names the offending network 'shadow-egress'"
else
  fail "failure message does not name 'shadow-egress' — output: ${SHADOW_EGRESS_OUTPUT}"
fi

echo ""
echo "  shadow-egress-test output (stderr+stdout combined):"
echo "${SHADOW_EGRESS_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 21 — Negative: sidecar attached to [sandbox-net, gateway-net]
#           must be rejected — only gateway may join gateway-net.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 21: global invariant rejects sidecar on [sandbox-net, gateway-net] ---"

GATEWAY_NET_SIDECAR_COMPOSE="${TMPDIR_TEST}/compose-gateway-net-sidecar.yaml"
cat > "${GATEWAY_NET_SIDECAR_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  gateway:
    image: ubuntu:22.04
    networks:
      - gateway-net
      - sandbox-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos
  sidecar:
    image: ubuntu:22.04
    networks:
      - sandbox-net
      - gateway-net

networks:
  sandbox-net:
    internal: true
  egress-net: {}
  gateway-net: {}

volumes:
  workspace-repos:
YAML

GATEWAY_NET_SIDECAR_OUTPUT=""
GATEWAY_NET_SIDECAR_EXIT=0
GATEWAY_NET_SIDECAR_OUTPUT="$(COMPOSE_FILE="${GATEWAY_NET_SIDECAR_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || GATEWAY_NET_SIDECAR_EXIT=$?

if [[ "${GATEWAY_NET_SIDECAR_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${GATEWAY_NET_SIDECAR_EXIT}) for sidecar on gateway-net"
else
  fail "validate-stack.sh exited ZERO for sidecar on gateway-net — global invariant did NOT fire"
fi

if echo "${GATEWAY_NET_SIDECAR_OUTPUT}" | grep -q "sidecar"; then
  pass "failure message names the offending service 'sidecar'"
else
  fail "failure message does not name 'sidecar' — output: ${GATEWAY_NET_SIDECAR_OUTPUT}"
fi

if echo "${GATEWAY_NET_SIDECAR_OUTPUT}" | grep -q "gateway-net"; then
  pass "failure message names the offending network 'gateway-net'"
else
  fail "failure message does not name 'gateway-net' — output: ${GATEWAY_NET_SIDECAR_OUTPUT}"
fi

echo ""
echo "  gateway-net-sidecar-test output (stderr+stdout combined):"
echo "${GATEWAY_NET_SIDECAR_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 22 — Negative: shadow-egress declared with no service attached
#           must be rejected by the drift check (raw-YAML path).
#
# The drift check fails any declared non-internal network not in
# {egress-net, gateway-net}, even if no service has joined it yet.
# This prevents the hole from being introduced by declaration alone.
#
# NOTE: `docker compose config` drops unused networks from its normalized
# output, so the drift check for declared-but-unused networks only fires
# via the raw-YAML fallback (no docker in PATH).  This test strips docker
# from PATH to exercise that path.  When a service IS attached to the
# unknown network, docker compose config keeps it and the drift check fires
# in both paths (see TEST 20 which also triggers the drift check message).
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 22: drift check rejects shadow-egress declared with no service (raw-YAML path, no docker) ---"

DRIFT_COMPOSE="${TMPDIR_TEST}/compose-drift.yaml"
cat > "${DRIFT_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}
  shadow-egress: {}

volumes:
  workspace-repos:
YAML

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
  DRIFT_OUTPUT=""
  DRIFT_EXIT=0
  DRIFT_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${DRIFT_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || DRIFT_EXIT=$?

  if [[ "${DRIFT_EXIT}" -ne 0 ]]; then
    pass "drift check exited non-zero (${DRIFT_EXIT}) for shadow-egress declared with no service (raw-YAML path)"
  else
    fail "drift check exited ZERO for shadow-egress declared with no service (raw-YAML path) — drift check did NOT fire"
  fi

  if echo "${DRIFT_OUTPUT}" | grep -q "shadow-egress"; then
    pass "drift-check failure message names 'shadow-egress'"
  else
    fail "drift-check failure message does not name 'shadow-egress' — output: ${DRIFT_OUTPUT}"
  fi

  if echo "${DRIFT_OUTPUT}" | grep -qi "unknown non-internal\|only egress-net"; then
    pass "drift-check failure message indicates unknown non-internal network"
  else
    fail "drift-check failure message missing expected text — output: ${DRIFT_OUTPUT}"
  fi

  echo ""
  echo "  drift-check-test output (stderr+stdout combined):"
  echo "${DRIFT_OUTPUT}" | sed 's/^/    /'
else
  echo "  SKIP: drift check (raw-YAML path): PyYAML not available — install python3-yaml/PyYAML to run this test."
  echo "        (docker compose config drops unused networks, so the raw-YAML path is required for this case)"
fi

# ---------------------------------------------------------------------------
# TEST 23 — Positive: mitmproxy→egress-net + gateway→gateway-net only
#           (the exact allowlisted pairs) must pass.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 23: global invariant accepts allowlisted pairs mitmproxy→egress-net + gateway→gateway-net ---"

ALLOWLIST_COMPOSE="${TMPDIR_TEST}/compose-allowlist.yaml"
cat > "${ALLOWLIST_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  gateway:
    image: ubuntu:22.04
    networks:
      - gateway-net
      - sandbox-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}
  gateway-net: {}

volumes:
  workspace-repos:
YAML

ALLOWLIST_OUTPUT=""
ALLOWLIST_EXIT=0
ALLOWLIST_OUTPUT="$(COMPOSE_FILE="${ALLOWLIST_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || ALLOWLIST_EXIT=$?

if [[ "${ALLOWLIST_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for allowlisted pairs mitmproxy→egress-net + gateway→gateway-net"
else
  fail "validate-stack.sh exited non-zero (${ALLOWLIST_EXIT}) for allowlisted pairs — output: ${ALLOWLIST_OUTPUT}"
fi

if echo "${ALLOWLIST_OUTPUT}" | grep -q "allowlisted pairs"; then
  pass "output confirms allowlisted pairs check passed"
else
  fail "output does not confirm allowlisted pairs check — output: ${ALLOWLIST_OUTPUT}"
fi

echo ""
echo "  allowlist-pairs-test output (stderr+stdout combined):"
echo "${ALLOWLIST_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 24 — Multi-file override (#814 literal repro): base compose + override
#           that adds a leakproxy sidecar on [sandbox-net, shadow-egress].
#
# This is the exact bypass class from issue #814: the override introduces a
# service on a non-internal network that mitmproxy is NOT on.  The old guard
# would miss it; the new global allowlist must catch it via docker compose
# merge semantics.
#
# REQUIRES docker compose for authoritative multi-file merge.  The raw-YAML
# fallback fail-closes on multi-file input (see TEST 16), so this test MUST
# run through real docker compose config.  Hard-skip with a visible notice
# when docker is absent — do NOT let it silently pass via the raw-YAML path.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 24: multi-file override (#814 repro) — leakproxy sidecar on shadow-egress (docker-gated) ---"

MULTI814_BASE_COMPOSE="${TMPDIR_TEST}/compose-814-base.yaml"
cat > "${MULTI814_BASE_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

MULTI814_OVERRIDE_COMPOSE="${TMPDIR_TEST}/compose-814-override.yaml"
cat > "${MULTI814_OVERRIDE_COMPOSE}" <<'YAML'
services:
  leakproxy:
    image: ubuntu:22.04
    networks:
      - sandbox-net
      - shadow-egress

networks:
  shadow-egress: {}
YAML

if command -v docker &>/dev/null; then
  MULTI814_OUTPUT=""
  MULTI814_EXIT=0
  MULTI814_OUTPUT="$(COMPOSE_FILE="${MULTI814_BASE_COMPOSE}:${MULTI814_OVERRIDE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || MULTI814_EXIT=$?

  if [[ "${MULTI814_EXIT}" -ne 0 ]]; then
    pass "multi-file #814 repro: validate-stack.sh exited non-zero (${MULTI814_EXIT}) — leakproxy/shadow-egress bypass caught"
  else
    fail "multi-file #814 repro: validate-stack.sh exited ZERO — override-merged topology violation was NOT caught"
  fi

  if echo "${MULTI814_OUTPUT}" | grep -q "leakproxy"; then
    pass "multi-file #814 repro: failure message names 'leakproxy'"
  else
    fail "multi-file #814 repro: failure message does not name 'leakproxy' — output: ${MULTI814_OUTPUT}"
  fi

  if echo "${MULTI814_OUTPUT}" | grep -q "shadow-egress"; then
    pass "multi-file #814 repro: failure message names 'shadow-egress'"
  else
    fail "multi-file #814 repro: failure message does not name 'shadow-egress' — output: ${MULTI814_OUTPUT}"
  fi

  echo ""
  echo "  multi-file-814-repro output (stderr+stdout combined):"
  echo "${MULTI814_OUTPUT}" | sed 's/^/    /'
else
  echo "  SKIP: multi-file #814 repro: docker not in PATH — this test requires docker compose for authoritative"
  echo "        multi-file merge semantics; raw-YAML fallback fail-closes on multi-file input (see TEST 16)."
  echo "        Install docker compose to run this test."
fi

# ---------------------------------------------------------------------------
# TEST 25 — Negative: gateway attached to [sandbox-net, egress-net] must be
#           rejected — the allowlist binds the PAIR (service, network), not
#           just the network.  gateway is only allowed on gateway-net; attaching
#           it to egress-net is a violation even though egress-net itself is
#           allowlisted for mitmproxy.
#
#           This proves the guard checks the (service, network) pair, not just
#           the network name.  The failure message must name BOTH 'gateway' and
#           'egress-net' to confirm the pair binding is enforced.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 25: guard rejects gateway attached to [sandbox-net, egress-net] (wrong pair) ---"

GW_EGRESS_COMPOSE="${TMPDIR_TEST}/compose-gw-egress.yaml"
cat > "${GW_EGRESS_COMPOSE}" <<'YAML'
services:
  mitmproxy:
    image: mitmproxy/mitmproxy:latest
    networks:
      - sandbox-net
      - egress-net
  gateway:
    image: ubuntu:22.04
    networks:
      - sandbox-net
      - egress-net
  workspace:
    image: ubuntu:22.04
    networks:
      - sandbox-net
    volumes:
      - workspace-repos:/workspace/repos

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

GW_EGRESS_OUTPUT=""
GW_EGRESS_EXIT=0
GW_EGRESS_OUTPUT="$(COMPOSE_FILE="${GW_EGRESS_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || GW_EGRESS_EXIT=$?

if [[ "${GW_EGRESS_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${GW_EGRESS_EXIT}) for gateway attached to egress-net"
else
  fail "validate-stack.sh exited ZERO for gateway on egress-net — pair-binding guard did NOT fire"
fi

# The failure message must name BOTH 'gateway' AND 'egress-net' to prove the
# allowlist binds the pair, not just the network.
if echo "${GW_EGRESS_OUTPUT}" | grep -q "gateway"; then
  pass "failure message names 'gateway'"
else
  fail "failure message does not name 'gateway' — output: ${GW_EGRESS_OUTPUT}"
fi

if echo "${GW_EGRESS_OUTPUT}" | grep -q "egress-net"; then
  pass "failure message names 'egress-net'"
else
  fail "failure message does not name 'egress-net' — output: ${GW_EGRESS_OUTPUT}"
fi

echo ""
echo "  gateway-egress-net-test output (stderr+stdout combined):"
echo "${GW_EGRESS_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "========================================"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
