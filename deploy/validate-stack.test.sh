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
