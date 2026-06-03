#!/usr/bin/env bash
# validate-stack.test.sh — Topology-guard negative + positive tests.
#
# Tests that validate-stack.sh --topology-only:
#   (a) EXITS NON-ZERO when workspace is attached to a non-internal network
#       (the regression the guard exists to catch).
#   (b) EXITS ZERO for the real compose.yaml (positive control).
#
# Run from repo root:
#   bash deploy/validate-stack.test.sh
set -euo pipefail

PASS=0
FAIL=0

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
