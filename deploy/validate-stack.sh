#!/usr/bin/env bash
# validate-stack.sh — Smoke-test the fro-bot compose stack.
#
# Assumes the stack is already running:
#   docker compose -f deploy/compose.yaml up -d
#
# Usage (from repo root):
#   bash deploy/validate-stack.sh
set -euo pipefail

COMPOSE_FILE="deploy/compose.yaml"

echo "==> Validating compose config..."
docker compose -f "${COMPOSE_FILE}" config > /dev/null
echo "    OK"

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
