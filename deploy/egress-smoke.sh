#!/usr/bin/env bash
# Egress containment smoke — proves the workspace's only internet path is mitmproxy.
#
# Runs three probes from inside the workspace container (which carries the
# mitmproxy CA trust and proxy env set up by its entrypoint):
#
#   (a) Direct internet request with proxy env unset → must fail (no route on
#       sandbox-net, which is internal:true). Baseline containment check.
#
#   (b) Request to a non-allowlisted host through mitmproxy → expect 403.
#       Proves the allowlist enforcement is active.
#
#   (c) Request to an allowlisted host through mitmproxy → expect 200, AND
#       mitmproxy must have logged the allowed flow. This is the routing proof:
#       the request succeeds ONLY because it went through mitmproxy.
#
# Negative-control teeth: if the allowlist is set to allow-all, probe (b)
# returns non-403 and the smoke fails. If mitmproxy is removed from the stack,
# probe (c) has no route and fails. Either mutation breaks the smoke.
#
# Allowlisted host (probe c): api.github.com — always in the static allowlist,
#   reliable HTTPS endpoint, returns 200 on GET /zen.
# Blocked host (probe b):     example.com — not in the allowlist, stable,
#   no DNS surprises.
#
# Usage (from repo root):
#   WORKSPACE_IMAGE=fro-bot-workspace:smoke bash deploy/egress-smoke.sh
#
# WORKSPACE_IMAGE must be a pre-built workspace image (the entrypoint installs
# the mitmproxy CA; an arbitrary image won't have it and probe (c) would fail
# for the wrong reason — TLS verification error, not a routing failure).
set -euo pipefail

WORKSPACE_IMAGE="${WORKSPACE_IMAGE:-fro-bot-workspace:smoke}"
COMPOSE_PROJECT="egress-smoke-$$"
SMOKE_DIR="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() {
  echo "--- cleaning up compose project ${COMPOSE_PROJECT} ---"
  docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" down -v --remove-orphans 2>/dev/null || true
  rm -rf "${SMOKE_DIR}"
}
trap cleanup EXIT

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# Wait for a container's Docker healthcheck to reach "healthy".
# Args: <container-id> <max-attempts> <sleep-seconds>
wait_healthy() {
  local cid="$1" max="$2" interval="$3"
  for _ in $(seq 1 "${max}"); do
    status="$(docker inspect "${cid}" --format '{{.State.Health.Status}}' 2>/dev/null || echo "")"
    if [ "${status}" = "healthy" ]; then
      return 0
    fi
    sleep "${interval}"
  done
  return 1
}

# ---------------------------------------------------------------------------
# Write a self-contained compose file for the smoke stack.
# Only mitmproxy and workspace — no gateway, no secrets bind-mounts.
# The workspace image is pre-built (passed via WORKSPACE_IMAGE).
# ---------------------------------------------------------------------------
cat > "${SMOKE_DIR}/compose.yaml" <<YAML
name: ${COMPOSE_PROJECT}

services:
  mitmproxy:
    image: mitmproxy/mitmproxy:11.1.3@sha256:e0deb0df7edf9f909053f274a067cd1cacb90f5c17d74459e1693179c0b98d8f
    command: >
      mitmdump
      -s /scripts/allowlist.py
      --listen-host 0.0.0.0
      --listen-port 8080
      --set confdir=/home/mitmproxy/.mitmproxy
      --set ssl_insecure=false
    volumes:
      - ./allowlist.py:/scripts/allowlist.py:ro
      - mitmproxy-certs:/home/mitmproxy/.mitmproxy
    networks:
      - sandbox-net
      - egress-net
    restart: unless-stopped
    healthcheck:
      test: [CMD-SHELL, test -f /home/mitmproxy/.mitmproxy/mitmproxy-ca-cert.pem]
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 30s

  workspace:
    image: ${WORKSPACE_IMAGE}
    depends_on:
      mitmproxy:
        condition: service_healthy
    environment:
      HTTPS_PROXY: http://mitmproxy:8080
      HTTP_PROXY: http://mitmproxy:8080
      NO_PROXY: localhost,127.0.0.1,workspace
      # Dummy token keeps the workspace-agent supervisor alive (clone-only mode).
      WORKSPACE_OPENCODE_TOKEN: dummy-egress-smoke-token
      # The entrypoint waits for the CA at this path (named volume mount below).
      MITMPROXY_CA_PATH: /run/mitmproxy-certs/mitmproxy-ca-cert.pem
    volumes:
      - mitmproxy-certs:/run/mitmproxy-certs:ro
    networks:
      - sandbox-net
    healthcheck:
      test: [CMD-SHELL, curl -fsS http://127.0.0.1:9100/healthz || exit 1]
      interval: 10s
      timeout: 3s
      retries: 6
      start_period: 60s

volumes:
  mitmproxy-certs:

networks:
  sandbox-net:
    driver: bridge
    internal: true
  egress-net:
    driver: bridge
YAML

# Copy the allowlist script into the smoke dir so the compose volume mount works.
cp "$(dirname "$0")/mitmproxy/allowlist.py" "${SMOKE_DIR}/allowlist.py"

echo "--- starting egress smoke stack (project: ${COMPOSE_PROJECT}) ---"
docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" up -d

# ---------------------------------------------------------------------------
# Wait for mitmproxy healthy (CA written to shared volume).
# ---------------------------------------------------------------------------
echo "--- waiting for mitmproxy healthy (CA generation) ---"
mitm_cid="$(docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" ps -q mitmproxy 2>/dev/null)"
if ! wait_healthy "${mitm_cid}" 24 5; then
  echo "ERROR: mitmproxy did not become healthy within 120s"
  docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" logs mitmproxy
  exit 1
fi
echo "mitmproxy is healthy (CA written)"

# ---------------------------------------------------------------------------
# Wait for workspace healthy (CA installed, agent up on :9100).
# ---------------------------------------------------------------------------
echo "--- waiting for workspace healthy (CA trust + agent boot) ---"
ws_cid="$(docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" ps -q workspace 2>/dev/null)"
if ! wait_healthy "${ws_cid}" 18 5; then
  echo "ERROR: workspace did not become healthy within 90s"
  docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" logs workspace
  exit 1
fi
echo "workspace is healthy (CA installed, agent up)"

# ---------------------------------------------------------------------------
# Probe (a): direct internet request with proxy env unset → must fail.
# sandbox-net is internal:true so there is no host gateway; the connection
# attempt is refused at the network layer. This is the containment baseline.
# ---------------------------------------------------------------------------
echo ""
echo "--- probe (a): direct internet request (no proxy) → must fail ---"
probe_a_exit=0
docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" exec -T \
  -e HTTPS_PROXY="" -e HTTP_PROXY="" -e https_proxy="" -e http_proxy="" \
  workspace \
  sh -c 'curl -fsS --max-time 10 --noproxy "*" https://api.github.com/zen' \
  >/dev/null 2>&1 || probe_a_exit=$?

if [ "${probe_a_exit}" -ne 0 ]; then
  pass "probe (a): direct internet request failed as expected (exit ${probe_a_exit})"
else
  fail "probe (a): direct internet request SUCCEEDED — sandbox-net containment is broken"
fi

# ---------------------------------------------------------------------------
# Probe (b): non-allowlisted host through mitmproxy → expect 403.
# example.com is not in the allowlist; mitmproxy short-circuits with 403.
#
# Retry policy: retry ONLY on transport/connectivity failures (curl non-zero
# exit) or transient server errors (5xx/429). A definitive but WRONG status
# (any 2xx/3xx — meaning the block failed) is NEVER retried: that is a real
# containment failure and must fail immediately to preserve the test's teeth.
# ---------------------------------------------------------------------------
echo ""
echo "--- probe (b): blocked host (example.com) through mitmproxy → expect 403 ---"
probe_b_exit=0
probe_b_output=""
probe_b_status=""
for _attempt in 1 2 3; do
  probe_b_exit=0
  probe_b_output=""
  probe_b_output="$(docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" exec -T \
    workspace \
    sh -c 'curl -sv --max-time 15 --proxy http://mitmproxy:8080 https://example.com/ 2>&1')" || probe_b_exit=$?
  # Extract the HTTP status code from curl verbose output (last "< HTTP/... NNN" line).
  probe_b_status="$(echo "${probe_b_output}" | grep -oE '< HTTP/[0-9.]+ [0-9]+' | tail -1 | grep -oE '[0-9]+$' || true)"
  if [ "${probe_b_status}" = "403" ]; then
    break  # definitive correct result — stop retrying
  elif [ -n "${probe_b_status}" ] && [ "${probe_b_status}" != "429" ] && \
       ! echo "${probe_b_status}" | grep -qE '^5[0-9][0-9]$'; then
    # Definitive WRONG status (2xx/3xx/4xx≠403): containment failure — fail immediately, no retry.
    break
  fi
  # Transport error (curl exit non-zero, no status) or 5xx/429 — transient; retry with backoff.
  if [ "${_attempt}" -lt 3 ]; then
    echo "  probe (b) attempt ${_attempt} transient (exit=${probe_b_exit} status=${probe_b_status:-none}), retrying in 3s..."
    sleep 3
  fi
done

if [ "${probe_b_status}" = "403" ]; then
  pass "probe (b): mitmproxy returned 403 for non-allowlisted host example.com"
else
  fail "probe (b): expected 403 from mitmproxy for example.com, got: exit=${probe_b_exit} status=${probe_b_status:-none} output=${probe_b_output}"
fi

# ---------------------------------------------------------------------------
# Probe (c): allowlisted host through mitmproxy → expect 200 + log proof.
# api.github.com is in the static allowlist. The request succeeds only because
# it routes through mitmproxy (the workspace has no direct internet path).
# We then assert mitmproxy logged the allowed flow — this is the routing proof.
#
# Retry policy: retry ONLY on transport errors (curl non-zero exit) or
# transient server errors (5xx/429). A definitive but WRONG status (anything
# other than 200) is NEVER retried: that is a real routing/allowlist failure
# and must fail immediately to preserve the test's teeth.
# ---------------------------------------------------------------------------
echo ""
echo "--- probe (c): allowlisted host (api.github.com) through mitmproxy → expect 200 + log ---"
probe_c_exit=0
probe_c_output=""
probe_c_status=""
for _attempt in 1 2 3; do
  probe_c_exit=0
  probe_c_output=""
  probe_c_output="$(docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" exec -T \
    workspace \
    sh -c 'curl -sv --max-time 30 https://api.github.com/zen 2>&1')" || probe_c_exit=$?
  # Extract the HTTP status code from curl verbose output (last "< HTTP/... NNN" line).
  probe_c_status="$(echo "${probe_c_output}" | grep -oE '< HTTP/[0-9.]+ [0-9]+' | tail -1 | grep -oE '[0-9]+$' || true)"
  if [ "${probe_c_status}" = "200" ]; then
    break  # definitive correct result — stop retrying
  elif [ -n "${probe_c_status}" ] && [ "${probe_c_status}" != "429" ] && \
       ! echo "${probe_c_status}" | grep -qE '^5[0-9][0-9]$'; then
    # Definitive WRONG status (3xx/4xx≠429): routing/allowlist failure — fail immediately, no retry.
    break
  fi
  # Transport error (curl exit non-zero, no status) or 5xx/429 — transient; retry with backoff.
  if [ "${_attempt}" -lt 3 ]; then
    echo "  probe (c) attempt ${_attempt} transient (exit=${probe_c_exit} status=${probe_c_status:-none}), retrying in 3s..."
    sleep 3
  fi
done

if [ "${probe_c_status}" = "200" ]; then
  pass "probe (c): allowlisted host api.github.com returned 200"
else
  fail "probe (c): expected 200 from api.github.com via mitmproxy, got: exit=${probe_c_exit} status=${probe_c_status:-none} output=${probe_c_output}"
fi

# Assert mitmproxy logged the allowed flow — proves routing, not just isolation.
echo "--- checking mitmproxy logs for routing proof ---"
mitm_logs="$(docker compose -p "${COMPOSE_PROJECT}" -f "${SMOKE_DIR}/compose.yaml" logs mitmproxy 2>&1)"
if echo "${mitm_logs}" | grep -q "\[allowlist\] ALLOWED.*api\.github\.com"; then
  pass "routing proof: mitmproxy logged ALLOWED connect for api.github.com"
else
  fail "routing proof: mitmproxy did NOT log ALLOWED for api.github.com — request may not have routed through mitmproxy"
  echo "--- mitmproxy logs (last 50 lines) ---"
  echo "${mitm_logs}" | tail -50
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== egress smoke results: ${PASS} passed, ${FAIL} failed ==="
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
