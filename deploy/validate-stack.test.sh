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

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
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
else
  echo "  SKIP: TEST 9 (raw YAML fallback, no Docker): PyYAML not available — install python3-yaml/PyYAML to run this test."
fi

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

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
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
else
  echo "  SKIP: TEST 10 (raw YAML fallback, no Docker): PyYAML not available — install python3-yaml/PyYAML to run this test."
fi

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

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
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
else
  echo "  SKIP: TEST 11 (raw YAML fallback, no Docker): PyYAML not available — install python3-yaml/PyYAML to run this test."
fi

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

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
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
else
  echo "  SKIP: TEST 16 (multi-file, no docker): PyYAML not available — install python3-yaml/PyYAML to run this test."
fi

# ---------------------------------------------------------------------------
# TEST 17 — Positive (single-file, no docker): single-file raw YAML fallback
#           must still succeed for a valid compose file when docker is absent.
#
# Confirms the single-file path is byte-for-byte unchanged by the fail-closed
# multi-file change.  Uses the real deploy/compose.yaml as the positive control.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 17: single-file (no docker) — raw YAML fallback still exits zero for real compose.yaml ---"

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
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
else
  echo "  SKIP: TEST 17 (single-file, no docker): PyYAML not available — install python3-yaml/PyYAML to run this test."
fi

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
# TEST 26 — Negative: extra_hosts with host-gateway must be rejected.
#
# extra_hosts: ["proxy.local:host-gateway"] gives the container the Docker
# host's bridge IP.  If the host runs any forward proxy/SOCKS/tunnel bound
# to 0.0.0.0, the workspace can relay egress around mitmproxy.
# The failure message must name the service and mention 'host-gateway'.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 26: guard rejects extra_hosts with host-gateway mapping ---"

EXTRA_HOSTS_HG_COMPOSE="${TMPDIR_TEST}/compose-extra-hosts-hg.yaml"
cat > "${EXTRA_HOSTS_HG_COMPOSE}" <<'YAML'
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
    extra_hosts:
      - "proxy.local:host-gateway"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

EXTRA_HOSTS_HG_OUTPUT=""
EXTRA_HOSTS_HG_EXIT=0
EXTRA_HOSTS_HG_OUTPUT="$(COMPOSE_FILE="${EXTRA_HOSTS_HG_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || EXTRA_HOSTS_HG_EXIT=$?

if [[ "${EXTRA_HOSTS_HG_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${EXTRA_HOSTS_HG_EXIT}) for extra_hosts host-gateway"
else
  fail "validate-stack.sh exited ZERO for extra_hosts host-gateway — guard did NOT fire"
fi

if echo "${EXTRA_HOSTS_HG_OUTPUT}" | grep -q "workspace"; then
  pass "extra_hosts host-gateway failure message names the service 'workspace'"
else
  fail "extra_hosts host-gateway failure message does not name 'workspace' — output: ${EXTRA_HOSTS_HG_OUTPUT}"
fi

if echo "${EXTRA_HOSTS_HG_OUTPUT}" | grep -q "host-gateway"; then
  pass "extra_hosts host-gateway failure message mentions 'host-gateway'"
else
  fail "extra_hosts host-gateway failure message does not mention 'host-gateway' — output: ${EXTRA_HOSTS_HG_OUTPUT}"
fi

echo ""
echo "  extra-hosts-hg-test output (stderr+stdout combined):"
echo "${EXTRA_HOSTS_HG_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 27 — Negative: cap_add with NET_ADMIN must be rejected.
#
# NET_ADMIN enables routing-table and network-interface manipulation.
# Combined with /dev/net/tun and a VPN client image, it can build a tunnel
# that bypasses mitmproxy.  The failure message must name the service and
# mention 'NET_ADMIN'.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 27: guard rejects cap_add NET_ADMIN ---"

CAP_ADD_NET_ADMIN_COMPOSE="${TMPDIR_TEST}/compose-cap-add-net-admin.yaml"
cat > "${CAP_ADD_NET_ADMIN_COMPOSE}" <<'YAML'
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
    cap_add:
      - NET_ADMIN

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_ADD_NET_ADMIN_OUTPUT=""
CAP_ADD_NET_ADMIN_EXIT=0
CAP_ADD_NET_ADMIN_OUTPUT="$(COMPOSE_FILE="${CAP_ADD_NET_ADMIN_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_ADD_NET_ADMIN_EXIT=$?

if [[ "${CAP_ADD_NET_ADMIN_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_ADD_NET_ADMIN_EXIT}) for cap_add NET_ADMIN"
else
  fail "validate-stack.sh exited ZERO for cap_add NET_ADMIN — guard did NOT fire"
fi

if echo "${CAP_ADD_NET_ADMIN_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add NET_ADMIN failure message names the service 'workspace'"
else
  fail "cap_add NET_ADMIN failure message does not name 'workspace' — output: ${CAP_ADD_NET_ADMIN_OUTPUT}"
fi

if echo "${CAP_ADD_NET_ADMIN_OUTPUT}" | grep -q "NET_ADMIN"; then
  pass "cap_add NET_ADMIN failure message mentions 'NET_ADMIN'"
else
  fail "cap_add NET_ADMIN failure message does not mention 'NET_ADMIN' — output: ${CAP_ADD_NET_ADMIN_OUTPUT}"
fi

echo ""
echo "  cap-add-net-admin-test output (stderr+stdout combined):"
echo "${CAP_ADD_NET_ADMIN_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 28 — Negative: cap_add with NET_RAW must be rejected.
#
# NET_RAW enables raw-socket access (ICMP, packet injection).  Covers the
# second banned capability alongside NET_ADMIN.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 28: guard rejects cap_add NET_RAW ---"

CAP_ADD_NET_RAW_COMPOSE="${TMPDIR_TEST}/compose-cap-add-net-raw.yaml"
cat > "${CAP_ADD_NET_RAW_COMPOSE}" <<'YAML'
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
    cap_add:
      - NET_RAW

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_ADD_NET_RAW_OUTPUT=""
CAP_ADD_NET_RAW_EXIT=0
CAP_ADD_NET_RAW_OUTPUT="$(COMPOSE_FILE="${CAP_ADD_NET_RAW_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_ADD_NET_RAW_EXIT=$?

if [[ "${CAP_ADD_NET_RAW_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_ADD_NET_RAW_EXIT}) for cap_add NET_RAW"
else
  fail "validate-stack.sh exited ZERO for cap_add NET_RAW — guard did NOT fire"
fi

if echo "${CAP_ADD_NET_RAW_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add NET_RAW failure message names the service 'workspace'"
else
  fail "cap_add NET_RAW failure message does not name 'workspace' — output: ${CAP_ADD_NET_RAW_OUTPUT}"
fi

if echo "${CAP_ADD_NET_RAW_OUTPUT}" | grep -q "NET_RAW"; then
  pass "cap_add NET_RAW failure message mentions 'NET_RAW'"
else
  fail "cap_add NET_RAW failure message does not mention 'NET_RAW' — output: ${CAP_ADD_NET_RAW_OUTPUT}"
fi

echo ""
echo "  cap-add-net-raw-test output (stderr+stdout combined):"
echo "${CAP_ADD_NET_RAW_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 29 — Negative: devices mapping /dev/net/tun must be rejected.
#
# /dev/net/tun is the kernel TUN/TAP interface used by VPN clients.  Combined
# with NET_ADMIN/NET_RAW, it provides a complete egress bypass path.
# The failure message must name the service and mention '/dev/net/tun'.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 29: guard rejects devices mapping /dev/net/tun ---"

DEVICES_TUN_COMPOSE="${TMPDIR_TEST}/compose-devices-tun.yaml"
cat > "${DEVICES_TUN_COMPOSE}" <<'YAML'
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
    devices:
      - "/dev/net/tun:/dev/net/tun"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

DEVICES_TUN_OUTPUT=""
DEVICES_TUN_EXIT=0
DEVICES_TUN_OUTPUT="$(COMPOSE_FILE="${DEVICES_TUN_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || DEVICES_TUN_EXIT=$?

if [[ "${DEVICES_TUN_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${DEVICES_TUN_EXIT}) for devices /dev/net/tun"
else
  fail "validate-stack.sh exited ZERO for devices /dev/net/tun — guard did NOT fire"
fi

if echo "${DEVICES_TUN_OUTPUT}" | grep -q "workspace"; then
  pass "devices /dev/net/tun failure message names the service 'workspace'"
else
  fail "devices /dev/net/tun failure message does not name 'workspace' — output: ${DEVICES_TUN_OUTPUT}"
fi

if echo "${DEVICES_TUN_OUTPUT}" | grep -q "/dev/net/tun"; then
  pass "devices /dev/net/tun failure message mentions '/dev/net/tun'"
else
  fail "devices /dev/net/tun failure message does not mention '/dev/net/tun' — output: ${DEVICES_TUN_OUTPUT}"
fi

echo ""
echo "  devices-tun-test output (stderr+stdout combined):"
echo "${DEVICES_TUN_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 30 — Positive: benign extra_hosts (non-host-gateway) must NOT be rejected.
#
# extra_hosts: ["db:10.0.0.5"] is a legitimate static host entry that does not
# grant host-network access.  The guard must not over-reject benign extra_hosts.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 30: guard accepts benign extra_hosts (non-host-gateway value) ---"

EXTRA_HOSTS_BENIGN_COMPOSE="${TMPDIR_TEST}/compose-extra-hosts-benign.yaml"
cat > "${EXTRA_HOSTS_BENIGN_COMPOSE}" <<'YAML'
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
    extra_hosts:
      - "db:10.0.0.5"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

EXTRA_HOSTS_BENIGN_OUTPUT=""
EXTRA_HOSTS_BENIGN_EXIT=0
EXTRA_HOSTS_BENIGN_OUTPUT="$(COMPOSE_FILE="${EXTRA_HOSTS_BENIGN_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || EXTRA_HOSTS_BENIGN_EXIT=$?

if [[ "${EXTRA_HOSTS_BENIGN_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for benign extra_hosts (db:10.0.0.5) — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${EXTRA_HOSTS_BENIGN_EXIT}) for benign extra_hosts — over-rejection: ${EXTRA_HOSTS_BENIGN_OUTPUT}"
fi

echo ""
echo "  extra-hosts-benign-test output (stderr+stdout combined):"
echo "${EXTRA_HOSTS_BENIGN_OUTPUT}" | sed 's/^/    /'

# NOTE: TEST 2 (above) already asserts that the real deploy/compose.yaml passes
# the topology guard (exit zero).  No duplicate test is added here.

# ---------------------------------------------------------------------------
# TEST 31 — Negative: privileged: true must be rejected (Invariant 1f).
#
# privileged: true grants ALL Linux capabilities (including NET_ADMIN and
# NET_RAW) and access to ALL host devices (including /dev/net/tun), nullifying
# Invariants 1d and 1e.  The failure message must name the service and mention
# 'privileged'.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 31: guard rejects privileged: true (Invariant 1f) ---"

PRIVILEGED_COMPOSE="${TMPDIR_TEST}/compose-privileged.yaml"
cat > "${PRIVILEGED_COMPOSE}" <<'YAML'
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
    privileged: true

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

PRIVILEGED_OUTPUT=""
PRIVILEGED_EXIT=0
PRIVILEGED_OUTPUT="$(COMPOSE_FILE="${PRIVILEGED_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || PRIVILEGED_EXIT=$?

if [[ "${PRIVILEGED_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${PRIVILEGED_EXIT}) for privileged: true"
else
  fail "validate-stack.sh exited ZERO for privileged: true — Invariant 1f did NOT fire"
fi

if echo "${PRIVILEGED_OUTPUT}" | grep -q "workspace"; then
  pass "privileged: true failure message names the service 'workspace'"
else
  fail "privileged: true failure message does not name 'workspace' — output: ${PRIVILEGED_OUTPUT}"
fi

if echo "${PRIVILEGED_OUTPUT}" | grep -qi "privileged"; then
  pass "privileged: true failure message mentions 'privileged'"
else
  fail "privileged: true failure message does not mention 'privileged' — output: ${PRIVILEGED_OUTPUT}"
fi

echo ""
echo "  privileged-true-test output (stderr+stdout combined):"
echo "${PRIVILEGED_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 32 — Negative: cap_add: [CAP_NET_ADMIN] must be rejected (CAP_ prefix bypass).
#
# Docker Compose may preserve the CAP_ prefix from raw YAML or its own
# normalization.  The old check `str(_cap).upper() in {"NET_ADMIN","NET_RAW"}`
# would miss "CAP_NET_ADMIN" → "CAP_NET_ADMIN" not in set.  The fixed guard
# strips the CAP_ prefix before checking.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 32: guard rejects cap_add: [CAP_NET_ADMIN] (CAP_ prefix bypass) ---"

CAP_PREFIX_COMPOSE="${TMPDIR_TEST}/compose-cap-prefix.yaml"
cat > "${CAP_PREFIX_COMPOSE}" <<'YAML'
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
    cap_add:
      - CAP_NET_ADMIN

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_PREFIX_OUTPUT=""
CAP_PREFIX_EXIT=0
CAP_PREFIX_OUTPUT="$(COMPOSE_FILE="${CAP_PREFIX_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_PREFIX_EXIT=$?

if [[ "${CAP_PREFIX_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_PREFIX_EXIT}) for cap_add: [CAP_NET_ADMIN]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [CAP_NET_ADMIN] — CAP_ prefix bypass NOT caught"
fi

if echo "${CAP_PREFIX_OUTPUT}" | grep -q "workspace"; then
  pass "CAP_NET_ADMIN failure message names the service 'workspace'"
else
  fail "CAP_NET_ADMIN failure message does not name 'workspace' — output: ${CAP_PREFIX_OUTPUT}"
fi

if echo "${CAP_PREFIX_OUTPUT}" | grep -q "CAP_NET_ADMIN"; then
  pass "CAP_NET_ADMIN failure message mentions 'CAP_NET_ADMIN'"
else
  fail "CAP_NET_ADMIN failure message does not mention 'CAP_NET_ADMIN' — output: ${CAP_PREFIX_OUTPUT}"
fi

echo ""
echo "  cap-prefix-test output (stderr+stdout combined):"
echo "${CAP_PREFIX_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 33 — Negative: cap_add: [cap_net_admin] must be rejected (lowercase bypass).
#
# Raw YAML may contain lowercase capability names.  The old check uppercased
# but did not strip the CAP_ prefix, so "cap_net_admin" → "CAP_NET_ADMIN"
# which is NOT in {"NET_ADMIN","NET_RAW"}.  The fixed guard normalizes both
# case and prefix.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 33: guard rejects cap_add: [cap_net_admin] (lowercase bypass) ---"

CAP_LOWER_COMPOSE="${TMPDIR_TEST}/compose-cap-lower.yaml"
cat > "${CAP_LOWER_COMPOSE}" <<'YAML'
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
    cap_add:
      - cap_net_admin

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_LOWER_OUTPUT=""
CAP_LOWER_EXIT=0
CAP_LOWER_OUTPUT="$(COMPOSE_FILE="${CAP_LOWER_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_LOWER_EXIT=$?

if [[ "${CAP_LOWER_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_LOWER_EXIT}) for cap_add: [cap_net_admin]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [cap_net_admin] — lowercase bypass NOT caught"
fi

if echo "${CAP_LOWER_OUTPUT}" | grep -q "workspace"; then
  pass "cap_net_admin failure message names the service 'workspace'"
else
  fail "cap_net_admin failure message does not name 'workspace' — output: ${CAP_LOWER_OUTPUT}"
fi

if echo "${CAP_LOWER_OUTPUT}" | grep -qi "cap_net_admin\|NET_ADMIN"; then
  pass "cap_net_admin failure message mentions the capability"
else
  fail "cap_net_admin failure message does not mention the capability — output: ${CAP_LOWER_OUTPUT}"
fi

echo ""
echo "  cap-lower-test output (stderr+stdout combined):"
echo "${CAP_LOWER_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 34 — Negative: devices: ["//dev/net/tun:/dev/net/tun"] must be rejected
#           (double-slash path normalization bypass).
#
# Docker normalizes device paths via filepath.Clean, so //dev/net/tun resolves
# to /dev/net/tun at runtime.  The old literal == "/dev/net/tun" check missed
# the double-slash form.  The fixed guard uses os.path.normpath.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 34: guard rejects devices: [\"//dev/net/tun:/dev/net/tun\"] (double-slash path) ---"

DEVICES_DSLASH_COMPOSE="${TMPDIR_TEST}/compose-devices-dslash.yaml"
cat > "${DEVICES_DSLASH_COMPOSE}" <<'YAML'
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
    devices:
      - "//dev/net/tun:/dev/net/tun"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

DEVICES_DSLASH_OUTPUT=""
DEVICES_DSLASH_EXIT=0
DEVICES_DSLASH_OUTPUT="$(COMPOSE_FILE="${DEVICES_DSLASH_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || DEVICES_DSLASH_EXIT=$?

if [[ "${DEVICES_DSLASH_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${DEVICES_DSLASH_EXIT}) for devices //dev/net/tun"
else
  fail "validate-stack.sh exited ZERO for devices //dev/net/tun — double-slash bypass NOT caught"
fi

if echo "${DEVICES_DSLASH_OUTPUT}" | grep -q "workspace"; then
  pass "//dev/net/tun failure message names the service 'workspace'"
else
  fail "//dev/net/tun failure message does not name 'workspace' — output: ${DEVICES_DSLASH_OUTPUT}"
fi

if echo "${DEVICES_DSLASH_OUTPUT}" | grep -q "/dev/net/tun"; then
  pass "//dev/net/tun failure message mentions '/dev/net/tun'"
else
  fail "//dev/net/tun failure message does not mention '/dev/net/tun' — output: ${DEVICES_DSLASH_OUTPUT}"
fi

echo ""
echo "  devices-dslash-test output (stderr+stdout combined):"
echo "${DEVICES_DSLASH_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 35 — Negative: devices: ["/dev/./net/tun:/dev/net/tun"] must be rejected
#           (/./ segment path normalization bypass).
#
# /dev/./net/tun resolves to /dev/net/tun via filepath.Clean at runtime.
# The old literal check missed this form.  The fixed guard uses os.path.normpath.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 35: guard rejects devices: [\"/dev/./net/tun:/dev/net/tun\"] (/./ segment path) ---"

DEVICES_DOT_COMPOSE="${TMPDIR_TEST}/compose-devices-dot.yaml"
cat > "${DEVICES_DOT_COMPOSE}" <<'YAML'
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
    devices:
      - "/dev/./net/tun:/dev/net/tun"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

DEVICES_DOT_OUTPUT=""
DEVICES_DOT_EXIT=0
DEVICES_DOT_OUTPUT="$(COMPOSE_FILE="${DEVICES_DOT_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || DEVICES_DOT_EXIT=$?

if [[ "${DEVICES_DOT_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${DEVICES_DOT_EXIT}) for devices /dev/./net/tun"
else
  fail "validate-stack.sh exited ZERO for devices /dev/./net/tun — /./ bypass NOT caught"
fi

if echo "${DEVICES_DOT_OUTPUT}" | grep -q "workspace"; then
  pass "/dev/./net/tun failure message names the service 'workspace'"
else
  fail "/dev/./net/tun failure message does not name 'workspace' — output: ${DEVICES_DOT_OUTPUT}"
fi

if echo "${DEVICES_DOT_OUTPUT}" | grep -q "/dev/net/tun"; then
  pass "/dev/./net/tun failure message mentions '/dev/net/tun'"
else
  fail "/dev/./net/tun failure message does not mention '/dev/net/tun' — output: ${DEVICES_DOT_OUTPUT}"
fi

echo ""
echo "  devices-dot-test output (stderr+stdout combined):"
echo "${DEVICES_DOT_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 36 — Negative: cap_add: NET_ADMIN (scalar string, not list) must be
#           rejected (scalar bypass).
#
# YAML allows `cap_add: NET_ADMIN` (scalar) instead of `cap_add: [NET_ADMIN]`
# (list).  The old `for _cap in _cap_add:` would iterate characters of the
# string "NET_ADMIN" and silently miss the violation.  The fixed guard wraps
# scalar strings into a single-element list before iterating.
#
# NOTE: docker compose config normalizes scalar cap_add to a list, so this
# bypass only fires via the raw-YAML fallback path (no docker in PATH).
# This test strips docker from PATH and requires PyYAML.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 36: guard rejects cap_add: NET_ADMIN (scalar string, not list) via raw-YAML path ---"

CAP_SCALAR_COMPOSE="${TMPDIR_TEST}/compose-cap-scalar.yaml"
cat > "${CAP_SCALAR_COMPOSE}" <<'YAML'
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
    cap_add: NET_ADMIN

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
  CAP_SCALAR_OUTPUT=""
  CAP_SCALAR_EXIT=0
  CAP_SCALAR_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${CAP_SCALAR_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || CAP_SCALAR_EXIT=$?

  if [[ "${CAP_SCALAR_EXIT}" -ne 0 ]]; then
    pass "validate-stack.sh exited non-zero (${CAP_SCALAR_EXIT}) for scalar cap_add: NET_ADMIN"
  else
    fail "validate-stack.sh exited ZERO for scalar cap_add: NET_ADMIN — scalar bypass NOT caught"
  fi

  if echo "${CAP_SCALAR_OUTPUT}" | grep -q "workspace"; then
    pass "scalar cap_add failure message names the service 'workspace'"
  else
    fail "scalar cap_add failure message does not name 'workspace' — output: ${CAP_SCALAR_OUTPUT}"
  fi

  if echo "${CAP_SCALAR_OUTPUT}" | grep -qi "NET_ADMIN"; then
    pass "scalar cap_add failure message mentions 'NET_ADMIN'"
  else
    fail "scalar cap_add failure message does not mention 'NET_ADMIN' — output: ${CAP_SCALAR_OUTPUT}"
  fi

  echo ""
  echo "  cap-scalar-test output (stderr+stdout combined):"
  echo "${CAP_SCALAR_OUTPUT}" | sed 's/^/    /'
else
  echo "  SKIP: scalar cap_add test: PyYAML not available — install python3-yaml/PyYAML to run this test."
  echo "        (docker compose config normalizes scalar cap_add to a list; raw-YAML path required for this bypass)"
fi

# ---------------------------------------------------------------------------
# TEST 37 — Negative: extra_hosts dict form {proxy.local: host-gateway} must
#           be rejected (raw-YAML dict form).
#
# Raw YAML allows extra_hosts as a mapping: {proxy.local: host-gateway}.
# The guard handles this via the dict branch.  This test exercises that path
# via the raw-YAML fallback (no docker in PATH) and requires PyYAML.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 37: guard rejects extra_hosts dict form {proxy.local: host-gateway} via raw-YAML path ---"

EXTRA_HOSTS_DICT_COMPOSE="${TMPDIR_TEST}/compose-extra-hosts-dict.yaml"
cat > "${EXTRA_HOSTS_DICT_COMPOSE}" <<'YAML'
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
    extra_hosts:
      proxy.local: host-gateway

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
  EXTRA_HOSTS_DICT_OUTPUT=""
  EXTRA_HOSTS_DICT_EXIT=0
  EXTRA_HOSTS_DICT_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${EXTRA_HOSTS_DICT_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || EXTRA_HOSTS_DICT_EXIT=$?

  if [[ "${EXTRA_HOSTS_DICT_EXIT}" -ne 0 ]]; then
    pass "validate-stack.sh exited non-zero (${EXTRA_HOSTS_DICT_EXIT}) for extra_hosts dict {proxy.local: host-gateway}"
  else
    fail "validate-stack.sh exited ZERO for extra_hosts dict form — dict bypass NOT caught"
  fi

  if echo "${EXTRA_HOSTS_DICT_OUTPUT}" | grep -q "workspace"; then
    pass "extra_hosts dict failure message names the service 'workspace'"
  else
    fail "extra_hosts dict failure message does not name 'workspace' — output: ${EXTRA_HOSTS_DICT_OUTPUT}"
  fi

  if echo "${EXTRA_HOSTS_DICT_OUTPUT}" | grep -q "host-gateway"; then
    pass "extra_hosts dict failure message mentions 'host-gateway'"
  else
    fail "extra_hosts dict failure message does not mention 'host-gateway' — output: ${EXTRA_HOSTS_DICT_OUTPUT}"
  fi

  echo ""
  echo "  extra-hosts-dict-test output (stderr+stdout combined):"
  echo "${EXTRA_HOSTS_DICT_OUTPUT}" | sed 's/^/    /'
else
  echo "  SKIP: extra_hosts dict test: PyYAML not available — install python3-yaml/PyYAML to run this test."
  echo "        (docker compose config normalizes dict extra_hosts to list form; raw-YAML path required)"
fi

# ---------------------------------------------------------------------------
# TEST 38 — Negative: cap_add: [ALL] must be rejected (Invariant 1d, ALL cap).
#
# ALL grants every Linux capability including the banned NET_ADMIN and NET_RAW.
# The failure message must name the service and mention 'ALL'.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 38: guard rejects cap_add: [ALL] ---"

CAP_ALL_COMPOSE="${TMPDIR_TEST}/compose-cap-all.yaml"
cat > "${CAP_ALL_COMPOSE}" <<'YAML'
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
    cap_add:
      - ALL

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_ALL_OUTPUT=""
CAP_ALL_EXIT=0
CAP_ALL_OUTPUT="$(COMPOSE_FILE="${CAP_ALL_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_ALL_EXIT=$?

if [[ "${CAP_ALL_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_ALL_EXIT}) for cap_add: [ALL]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [ALL] — guard did NOT fire"
fi

if echo "${CAP_ALL_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add ALL failure message names the service 'workspace'"
else
  fail "cap_add ALL failure message does not name 'workspace' — output: ${CAP_ALL_OUTPUT}"
fi

if echo "${CAP_ALL_OUTPUT}" | grep -q "ALL"; then
  pass "cap_add ALL failure message mentions 'ALL'"
else
  fail "cap_add ALL failure message does not mention 'ALL' — output: ${CAP_ALL_OUTPUT}"
fi

echo ""
echo "  cap-add-all-test output (stderr+stdout combined):"
echo "${CAP_ALL_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 39 — Negative: cap_add: [CAP_ALL] must be rejected (CAP_ prefix norm).
#
# Docker Compose or raw YAML may preserve the CAP_ prefix.  The guard strips
# CAP_ before checking the banned set, so CAP_ALL → ALL is caught.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 39: guard rejects cap_add: [CAP_ALL] (CAP_ prefix normalization) ---"

CAP_CAP_ALL_COMPOSE="${TMPDIR_TEST}/compose-cap-cap-all.yaml"
cat > "${CAP_CAP_ALL_COMPOSE}" <<'YAML'
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
    cap_add:
      - CAP_ALL

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_CAP_ALL_OUTPUT=""
CAP_CAP_ALL_EXIT=0
CAP_CAP_ALL_OUTPUT="$(COMPOSE_FILE="${CAP_CAP_ALL_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_CAP_ALL_EXIT=$?

if [[ "${CAP_CAP_ALL_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_CAP_ALL_EXIT}) for cap_add: [CAP_ALL]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [CAP_ALL] — CAP_ prefix bypass NOT caught"
fi

if echo "${CAP_CAP_ALL_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add CAP_ALL failure message names the service 'workspace'"
else
  fail "cap_add CAP_ALL failure message does not name 'workspace' — output: ${CAP_CAP_ALL_OUTPUT}"
fi

if echo "${CAP_CAP_ALL_OUTPUT}" | grep -qi "CAP_ALL\|ALL"; then
  pass "cap_add CAP_ALL failure message mentions the capability"
else
  fail "cap_add CAP_ALL failure message does not mention the capability — output: ${CAP_CAP_ALL_OUTPUT}"
fi

echo ""
echo "  cap-cap-all-test output (stderr+stdout combined):"
echo "${CAP_CAP_ALL_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 40 — Negative: device_cgroup_rules: ["c 10:200 rwm"] must be rejected
#           (Invariant 1g).
#
# A cgroup device-allow rule grants device access by major:minor number
# independent of the devices: mapping.  Combined with mknod, it can restore
# tunnel capability that Invariant 1e blocks.  The failure message must name
# the service and the offending rule.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 40: guard rejects device_cgroup_rules: [\"c 10:200 rwm\"] (Invariant 1g) ---"

DCR_COMPOSE="${TMPDIR_TEST}/compose-dcr.yaml"
cat > "${DCR_COMPOSE}" <<'YAML'
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
    device_cgroup_rules:
      - "c 10:200 rwm"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

DCR_OUTPUT=""
DCR_EXIT=0
DCR_OUTPUT="$(COMPOSE_FILE="${DCR_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || DCR_EXIT=$?

if [[ "${DCR_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${DCR_EXIT}) for device_cgroup_rules: [\"c 10:200 rwm\"]"
else
  fail "validate-stack.sh exited ZERO for device_cgroup_rules — Invariant 1g did NOT fire"
fi

if echo "${DCR_OUTPUT}" | grep -q "workspace"; then
  pass "device_cgroup_rules failure message names the service 'workspace'"
else
  fail "device_cgroup_rules failure message does not name 'workspace' — output: ${DCR_OUTPUT}"
fi

if echo "${DCR_OUTPUT}" | grep -q "c 10:200 rwm"; then
  pass "device_cgroup_rules failure message mentions the offending rule 'c 10:200 rwm'"
else
  fail "device_cgroup_rules failure message does not mention the rule — output: ${DCR_OUTPUT}"
fi

echo ""
echo "  device-cgroup-rules-test output (stderr+stdout combined):"
echo "${DCR_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 41 — Negative: pid: host must be rejected (Invariant 1h).
#
# pid: host shares the host PID namespace; with sufficient capability
# a container can nsenter into host namespaces and escape internal:true.
# The failure message must name the service and mention 'pid'.
# (Docker Compose uses the key 'pid', not 'pid_mode'.)
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 41: guard rejects pid: host (Invariant 1h) ---"

PID_HOST_COMPOSE="${TMPDIR_TEST}/compose-pid-host.yaml"
cat > "${PID_HOST_COMPOSE}" <<'YAML'
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
    pid: host

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

PID_HOST_OUTPUT=""
PID_HOST_EXIT=0
PID_HOST_OUTPUT="$(COMPOSE_FILE="${PID_HOST_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || PID_HOST_EXIT=$?

if [[ "${PID_HOST_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${PID_HOST_EXIT}) for pid: host"
else
  fail "validate-stack.sh exited ZERO for pid: host — Invariant 1h did NOT fire"
fi

if echo "${PID_HOST_OUTPUT}" | grep -q "workspace"; then
  pass "pid: host failure message names the service 'workspace'"
else
  fail "pid: host failure message does not name 'workspace' — output: ${PID_HOST_OUTPUT}"
fi

if echo "${PID_HOST_OUTPUT}" | grep -qi "pid"; then
  pass "pid: host failure message mentions 'pid'"
else
  fail "pid: host failure message does not mention 'pid' — output: ${PID_HOST_OUTPUT}"
fi

echo ""
echo "  pid-host-test output (stderr+stdout combined):"
echo "${PID_HOST_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 42 — Positive: pid: "service:mitmproxy" must NOT be rejected.
#
# pid: service:<x> shares another container's PID namespace, not the
# host's.  It is not a host-namespace escape and must not be over-rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 42: guard accepts pid: \"service:mitmproxy\" (not host-ns escape) ---"

PID_SVC_COMPOSE="${TMPDIR_TEST}/compose-pid-svc.yaml"
cat > "${PID_SVC_COMPOSE}" <<'YAML'
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
    pid: "service:mitmproxy"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

PID_SVC_OUTPUT=""
PID_SVC_EXIT=0
PID_SVC_OUTPUT="$(COMPOSE_FILE="${PID_SVC_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || PID_SVC_EXIT=$?

if [[ "${PID_SVC_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for pid: \"service:mitmproxy\" — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${PID_SVC_EXIT}) for pid: \"service:mitmproxy\" — over-rejection: ${PID_SVC_OUTPUT}"
fi

echo ""
echo "  pid-svc-test output (stderr+stdout combined):"
echo "${PID_SVC_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 43 — Negative: sysctls: {net.ipv4.ip_forward: 1} must be rejected
#           (Invariant 1i, map form).
#
# Enabling IP forwarding turns the container into a router that can relay
# traffic between network interfaces, bypassing the mitmproxy chokepoint.
# The failure message must name the service and the sysctl.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 43: guard rejects sysctls: {net.ipv4.ip_forward: 1} (Invariant 1i) ---"

SYSCTL_IPV4_COMPOSE="${TMPDIR_TEST}/compose-sysctl-ipv4.yaml"
cat > "${SYSCTL_IPV4_COMPOSE}" <<'YAML'
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
    sysctls:
      net.ipv4.ip_forward: 1

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SYSCTL_IPV4_OUTPUT=""
SYSCTL_IPV4_EXIT=0
SYSCTL_IPV4_OUTPUT="$(COMPOSE_FILE="${SYSCTL_IPV4_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SYSCTL_IPV4_EXIT=$?

if [[ "${SYSCTL_IPV4_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${SYSCTL_IPV4_EXIT}) for sysctls net.ipv4.ip_forward=1"
else
  fail "validate-stack.sh exited ZERO for sysctls net.ipv4.ip_forward=1 — Invariant 1i did NOT fire"
fi

if echo "${SYSCTL_IPV4_OUTPUT}" | grep -q "workspace"; then
  pass "sysctls ipv4 failure message names the service 'workspace'"
else
  fail "sysctls ipv4 failure message does not name 'workspace' — output: ${SYSCTL_IPV4_OUTPUT}"
fi

if echo "${SYSCTL_IPV4_OUTPUT}" | grep -q "net.ipv4.ip_forward"; then
  pass "sysctls ipv4 failure message mentions 'net.ipv4.ip_forward'"
else
  fail "sysctls ipv4 failure message does not mention 'net.ipv4.ip_forward' — output: ${SYSCTL_IPV4_OUTPUT}"
fi

echo ""
echo "  sysctl-ipv4-test output (stderr+stdout combined):"
echo "${SYSCTL_IPV4_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 44 — Negative: sysctls list form ["net.ipv6.conf.all.forwarding=1"]
#           must be rejected (Invariant 1i, list form + IPv6).
#
# Raw YAML may express sysctls as a list of "name=value" strings.  The guard
# handles both map and list forms.  IPv6 forwarding is also an IP-forwarding
# sysctl that enables container-as-router behavior.
#
# NOTE: docker compose config normalizes list-form sysctls to a map, so this
# bypass only fires via the raw-YAML fallback path (no docker in PATH).
# This test strips docker from PATH and requires PyYAML.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 44: guard rejects sysctls list form [\"net.ipv6.conf.all.forwarding=1\"] via raw-YAML path ---"

SYSCTL_IPV6_COMPOSE="${TMPDIR_TEST}/compose-sysctl-ipv6.yaml"
cat > "${SYSCTL_IPV6_COMPOSE}" <<'YAML'
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
    sysctls:
      - "net.ipv6.conf.all.forwarding=1"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
  SYSCTL_IPV6_OUTPUT=""
  SYSCTL_IPV6_EXIT=0
  SYSCTL_IPV6_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${SYSCTL_IPV6_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || SYSCTL_IPV6_EXIT=$?

  if [[ "${SYSCTL_IPV6_EXIT}" -ne 0 ]]; then
    pass "validate-stack.sh exited non-zero (${SYSCTL_IPV6_EXIT}) for sysctls list net.ipv6.conf.all.forwarding=1"
  else
    fail "validate-stack.sh exited ZERO for sysctls list net.ipv6.conf.all.forwarding=1 — Invariant 1i did NOT fire"
  fi

  if echo "${SYSCTL_IPV6_OUTPUT}" | grep -q "workspace"; then
    pass "sysctls ipv6 list failure message names the service 'workspace'"
  else
    fail "sysctls ipv6 list failure message does not name 'workspace' — output: ${SYSCTL_IPV6_OUTPUT}"
  fi

  if echo "${SYSCTL_IPV6_OUTPUT}" | grep -q "net.ipv6.conf.all.forwarding"; then
    pass "sysctls ipv6 list failure message mentions 'net.ipv6.conf.all.forwarding'"
  else
    fail "sysctls ipv6 list failure message does not mention the sysctl — output: ${SYSCTL_IPV6_OUTPUT}"
  fi

  echo ""
  echo "  sysctl-ipv6-list-test output (stderr+stdout combined):"
  echo "${SYSCTL_IPV6_OUTPUT}" | sed 's/^/    /'
else
  echo "  SKIP: sysctls list form test: PyYAML not available — install python3-yaml/PyYAML to run this test."
  echo "        (docker compose config normalizes list-form sysctls to a map; raw-YAML path required for this form)"
fi

# ---------------------------------------------------------------------------
# TEST 45 — Positive: sysctls: {net.ipv4.ip_forward: 0} must NOT be rejected.
#
# Forwarding disabled (value=0) is not an egress-enabling sysctl.  The guard
# must not over-reject forwarding=0 or other benign sysctls.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 45: guard accepts sysctls: {net.ipv4.ip_forward: 0} (forwarding disabled) ---"

SYSCTL_DISABLED_COMPOSE="${TMPDIR_TEST}/compose-sysctl-disabled.yaml"
cat > "${SYSCTL_DISABLED_COMPOSE}" <<'YAML'
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
    sysctls:
      net.ipv4.ip_forward: 0

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SYSCTL_DISABLED_OUTPUT=""
SYSCTL_DISABLED_EXIT=0
SYSCTL_DISABLED_OUTPUT="$(COMPOSE_FILE="${SYSCTL_DISABLED_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SYSCTL_DISABLED_EXIT=$?

if [[ "${SYSCTL_DISABLED_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for sysctls net.ipv4.ip_forward=0 — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${SYSCTL_DISABLED_EXIT}) for sysctls forwarding=0 — over-rejection: ${SYSCTL_DISABLED_OUTPUT}"
fi

echo ""
echo "  sysctl-disabled-test output (stderr+stdout combined):"
echo "${SYSCTL_DISABLED_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 46 — Negative: security_opt: ["seccomp:unconfined"] must be rejected
#           (Invariant 1j).
#
# seccomp:unconfined disables the seccomp syscall filter, unblocking
# operations otherwise restricted that aid egress bypass.
# The failure message must name the service and the offending option.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 46: guard rejects security_opt: [\"seccomp:unconfined\"] (Invariant 1j) ---"

SECOPT_SECCOMP_COMPOSE="${TMPDIR_TEST}/compose-secopt-seccomp.yaml"
cat > "${SECOPT_SECCOMP_COMPOSE}" <<'YAML'
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
    security_opt:
      - "seccomp:unconfined"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SECOPT_SECCOMP_OUTPUT=""
SECOPT_SECCOMP_EXIT=0
SECOPT_SECCOMP_OUTPUT="$(COMPOSE_FILE="${SECOPT_SECCOMP_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SECOPT_SECCOMP_EXIT=$?

if [[ "${SECOPT_SECCOMP_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${SECOPT_SECCOMP_EXIT}) for security_opt: [\"seccomp:unconfined\"]"
else
  fail "validate-stack.sh exited ZERO for security_opt seccomp:unconfined — Invariant 1j did NOT fire"
fi

if echo "${SECOPT_SECCOMP_OUTPUT}" | grep -q "workspace"; then
  pass "security_opt seccomp:unconfined failure message names the service 'workspace'"
else
  fail "security_opt seccomp:unconfined failure message does not name 'workspace' — output: ${SECOPT_SECCOMP_OUTPUT}"
fi

if echo "${SECOPT_SECCOMP_OUTPUT}" | grep -qi "seccomp"; then
  pass "security_opt seccomp:unconfined failure message mentions 'seccomp'"
else
  fail "security_opt seccomp:unconfined failure message does not mention 'seccomp' — output: ${SECOPT_SECCOMP_OUTPUT}"
fi

echo ""
echo "  secopt-seccomp-test output (stderr+stdout combined):"
echo "${SECOPT_SECCOMP_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 47 — Negative: security_opt: ["apparmor:unconfined"] must be rejected
#           (Invariant 1j).
#
# apparmor:unconfined disables the AppArmor MAC profile, relaxing kernel
# confinement and unblocking operations that aid egress bypass.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 47: guard rejects security_opt: [\"apparmor:unconfined\"] (Invariant 1j) ---"

SECOPT_APPARMOR_COMPOSE="${TMPDIR_TEST}/compose-secopt-apparmor.yaml"
cat > "${SECOPT_APPARMOR_COMPOSE}" <<'YAML'
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
    security_opt:
      - "apparmor:unconfined"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SECOPT_APPARMOR_OUTPUT=""
SECOPT_APPARMOR_EXIT=0
SECOPT_APPARMOR_OUTPUT="$(COMPOSE_FILE="${SECOPT_APPARMOR_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SECOPT_APPARMOR_EXIT=$?

if [[ "${SECOPT_APPARMOR_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${SECOPT_APPARMOR_EXIT}) for security_opt: [\"apparmor:unconfined\"]"
else
  fail "validate-stack.sh exited ZERO for security_opt apparmor:unconfined — Invariant 1j did NOT fire"
fi

if echo "${SECOPT_APPARMOR_OUTPUT}" | grep -q "workspace"; then
  pass "security_opt apparmor:unconfined failure message names the service 'workspace'"
else
  fail "security_opt apparmor:unconfined failure message does not name 'workspace' — output: ${SECOPT_APPARMOR_OUTPUT}"
fi

if echo "${SECOPT_APPARMOR_OUTPUT}" | grep -qi "apparmor"; then
  pass "security_opt apparmor:unconfined failure message mentions 'apparmor'"
else
  fail "security_opt apparmor:unconfined failure message does not mention 'apparmor' — output: ${SECOPT_APPARMOR_OUTPUT}"
fi

echo ""
echo "  secopt-apparmor-test output (stderr+stdout combined):"
echo "${SECOPT_APPARMOR_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 48 — Positive: security_opt: ["no-new-privileges:true"] must NOT be
#           rejected (Invariant 1j positive control).
#
# no-new-privileges:true strengthens confinement (prevents privilege
# escalation via setuid/setgid).  The guard must not over-reject it.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 48: guard accepts security_opt: [\"no-new-privileges:true\"] (strengthens confinement) ---"

SECOPT_NNP_COMPOSE="${TMPDIR_TEST}/compose-secopt-nnp.yaml"
cat > "${SECOPT_NNP_COMPOSE}" <<'YAML'
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
    security_opt:
      - "no-new-privileges:true"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SECOPT_NNP_OUTPUT=""
SECOPT_NNP_EXIT=0
SECOPT_NNP_OUTPUT="$(COMPOSE_FILE="${SECOPT_NNP_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SECOPT_NNP_EXIT=$?

if [[ "${SECOPT_NNP_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for security_opt: [\"no-new-privileges:true\"] — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${SECOPT_NNP_EXIT}) for no-new-privileges:true — over-rejection: ${SECOPT_NNP_OUTPUT}"
fi

echo ""
echo "  secopt-nnp-test output (stderr+stdout combined):"
echo "${SECOPT_NNP_OUTPUT}" | sed 's/^/    /'

# NOTE: TEST 2 (above) already asserts that the real deploy/compose.yaml passes
# the topology guard (exit zero) — no duplicate test is added here for the new
# invariants.  The real compose.yaml uses none of the newly-rejected keys, so
# TEST 2 serves as the positive control for all of Invariants 1g-1j as well.

# ---------------------------------------------------------------------------
# TEST 49 — Negative: cap_add: [SYS_MODULE] must be rejected (Invariant 1d).
#
# SYS_MODULE allows loading kernel modules.  Docker's default seccomp profile
# permits init_module/finit_module when CAP_SYS_MODULE is present, enabling
# an attacker to load a tunnel kernel module and bypass mitmproxy.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 49: guard rejects cap_add: [SYS_MODULE] (module-load bypass) ---"

CAP_SYS_MODULE_COMPOSE="${TMPDIR_TEST}/compose-cap-sys-module.yaml"
cat > "${CAP_SYS_MODULE_COMPOSE}" <<'YAML'
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
    cap_add:
      - SYS_MODULE

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_SYS_MODULE_OUTPUT=""
CAP_SYS_MODULE_EXIT=0
CAP_SYS_MODULE_OUTPUT="$(COMPOSE_FILE="${CAP_SYS_MODULE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_SYS_MODULE_EXIT=$?

if [[ "${CAP_SYS_MODULE_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_SYS_MODULE_EXIT}) for cap_add: [SYS_MODULE]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [SYS_MODULE] — module-load bypass NOT caught"
fi

if echo "${CAP_SYS_MODULE_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add SYS_MODULE failure message names the service 'workspace'"
else
  fail "cap_add SYS_MODULE failure message does not name 'workspace' — output: ${CAP_SYS_MODULE_OUTPUT}"
fi

if echo "${CAP_SYS_MODULE_OUTPUT}" | grep -qi "SYS_MODULE"; then
  pass "cap_add SYS_MODULE failure message mentions 'SYS_MODULE'"
else
  fail "cap_add SYS_MODULE failure message does not mention 'SYS_MODULE' — output: ${CAP_SYS_MODULE_OUTPUT}"
fi

echo ""
echo "  cap-sys-module-test output (stderr+stdout combined):"
echo "${CAP_SYS_MODULE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 50 — Negative: cap_add: [SYS_ADMIN] must be rejected (Invariant 1d).
#
# SYS_ADMIN enables the nsenter namespace-escape chain (ioctl NS_GET_PARENT +
# setns into the host network namespace), escaping sandbox-net isolation.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 50: guard rejects cap_add: [SYS_ADMIN] (namespace-escape bypass) ---"

CAP_SYS_ADMIN_COMPOSE="${TMPDIR_TEST}/compose-cap-sys-admin.yaml"
cat > "${CAP_SYS_ADMIN_COMPOSE}" <<'YAML'
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
    cap_add:
      - SYS_ADMIN

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_SYS_ADMIN_OUTPUT=""
CAP_SYS_ADMIN_EXIT=0
CAP_SYS_ADMIN_OUTPUT="$(COMPOSE_FILE="${CAP_SYS_ADMIN_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_SYS_ADMIN_EXIT=$?

if [[ "${CAP_SYS_ADMIN_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_SYS_ADMIN_EXIT}) for cap_add: [SYS_ADMIN]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [SYS_ADMIN] — namespace-escape bypass NOT caught"
fi

if echo "${CAP_SYS_ADMIN_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add SYS_ADMIN failure message names the service 'workspace'"
else
  fail "cap_add SYS_ADMIN failure message does not name 'workspace' — output: ${CAP_SYS_ADMIN_OUTPUT}"
fi

if echo "${CAP_SYS_ADMIN_OUTPUT}" | grep -qi "SYS_ADMIN"; then
  pass "cap_add SYS_ADMIN failure message mentions 'SYS_ADMIN'"
else
  fail "cap_add SYS_ADMIN failure message does not mention 'SYS_ADMIN' — output: ${CAP_SYS_ADMIN_OUTPUT}"
fi

echo ""
echo "  cap-sys-admin-test output (stderr+stdout combined):"
echo "${CAP_SYS_ADMIN_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 51 — Negative: cap_add: [CAP_SYS_ADMIN] must be rejected (CAP_ prefix
#           normalization, Invariant 1d).
#
# Docker Compose or raw YAML may preserve the CAP_ prefix.  The guard strips
# CAP_ before checking the banned set, so CAP_SYS_ADMIN → SYS_ADMIN is caught.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 51: guard rejects cap_add: [CAP_SYS_ADMIN] (CAP_ prefix normalization) ---"

CAP_CAP_SYS_ADMIN_COMPOSE="${TMPDIR_TEST}/compose-cap-cap-sys-admin.yaml"
cat > "${CAP_CAP_SYS_ADMIN_COMPOSE}" <<'YAML'
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
    cap_add:
      - CAP_SYS_ADMIN

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_CAP_SYS_ADMIN_OUTPUT=""
CAP_CAP_SYS_ADMIN_EXIT=0
CAP_CAP_SYS_ADMIN_OUTPUT="$(COMPOSE_FILE="${CAP_CAP_SYS_ADMIN_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_CAP_SYS_ADMIN_EXIT=$?

if [[ "${CAP_CAP_SYS_ADMIN_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_CAP_SYS_ADMIN_EXIT}) for cap_add: [CAP_SYS_ADMIN]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [CAP_SYS_ADMIN] — CAP_ prefix bypass NOT caught"
fi

if echo "${CAP_CAP_SYS_ADMIN_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add CAP_SYS_ADMIN failure message names the service 'workspace'"
else
  fail "cap_add CAP_SYS_ADMIN failure message does not name 'workspace' — output: ${CAP_CAP_SYS_ADMIN_OUTPUT}"
fi

if echo "${CAP_CAP_SYS_ADMIN_OUTPUT}" | grep -qi "CAP_SYS_ADMIN\|SYS_ADMIN"; then
  pass "cap_add CAP_SYS_ADMIN failure message mentions the capability"
else
  fail "cap_add CAP_SYS_ADMIN failure message does not mention the capability — output: ${CAP_CAP_SYS_ADMIN_OUTPUT}"
fi

echo ""
echo "  cap-cap-sys-admin-test output (stderr+stdout combined):"
echo "${CAP_CAP_SYS_ADMIN_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 52 — Negative: sysctls: {net.ipv4.conf.all.forwarding: 1} must be
#           rejected (Invariant 1i, IPv4 per-interface alias).
#
# The Linux kernel aliases net.ipv4.conf.all.forwarding to the same forwarding
# behavior as net.ipv4.ip_forward.  The guard must catch this form.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 52: guard rejects sysctls: {net.ipv4.conf.all.forwarding: 1} (IPv4 conf.all alias) ---"

SYSCTL_IPV4_CONF_ALL_COMPOSE="${TMPDIR_TEST}/compose-sysctl-ipv4-conf-all.yaml"
cat > "${SYSCTL_IPV4_CONF_ALL_COMPOSE}" <<'YAML'
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
    sysctls:
      net.ipv4.conf.all.forwarding: 1

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SYSCTL_IPV4_CONF_ALL_OUTPUT=""
SYSCTL_IPV4_CONF_ALL_EXIT=0
SYSCTL_IPV4_CONF_ALL_OUTPUT="$(COMPOSE_FILE="${SYSCTL_IPV4_CONF_ALL_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SYSCTL_IPV4_CONF_ALL_EXIT=$?

if [[ "${SYSCTL_IPV4_CONF_ALL_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${SYSCTL_IPV4_CONF_ALL_EXIT}) for sysctls net.ipv4.conf.all.forwarding=1"
else
  fail "validate-stack.sh exited ZERO for sysctls net.ipv4.conf.all.forwarding=1 — IPv4 conf.all alias NOT caught"
fi

if echo "${SYSCTL_IPV4_CONF_ALL_OUTPUT}" | grep -q "workspace"; then
  pass "sysctls ipv4.conf.all failure message names the service 'workspace'"
else
  fail "sysctls ipv4.conf.all failure message does not name 'workspace' — output: ${SYSCTL_IPV4_CONF_ALL_OUTPUT}"
fi

if echo "${SYSCTL_IPV4_CONF_ALL_OUTPUT}" | grep -q "net.ipv4.conf.all.forwarding"; then
  pass "sysctls ipv4.conf.all failure message mentions 'net.ipv4.conf.all.forwarding'"
else
  fail "sysctls ipv4.conf.all failure message does not mention the sysctl — output: ${SYSCTL_IPV4_CONF_ALL_OUTPUT}"
fi

echo ""
echo "  sysctl-ipv4-conf-all-test output (stderr+stdout combined):"
echo "${SYSCTL_IPV4_CONF_ALL_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 53 — Negative: sysctls: {net.ipv4.conf.eth0.forwarding: 1} must be
#           rejected (Invariant 1i, IPv4 per-interface form).
#
# net.ipv4.conf.<iface>.forwarding enables forwarding on a specific interface.
# The guard must catch any single-segment interface name (e.g. eth0, ens3).
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 53: guard rejects sysctls: {net.ipv4.conf.eth0.forwarding: 1} (IPv4 per-iface) ---"

SYSCTL_IPV4_CONF_IFACE_COMPOSE="${TMPDIR_TEST}/compose-sysctl-ipv4-conf-iface.yaml"
cat > "${SYSCTL_IPV4_CONF_IFACE_COMPOSE}" <<'YAML'
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
    sysctls:
      net.ipv4.conf.eth0.forwarding: 1

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SYSCTL_IPV4_CONF_IFACE_OUTPUT=""
SYSCTL_IPV4_CONF_IFACE_EXIT=0
SYSCTL_IPV4_CONF_IFACE_OUTPUT="$(COMPOSE_FILE="${SYSCTL_IPV4_CONF_IFACE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SYSCTL_IPV4_CONF_IFACE_EXIT=$?

if [[ "${SYSCTL_IPV4_CONF_IFACE_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${SYSCTL_IPV4_CONF_IFACE_EXIT}) for sysctls net.ipv4.conf.eth0.forwarding=1"
else
  fail "validate-stack.sh exited ZERO for sysctls net.ipv4.conf.eth0.forwarding=1 — IPv4 per-iface NOT caught"
fi

if echo "${SYSCTL_IPV4_CONF_IFACE_OUTPUT}" | grep -q "workspace"; then
  pass "sysctls ipv4.conf.eth0 failure message names the service 'workspace'"
else
  fail "sysctls ipv4.conf.eth0 failure message does not name 'workspace' — output: ${SYSCTL_IPV4_CONF_IFACE_OUTPUT}"
fi

if echo "${SYSCTL_IPV4_CONF_IFACE_OUTPUT}" | grep -q "net.ipv4.conf.eth0.forwarding"; then
  pass "sysctls ipv4.conf.eth0 failure message mentions 'net.ipv4.conf.eth0.forwarding'"
else
  fail "sysctls ipv4.conf.eth0 failure message does not mention the sysctl — output: ${SYSCTL_IPV4_CONF_IFACE_OUTPUT}"
fi

echo ""
echo "  sysctl-ipv4-conf-iface-test output (stderr+stdout combined):"
echo "${SYSCTL_IPV4_CONF_IFACE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 54 — Negative: security_opt: ["seccomp=/path/to/profile.json"] must be
#           rejected (Invariant 1j, custom seccomp profile path).
#
# A custom seccomp profile path replaces Docker's default seccomp profile with
# an operator-supplied one that may be permissive, bypassing the default
# profile's protections.  The guard must reject any seccomp/apparmor value
# that is not the literal "default".
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 54: guard rejects security_opt: [\"seccomp=/path/to/profile.json\"] (custom profile path) ---"

SECOPT_CUSTOM_PATH_COMPOSE="${TMPDIR_TEST}/compose-secopt-custom-path.yaml"
cat > "${SECOPT_CUSTOM_PATH_COMPOSE}" <<'YAML'
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
    security_opt:
      - "seccomp=/path/to/profile.json"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SECOPT_CUSTOM_PATH_OUTPUT=""
SECOPT_CUSTOM_PATH_EXIT=0
SECOPT_CUSTOM_PATH_OUTPUT="$(COMPOSE_FILE="${SECOPT_CUSTOM_PATH_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SECOPT_CUSTOM_PATH_EXIT=$?

if [[ "${SECOPT_CUSTOM_PATH_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${SECOPT_CUSTOM_PATH_EXIT}) for security_opt: [\"seccomp=/path/to/profile.json\"]"
else
  fail "validate-stack.sh exited ZERO for security_opt seccomp=/path — custom profile bypass NOT caught"
fi

if echo "${SECOPT_CUSTOM_PATH_OUTPUT}" | grep -q "workspace"; then
  pass "security_opt custom-path failure message names the service 'workspace'"
else
  fail "security_opt custom-path failure message does not name 'workspace' — output: ${SECOPT_CUSTOM_PATH_OUTPUT}"
fi

if echo "${SECOPT_CUSTOM_PATH_OUTPUT}" | grep -qi "seccomp"; then
  pass "security_opt custom-path failure message mentions 'seccomp'"
else
  fail "security_opt custom-path failure message does not mention 'seccomp' — output: ${SECOPT_CUSTOM_PATH_OUTPUT}"
fi

echo ""
echo "  secopt-custom-path-test output (stderr+stdout combined):"
echo "${SECOPT_CUSTOM_PATH_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 55 — Positive: security_opt: ["seccomp:default"] must NOT be rejected
#           (Invariant 1j positive control — explicit default allowed).
#
# seccomp:default explicitly requests Docker's default seccomp profile, which
# is the same as not specifying seccomp at all.  The guard allows the literal
# value "default" for both seccomp and apparmor.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 55: guard accepts security_opt: [\"seccomp:default\"] (explicit default allowed) ---"

SECOPT_DEFAULT_COMPOSE="${TMPDIR_TEST}/compose-secopt-default.yaml"
cat > "${SECOPT_DEFAULT_COMPOSE}" <<'YAML'
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
    security_opt:
      - "seccomp:default"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SECOPT_DEFAULT_OUTPUT=""
SECOPT_DEFAULT_EXIT=0
SECOPT_DEFAULT_OUTPUT="$(COMPOSE_FILE="${SECOPT_DEFAULT_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SECOPT_DEFAULT_EXIT=$?

if [[ "${SECOPT_DEFAULT_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for security_opt: [\"seccomp:default\"] — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${SECOPT_DEFAULT_EXIT}) for seccomp:default — over-rejection: ${SECOPT_DEFAULT_OUTPUT}"
fi

echo ""
echo "  secopt-default-test output (stderr+stdout combined):"
echo "${SECOPT_DEFAULT_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 56 — Positive: security_opt: ["label:disable"] must NOT be rejected
#           (Invariant 1j positive control — label:* always allowed).
#
# label:* entries control SELinux label assignment and are not seccomp/apparmor
# confinement controls.  The guard must not over-reject them.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 56: guard accepts security_opt: [\"label:disable\"] (label:* always allowed) ---"

SECOPT_LABEL_COMPOSE="${TMPDIR_TEST}/compose-secopt-label.yaml"
cat > "${SECOPT_LABEL_COMPOSE}" <<'YAML'
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
    security_opt:
      - "label:disable"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

SECOPT_LABEL_OUTPUT=""
SECOPT_LABEL_EXIT=0
SECOPT_LABEL_OUTPUT="$(COMPOSE_FILE="${SECOPT_LABEL_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || SECOPT_LABEL_EXIT=$?

if [[ "${SECOPT_LABEL_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for security_opt: [\"label:disable\"] — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${SECOPT_LABEL_EXIT}) for label:disable — over-rejection: ${SECOPT_LABEL_OUTPUT}"
fi

echo ""
echo "  secopt-label-test output (stderr+stdout combined):"
echo "${SECOPT_LABEL_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 57 — Positive: cap_add: [SYS_TIME] must NOT be rejected
#           (Invariant 1d positive control — benign capability allowed).
#
# SYS_TIME allows setting the system clock.  It is not in the banned set and
# must not be over-rejected.  This confirms the guard is not a blanket cap_add
# ban but targets only the specific dangerous capabilities.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 57: guard accepts cap_add: [SYS_TIME] (benign capability, not banned) ---"

CAP_SYS_TIME_COMPOSE="${TMPDIR_TEST}/compose-cap-sys-time.yaml"
cat > "${CAP_SYS_TIME_COMPOSE}" <<'YAML'
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
    cap_add:
      - SYS_TIME

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_SYS_TIME_OUTPUT=""
CAP_SYS_TIME_EXIT=0
CAP_SYS_TIME_OUTPUT="$(COMPOSE_FILE="${CAP_SYS_TIME_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_SYS_TIME_EXIT=$?

if [[ "${CAP_SYS_TIME_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for cap_add: [SYS_TIME] — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${CAP_SYS_TIME_EXIT}) for cap_add: [SYS_TIME] — over-rejection: ${CAP_SYS_TIME_OUTPUT}"
fi

echo ""
echo "  cap-sys-time-test output (stderr+stdout combined):"
echo "${CAP_SYS_TIME_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 58 — Negative: ipc: host must be rejected (Invariant 1k).
#
# ipc: host shares the host IPC namespace (shared memory, semaphores,
# message queues).  Combined with SYS_PTRACE or other capabilities it
# enables host-process inspection and lateral-movement within the host
# trust boundary.  The failure message must name the service and mention
# 'ipc: host'.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 58: guard rejects ipc: host (Invariant 1k) ---"

IPC_HOST_COMPOSE="${TMPDIR_TEST}/compose-ipc-host.yaml"
cat > "${IPC_HOST_COMPOSE}" <<'YAML'
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
    ipc: host

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

IPC_HOST_OUTPUT=""
IPC_HOST_EXIT=0
IPC_HOST_OUTPUT="$(COMPOSE_FILE="${IPC_HOST_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || IPC_HOST_EXIT=$?

if [[ "${IPC_HOST_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${IPC_HOST_EXIT}) for ipc: host"
else
  fail "validate-stack.sh exited ZERO for ipc: host — Invariant 1k did NOT fire"
fi

if echo "${IPC_HOST_OUTPUT}" | grep -q "workspace"; then
  pass "ipc: host failure message names the service 'workspace'"
else
  fail "ipc: host failure message does not name 'workspace' — output: ${IPC_HOST_OUTPUT}"
fi

if echo "${IPC_HOST_OUTPUT}" | grep -qi "ipc.*host\|ipc: host"; then
  pass "ipc: host failure message mentions 'ipc: host'"
else
  fail "ipc: host failure message does not mention 'ipc: host' — output: ${IPC_HOST_OUTPUT}"
fi

echo ""
echo "  ipc-host-test output (stderr+stdout combined):"
echo "${IPC_HOST_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 59 — Negative: cap_add: [SYS_PTRACE] must be rejected (Invariant 1d).
#
# SYS_PTRACE enables ptrace(2) on host processes; combined with shared
# namespaces it enables host-process inspection and lateral-movement.
# The failure message must name the service and mention 'SYS_PTRACE'.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 59: guard rejects cap_add: [SYS_PTRACE] (Invariant 1d) ---"

CAP_SYS_PTRACE_COMPOSE="${TMPDIR_TEST}/compose-cap-sys-ptrace.yaml"
cat > "${CAP_SYS_PTRACE_COMPOSE}" <<'YAML'
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
    cap_add:
      - SYS_PTRACE

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_SYS_PTRACE_OUTPUT=""
CAP_SYS_PTRACE_EXIT=0
CAP_SYS_PTRACE_OUTPUT="$(COMPOSE_FILE="${CAP_SYS_PTRACE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_SYS_PTRACE_EXIT=$?

if [[ "${CAP_SYS_PTRACE_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_SYS_PTRACE_EXIT}) for cap_add: [SYS_PTRACE]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [SYS_PTRACE] — Invariant 1d did NOT fire"
fi

if echo "${CAP_SYS_PTRACE_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add SYS_PTRACE failure message names the service 'workspace'"
else
  fail "cap_add SYS_PTRACE failure message does not name 'workspace' — output: ${CAP_SYS_PTRACE_OUTPUT}"
fi

if echo "${CAP_SYS_PTRACE_OUTPUT}" | grep -qi "SYS_PTRACE"; then
  pass "cap_add SYS_PTRACE failure message mentions 'SYS_PTRACE'"
else
  fail "cap_add SYS_PTRACE failure message does not mention 'SYS_PTRACE' — output: ${CAP_SYS_PTRACE_OUTPUT}"
fi

echo ""
echo "  cap-sys-ptrace-test output (stderr+stdout combined):"
echo "${CAP_SYS_PTRACE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 60 — Negative: cap_add: [CAP_SYS_PTRACE] must be rejected (CAP_ prefix
#           normalization, Invariant 1d).
#
# Docker Compose or raw YAML may preserve the CAP_ prefix.  The guard strips
# CAP_ before checking the banned set, so CAP_SYS_PTRACE → SYS_PTRACE is caught.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 60: guard rejects cap_add: [CAP_SYS_PTRACE] (CAP_ prefix normalization) ---"

CAP_CAP_SYS_PTRACE_COMPOSE="${TMPDIR_TEST}/compose-cap-cap-sys-ptrace.yaml"
cat > "${CAP_CAP_SYS_PTRACE_COMPOSE}" <<'YAML'
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
    cap_add:
      - CAP_SYS_PTRACE

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

CAP_CAP_SYS_PTRACE_OUTPUT=""
CAP_CAP_SYS_PTRACE_EXIT=0
CAP_CAP_SYS_PTRACE_OUTPUT="$(COMPOSE_FILE="${CAP_CAP_SYS_PTRACE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || CAP_CAP_SYS_PTRACE_EXIT=$?

if [[ "${CAP_CAP_SYS_PTRACE_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${CAP_CAP_SYS_PTRACE_EXIT}) for cap_add: [CAP_SYS_PTRACE]"
else
  fail "validate-stack.sh exited ZERO for cap_add: [CAP_SYS_PTRACE] — CAP_ prefix bypass NOT caught"
fi

if echo "${CAP_CAP_SYS_PTRACE_OUTPUT}" | grep -q "workspace"; then
  pass "cap_add CAP_SYS_PTRACE failure message names the service 'workspace'"
else
  fail "cap_add CAP_SYS_PTRACE failure message does not name 'workspace' — output: ${CAP_CAP_SYS_PTRACE_OUTPUT}"
fi

if echo "${CAP_CAP_SYS_PTRACE_OUTPUT}" | grep -qi "CAP_SYS_PTRACE\|SYS_PTRACE"; then
  pass "cap_add CAP_SYS_PTRACE failure message mentions the capability"
else
  fail "cap_add CAP_SYS_PTRACE failure message does not mention the capability — output: ${CAP_CAP_SYS_PTRACE_OUTPUT}"
fi

echo ""
echo "  cap-cap-sys-ptrace-test output (stderr+stdout combined):"
echo "${CAP_CAP_SYS_PTRACE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 61 — Positive: ipc: "service:mitmproxy" must NOT be rejected
#           (Invariant 1k positive control — non-host IPC mode allowed).
#
# ipc: service:<x> shares another container's IPC namespace (not the host's)
# and is not a host-namespace escape.  The guard must not over-reject it.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 61: guard accepts ipc: \"service:mitmproxy\" (non-host IPC mode, not rejected) ---"

IPC_SERVICE_COMPOSE="${TMPDIR_TEST}/compose-ipc-service.yaml"
cat > "${IPC_SERVICE_COMPOSE}" <<'YAML'
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
    ipc: "service:mitmproxy"

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

IPC_SERVICE_OUTPUT=""
IPC_SERVICE_EXIT=0
IPC_SERVICE_OUTPUT="$(COMPOSE_FILE="${IPC_SERVICE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || IPC_SERVICE_EXIT=$?

if [[ "${IPC_SERVICE_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for ipc: \"service:mitmproxy\" — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${IPC_SERVICE_EXIT}) for ipc: service:mitmproxy — over-rejection: ${IPC_SERVICE_OUTPUT}"
fi

echo ""
echo "  ipc-service-test output (stderr+stdout combined):"
echo "${IPC_SERVICE_OUTPUT}" | sed 's/^/    /'

# NOTE: TEST 2 (above) already asserts that the real deploy/compose.yaml passes
# the topology guard (exit zero) — no duplicate test is added here for the new
# invariants.  The real compose.yaml uses none of the newly-rejected keys
# (ipc: host, cap_add: SYS_PTRACE), so TEST 2 serves as the positive control
# for Invariants 1k and the SYS_PTRACE addition to 1d as well.

# ---------------------------------------------------------------------------
# TEST 62 — Negative: userns_mode: host must be rejected (Invariant 1l).
#
# userns_mode: host disables user-namespace remapping; when the Docker daemon
# runs with --userns-remap, container-root is normally mapped to an
# unprivileged host UID.  userns_mode: host opts out, making container-root
# equivalent to host-root and amplifying any capability escape.
# The failure message must name the service and mention userns_mode:host.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 62: guard rejects userns_mode: host (Invariant 1l) ---"

USERNS_HOST_COMPOSE="${TMPDIR_TEST}/compose-userns-host.yaml"
cat > "${USERNS_HOST_COMPOSE}" <<'YAML'
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
    userns_mode: host

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

USERNS_HOST_OUTPUT=""
USERNS_HOST_EXIT=0
USERNS_HOST_OUTPUT="$(COMPOSE_FILE="${USERNS_HOST_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || USERNS_HOST_EXIT=$?

if [[ "${USERNS_HOST_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${USERNS_HOST_EXIT}) for userns_mode: host"
else
  fail "validate-stack.sh exited ZERO for userns_mode: host — Invariant 1l did NOT fire"
fi

if echo "${USERNS_HOST_OUTPUT}" | grep -q "workspace"; then
  pass "userns_mode:host failure message names the service 'workspace'"
else
  fail "userns_mode:host failure message does not name 'workspace' — output: ${USERNS_HOST_OUTPUT}"
fi

if echo "${USERNS_HOST_OUTPUT}" | grep -qi "userns_mode"; then
  pass "userns_mode:host failure message mentions 'userns_mode'"
else
  fail "userns_mode:host failure message does not mention 'userns_mode' — output: ${USERNS_HOST_OUTPUT}"
fi

echo ""
echo "  userns-host-test output (stderr+stdout combined):"
echo "${USERNS_HOST_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 63 — Positive: ipc: none must NOT be rejected (Invariant 1k positive
#           control — non-host IPC mode allowed).
#
# ipc: none disables IPC namespace sharing entirely (the container gets its
# own private IPC namespace with no sharing).  It is not a host-namespace
# escape and must not be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 63: guard accepts ipc: none (non-host IPC mode, positive control) ---"

IPC_NONE_COMPOSE="${TMPDIR_TEST}/compose-ipc-none.yaml"
cat > "${IPC_NONE_COMPOSE}" <<'YAML'
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
    ipc: none

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

IPC_NONE_OUTPUT=""
IPC_NONE_EXIT=0
IPC_NONE_OUTPUT="$(COMPOSE_FILE="${IPC_NONE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || IPC_NONE_EXIT=$?

if [[ "${IPC_NONE_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for ipc: none — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${IPC_NONE_EXIT}) for ipc: none — over-rejection: ${IPC_NONE_OUTPUT}"
fi

echo ""
echo "  ipc-none-test output (stderr+stdout combined):"
echo "${IPC_NONE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 64 — Positive: ipc: shareable must NOT be rejected (Invariant 1k
#           positive control — non-host IPC mode allowed).
#
# ipc: shareable makes the container's IPC namespace shareable with other
# containers (via ipc: container:<x>), but does NOT share the host IPC
# namespace.  It is not a host-namespace escape and must not be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 64: guard accepts ipc: shareable (non-host IPC mode, positive control) ---"

IPC_SHAREABLE_COMPOSE="${TMPDIR_TEST}/compose-ipc-shareable.yaml"
cat > "${IPC_SHAREABLE_COMPOSE}" <<'YAML'
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
    ipc: shareable

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

IPC_SHAREABLE_OUTPUT=""
IPC_SHAREABLE_EXIT=0
IPC_SHAREABLE_OUTPUT="$(COMPOSE_FILE="${IPC_SHAREABLE_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || IPC_SHAREABLE_EXIT=$?

if [[ "${IPC_SHAREABLE_EXIT}" -eq 0 ]]; then
  pass "validate-stack.sh exited zero for ipc: shareable — no over-rejection"
else
  fail "validate-stack.sh exited non-zero (${IPC_SHAREABLE_EXIT}) for ipc: shareable — over-rejection: ${IPC_SHAREABLE_OUTPUT}"
fi

echo ""
echo "  ipc-shareable-test output (stderr+stdout combined):"
echo "${IPC_SHAREABLE_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 65 — Negative: ipc: HOST (uppercase) must be rejected (case
#           normalization — Invariant 1k).
#
# The guard normalizes via .strip().lower() before comparing, so uppercase
# "HOST" must be caught the same as lowercase "host".
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 65: guard rejects ipc: HOST (uppercase — case normalization, Invariant 1k) ---"

IPC_HOST_UPPER_COMPOSE="${TMPDIR_TEST}/compose-ipc-host-upper.yaml"
cat > "${IPC_HOST_UPPER_COMPOSE}" <<'YAML'
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
    ipc: HOST

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

IPC_HOST_UPPER_OUTPUT=""
IPC_HOST_UPPER_EXIT=0
IPC_HOST_UPPER_OUTPUT="$(COMPOSE_FILE="${IPC_HOST_UPPER_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || IPC_HOST_UPPER_EXIT=$?

if [[ "${IPC_HOST_UPPER_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${IPC_HOST_UPPER_EXIT}) for ipc: HOST (uppercase)"
else
  fail "validate-stack.sh exited ZERO for ipc: HOST (uppercase) — case normalization did NOT fire"
fi

if echo "${IPC_HOST_UPPER_OUTPUT}" | grep -qi "ipc"; then
  pass "ipc:HOST uppercase failure message mentions 'ipc'"
else
  fail "ipc:HOST uppercase failure message does not mention 'ipc' — output: ${IPC_HOST_UPPER_OUTPUT}"
fi

echo ""
echo "  ipc-host-upper-test output (stderr+stdout combined):"
echo "${IPC_HOST_UPPER_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST 66 — Negative: cap_add as a scalar string (not a list) must be
#           rejected (scalar-string guard — Invariant 1d).
#
# Raw YAML allows cap_add to be written as a bare scalar string instead of
# a list.  The guard wraps a bare string into a single-element list before
# checking, so "cap_add: SYS_PTRACE" (scalar) must be caught the same as
# "cap_add: [SYS_PTRACE]" (list).
#
# docker compose config rejects scalar cap_add as invalid schema, so this
# test exercises the raw-YAML fallback path.  Gated on PyYAML availability
# (same as TEST 22 which also requires the raw-YAML path).
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 66: guard rejects cap_add: SYS_PTRACE as scalar string (scalar guard, Invariant 1d, raw-YAML path) ---"

CAP_SCALAR_COMPOSE="${TMPDIR_TEST}/compose-cap-scalar.yaml"
cat > "${CAP_SCALAR_COMPOSE}" <<'YAML'
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
    cap_add: SYS_PTRACE

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

if "${PYTHON3_BIN}" -c "import yaml" 2>/dev/null; then
  CAP_SCALAR_OUTPUT=""
  CAP_SCALAR_EXIT=0
  CAP_SCALAR_OUTPUT="$(PATH="${NO_DOCKER_PATH}" COMPOSE_FILE="${CAP_SCALAR_COMPOSE}" PYTHON3_BIN="${PYTHON3_BIN}" "${BASH_BIN}" deploy/validate-stack.sh --topology-only 2>&1)" || CAP_SCALAR_EXIT=$?

  if [[ "${CAP_SCALAR_EXIT}" -ne 0 ]]; then
    pass "validate-stack.sh exited non-zero (${CAP_SCALAR_EXIT}) for cap_add: SYS_PTRACE (scalar string, raw-YAML path)"
  else
    fail "validate-stack.sh exited ZERO for cap_add: SYS_PTRACE (scalar string, raw-YAML path) — scalar guard did NOT fire"
  fi

  if echo "${CAP_SCALAR_OUTPUT}" | grep -qi "SYS_PTRACE\|cap_add"; then
    pass "scalar cap_add failure message mentions SYS_PTRACE or cap_add"
  else
    fail "scalar cap_add failure message does not mention SYS_PTRACE or cap_add — output: ${CAP_SCALAR_OUTPUT}"
  fi

  echo ""
  echo "  cap-scalar-test output (stderr+stdout combined):"
  echo "${CAP_SCALAR_OUTPUT}" | sed 's/^/    /'
else
  echo "  SKIP: scalar cap_add (raw-YAML path): PyYAML not available — install python3-yaml/PyYAML to run this test."
  echo "        (docker compose config rejects scalar cap_add as invalid schema; raw-YAML path is required)"
fi

# ---------------------------------------------------------------------------
# TEST 67 — Negative: uts: host must be rejected (Invariant 1m).
#
# uts: host shares the host UTS namespace (hostname and NIS domain name) with
# the container, disclosing the host identity.  The failure message must name
# the service and mention uts:host.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST 67: guard rejects uts: host (Invariant 1m) ---"

UTS_HOST_COMPOSE="${TMPDIR_TEST}/compose-uts-host.yaml"
cat > "${UTS_HOST_COMPOSE}" <<'YAML'
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
    uts: host

networks:
  sandbox-net:
    internal: true
  egress-net: {}

volumes:
  workspace-repos:
YAML

UTS_HOST_OUTPUT=""
UTS_HOST_EXIT=0
UTS_HOST_OUTPUT="$(COMPOSE_FILE="${UTS_HOST_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || UTS_HOST_EXIT=$?

if [[ "${UTS_HOST_EXIT}" -ne 0 ]]; then
  pass "validate-stack.sh exited non-zero (${UTS_HOST_EXIT}) for uts: host"
else
  fail "validate-stack.sh exited ZERO for uts: host — Invariant 1m did NOT fire"
fi

if echo "${UTS_HOST_OUTPUT}" | grep -q "workspace"; then
  pass "uts:host failure message names the service 'workspace'"
else
  fail "uts:host failure message does not name 'workspace' — output: ${UTS_HOST_OUTPUT}"
fi

if echo "${UTS_HOST_OUTPUT}" | grep -qi "uts"; then
  pass "uts:host failure message mentions 'uts'"
else
  fail "uts:host failure message does not mention 'uts' — output: ${UTS_HOST_OUTPUT}"
fi

echo ""
echo "  uts-host-test output (stderr+stdout combined):"
echo "${UTS_HOST_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# OPERATOR WEB SURFACE TOPOLOGY TESTS
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# TEST OP-1 — Negative: GATEWAY_OPERATOR_BIND_HOST=0.0.0.0 must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-1: operator topology guard rejects GATEWAY_OPERATOR_BIND_HOST=0.0.0.0 ---"

OP1_COMPOSE="${TMPDIR_TEST}/compose-op1.yaml"
cat > "${OP1_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "0.0.0.0"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP1_OUTPUT=""
OP1_EXIT=0
OP1_OUTPUT="$(COMPOSE_FILE="${OP1_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP1_EXIT=$?

if [[ "${OP1_EXIT}" -ne 0 ]]; then
  pass "OP-1: validate-stack.sh exited non-zero (${OP1_EXIT}) for BIND_HOST=0.0.0.0"
else
  fail "OP-1: validate-stack.sh exited ZERO for BIND_HOST=0.0.0.0 — guard did NOT fire"
fi

if echo "${OP1_OUTPUT}" | grep -qi "0\.0\.0\.0\|all interfaces\|all-interfaces"; then
  pass "OP-1: failure message mentions 0.0.0.0 / all-interfaces"
else
  fail "OP-1: failure message does not mention 0.0.0.0 — output: ${OP1_OUTPUT}"
fi

echo ""
echo "  OP-1 output (stderr+stdout combined):"
echo "${OP1_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-2 — Negative: GATEWAY_OPERATOR_BIND_HOST=127.0.0.1 must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-2: operator topology guard rejects GATEWAY_OPERATOR_BIND_HOST=127.0.0.1 ---"

OP2_COMPOSE="${TMPDIR_TEST}/compose-op2.yaml"
cat > "${OP2_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "127.0.0.1"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP2_OUTPUT=""
OP2_EXIT=0
OP2_OUTPUT="$(COMPOSE_FILE="${OP2_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP2_EXIT=$?

if [[ "${OP2_EXIT}" -ne 0 ]]; then
  pass "OP-2: validate-stack.sh exited non-zero (${OP2_EXIT}) for BIND_HOST=127.0.0.1"
else
  fail "OP-2: validate-stack.sh exited ZERO for BIND_HOST=127.0.0.1 — guard did NOT fire"
fi

if echo "${OP2_OUTPUT}" | grep -qi "127\.0\.0\.1\|loopback"; then
  pass "OP-2: failure message mentions 127.0.0.1 / loopback"
else
  fail "OP-2: failure message does not mention 127.0.0.1 — output: ${OP2_OUTPUT}"
fi

echo ""
echo "  OP-2 output (stderr+stdout combined):"
echo "${OP2_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-3 — Negative: GATEWAY_OPERATOR_PUBLIC_ORIGIN with http:// must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-3: operator topology guard rejects http:// public origin ---"

OP3_COMPOSE="${TMPDIR_TEST}/compose-op3.yaml"
cat > "${OP3_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "172.20.0.2"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "http://operator.example.com"
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

OP3_OUTPUT=""
OP3_EXIT=0
OP3_OUTPUT="$(COMPOSE_FILE="${OP3_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP3_EXIT=$?

if [[ "${OP3_EXIT}" -ne 0 ]]; then
  pass "OP-3: validate-stack.sh exited non-zero (${OP3_EXIT}) for http:// public origin"
else
  fail "OP-3: validate-stack.sh exited ZERO for http:// public origin — guard did NOT fire"
fi

if echo "${OP3_OUTPUT}" | grep -qi "https://\|TLS\|tls"; then
  pass "OP-3: failure message mentions https:// / TLS requirement"
else
  fail "OP-3: failure message does not mention https:// — output: ${OP3_OUTPUT}"
fi

echo ""
echo "  OP-3 output (stderr+stdout combined):"
echo "${OP3_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-4 — Negative: GATEWAY_OPERATOR_BIND_HOST set without PUBLIC_ORIGIN.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-4: operator topology guard rejects missing PUBLIC_ORIGIN when BIND_HOST is set ---"

OP4_COMPOSE="${TMPDIR_TEST}/compose-op4.yaml"
cat > "${OP4_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "172.20.0.2"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
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

OP4_OUTPUT=""
OP4_EXIT=0
OP4_OUTPUT="$(COMPOSE_FILE="${OP4_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP4_EXIT=$?

if [[ "${OP4_EXIT}" -ne 0 ]]; then
  pass "OP-4: validate-stack.sh exited non-zero (${OP4_EXIT}) for missing PUBLIC_ORIGIN"
else
  fail "OP-4: validate-stack.sh exited ZERO for missing PUBLIC_ORIGIN — guard did NOT fire"
fi

if echo "${OP4_OUTPUT}" | grep -qi "PUBLIC_ORIGIN\|public.origin"; then
  pass "OP-4: failure message mentions PUBLIC_ORIGIN"
else
  fail "OP-4: failure message does not mention PUBLIC_ORIGIN — output: ${OP4_OUTPUT}"
fi

echo ""
echo "  OP-4 output (stderr+stdout combined):"
echo "${OP4_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-5 — Positive: valid operator config on gateway-net must pass.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-5: operator topology guard accepts valid gateway-net operator config ---"

OP5_COMPOSE="${TMPDIR_TEST}/compose-op5.yaml"
cat > "${OP5_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "172.20.0.2"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP5_OUTPUT=""
OP5_EXIT=0
OP5_OUTPUT="$(COMPOSE_FILE="${OP5_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP5_EXIT=$?

if [[ "${OP5_EXIT}" -eq 0 ]]; then
  pass "OP-5: validate-stack.sh exited zero for valid operator config"
else
  fail "OP-5: validate-stack.sh exited non-zero (${OP5_EXIT}) for valid operator config — output: ${OP5_OUTPUT}"
fi

echo ""
echo "  OP-5 output (stderr+stdout combined):"
echo "${OP5_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-6 — Positive: operator listener disabled (no env vars) must pass.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-6: operator topology guard accepts compose with no operator config (listener disabled) ---"

OP6_OUTPUT=""
OP6_EXIT=0
OP6_OUTPUT="$(COMPOSE_FILE=deploy/compose.yaml bash deploy/validate-stack.sh --topology-only 2>&1)" || OP6_EXIT=$?

if [[ "${OP6_EXIT}" -eq 0 ]]; then
  pass "OP-6: validate-stack.sh exited zero for real compose.yaml (operator listener disabled)"
else
  fail "OP-6: validate-stack.sh exited non-zero (${OP6_EXIT}) for real compose.yaml — output: ${OP6_OUTPUT}"
fi

echo ""
echo "  OP-6 output (stderr+stdout combined):"
echo "${OP6_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-7 — Negative: sandbox-net address (10.0.0.2) must be rejected.
#
# 10.0.0.0/8 is the Docker internal sandbox-net. The operator listener must
# be on gateway-net only (e.g. 172.20.x.x). Binding to a sandbox-net address
# would make the operator surface reachable from the workspace container,
# collapsing the network-layer isolation to app-layer auth only.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-7: operator topology guard rejects sandbox-net address (10.0.0.2) ---"

OP7_COMPOSE="${TMPDIR_TEST}/compose-op7.yaml"
cat > "${OP7_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "10.0.0.2"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP7_OUTPUT=""
OP7_EXIT=0
OP7_OUTPUT="$(COMPOSE_FILE="${OP7_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP7_EXIT=$?

if [[ "${OP7_EXIT}" -ne 0 ]]; then
  pass "OP-7: validate-stack.sh exited non-zero (${OP7_EXIT}) for sandbox-net operator bind host"
else
  fail "OP-7: validate-stack.sh exited ZERO for sandbox-net operator bind host — guard did NOT fire"
fi

if echo "${OP7_OUTPUT}" | grep -qi "sandbox-net\|10\.0\.0\.0"; then
  pass "OP-7: failure message mentions sandbox-net or 10.0.0.0/8"
else
  fail "OP-7: failure message does not mention sandbox-net — output: ${OP7_OUTPUT}"
fi

echo ""
echo "  OP-7 output (stderr+stdout combined):"
echo "${OP7_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-8 — Negative: hostname bind host (e.g. "localhost") must be rejected.
#
# The operator listener must be bound to a literal IP address, not a hostname.
# Hostnames are not permitted because they require DNS resolution, which
# introduces a TOCTOU window and may resolve to unexpected addresses.
# This mirrors the isIP() check in config.ts.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-8: operator topology guard rejects hostname bind host (localhost) ---"

OP8_COMPOSE="${TMPDIR_TEST}/compose-op8.yaml"
cat > "${OP8_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "localhost"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP8_OUTPUT=""
OP8_EXIT=0
OP8_OUTPUT="$(COMPOSE_FILE="${OP8_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP8_EXIT=$?

if [[ "${OP8_EXIT}" -ne 0 ]]; then
  pass "OP-8: validate-stack.sh exited non-zero (${OP8_EXIT}) for hostname bind host 'localhost'"
else
  fail "OP-8: validate-stack.sh exited ZERO for hostname bind host 'localhost' — guard did NOT fire"
fi

if echo "${OP8_OUTPUT}" | grep -qi "literal IP\|hostname\|localhost"; then
  pass "OP-8: failure message mentions literal IP / hostname requirement"
else
  fail "OP-8: failure message does not mention literal IP / hostname — output: ${OP8_OUTPUT}"
fi

echo ""
echo "  OP-8 output (stderr+stdout combined):"
echo "${OP8_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-9 — Negative: invalid operator bind port (non-integer) must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-9: operator topology guard rejects non-integer bind port ---"

OP9_COMPOSE="${TMPDIR_TEST}/compose-op9.yaml"
cat > "${OP9_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "172.20.0.2"
      GATEWAY_OPERATOR_BIND_PORT: "not-a-port"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP9_OUTPUT=""
OP9_EXIT=0
OP9_OUTPUT="$(COMPOSE_FILE="${OP9_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP9_EXIT=$?

if [[ "${OP9_EXIT}" -ne 0 ]]; then
  pass "OP-9: validate-stack.sh exited non-zero (${OP9_EXIT}) for non-integer bind port 'not-a-port'"
else
  fail "OP-9: validate-stack.sh exited ZERO for non-integer bind port — guard did NOT fire"
fi

if echo "${OP9_OUTPUT}" | grep -qi "BIND_PORT\|1.65535\|integer\|range"; then
  pass "OP-9: failure message mentions BIND_PORT / integer / range requirement"
else
  fail "OP-9: failure message does not mention port validation — output: ${OP9_OUTPUT}"
fi

echo ""
echo "  OP-9 output (stderr+stdout combined):"
echo "${OP9_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-10 — Negative: out-of-range operator bind port (70000) must be rejected.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-10: operator topology guard rejects out-of-range bind port (70000) ---"

OP10_COMPOSE="${TMPDIR_TEST}/compose-op10.yaml"
cat > "${OP10_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "172.20.0.2"
      GATEWAY_OPERATOR_BIND_PORT: "70000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP10_OUTPUT=""
OP10_EXIT=0
OP10_OUTPUT="$(COMPOSE_FILE="${OP10_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP10_EXIT=$?

if [[ "${OP10_EXIT}" -ne 0 ]]; then
  pass "OP-10: validate-stack.sh exited non-zero (${OP10_EXIT}) for out-of-range bind port 70000"
else
  fail "OP-10: validate-stack.sh exited ZERO for out-of-range bind port 70000 — guard did NOT fire"
fi

if echo "${OP10_OUTPUT}" | grep -qi "BIND_PORT\|1.65535\|integer\|range"; then
  pass "OP-10: failure message mentions BIND_PORT / integer / range requirement"
else
  fail "OP-10: failure message does not mention port validation — output: ${OP10_OUTPUT}"
fi

echo ""
echo "  OP-10 output (stderr+stdout combined):"
echo "${OP10_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-11 — Negative: IPv6 link-local address (fe80::1) must be rejected.
#
# gateway-net is an IPv4-only Docker bridge network. All IPv6 literal addresses
# are rejected until an IPv6 gateway-net topology exists.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-11: operator topology guard rejects IPv6 link-local bind host (fe80::1) ---"

OP11_COMPOSE="${TMPDIR_TEST}/compose-op11.yaml"
cat > "${OP11_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "fe80::1"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP11_OUTPUT=""
OP11_EXIT=0
OP11_OUTPUT="$(COMPOSE_FILE="${OP11_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP11_EXIT=$?

if [[ "${OP11_EXIT}" -ne 0 ]]; then
  pass "OP-11: validate-stack.sh exited non-zero (${OP11_EXIT}) for IPv6 link-local bind host fe80::1"
else
  fail "OP-11: validate-stack.sh exited ZERO for IPv6 link-local bind host — IPv6 guard did NOT fire"
fi

if echo "${OP11_OUTPUT}" | grep -qi "IPv6\|not supported"; then
  pass "OP-11: failure message mentions IPv6 / not supported"
else
  fail "OP-11: failure message does not mention IPv6 rejection — output: ${OP11_OUTPUT}"
fi

echo ""
echo "  OP-11 output (stderr+stdout combined):"
echo "${OP11_OUTPUT}" | sed 's/^/    /'

# ---------------------------------------------------------------------------
# TEST OP-12 — Negative: IPv6 ULA address (fc00::1) must be rejected.
#
# ULA (Unique Local Address) is a private IPv6 range analogous to RFC-1918.
# It is still IPv6 and must be rejected for the same reason as link-local.
# ---------------------------------------------------------------------------
echo ""
echo "--- TEST OP-12: operator topology guard rejects IPv6 ULA bind host (fc00::1) ---"

OP12_COMPOSE="${TMPDIR_TEST}/compose-op12.yaml"
cat > "${OP12_COMPOSE}" <<'YAML'
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
    environment:
      GATEWAY_OPERATOR_BIND_HOST: "fc00::1"
      GATEWAY_OPERATOR_BIND_PORT: "4000"
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: "https://operator.example.com"
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

OP12_OUTPUT=""
OP12_EXIT=0
OP12_OUTPUT="$(COMPOSE_FILE="${OP12_COMPOSE}" bash deploy/validate-stack.sh --topology-only 2>&1)" || OP12_EXIT=$?

if [[ "${OP12_EXIT}" -ne 0 ]]; then
  pass "OP-12: validate-stack.sh exited non-zero (${OP12_EXIT}) for IPv6 ULA bind host fc00::1"
else
  fail "OP-12: validate-stack.sh exited ZERO for IPv6 ULA bind host — IPv6 guard did NOT fire"
fi

if echo "${OP12_OUTPUT}" | grep -qi "IPv6\|not supported"; then
  pass "OP-12: failure message mentions IPv6 / not supported"
else
  fail "OP-12: failure message does not mention IPv6 rejection — output: ${OP12_OUTPUT}"
fi

echo ""
echo "  OP-12 output (stderr+stdout combined):"
echo "${OP12_OUTPUT}" | sed 's/^/    /'

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
