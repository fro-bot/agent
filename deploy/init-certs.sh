#!/usr/bin/env bash
# init-certs.sh — Bootstrap the mitmproxy CA into the named Docker volume.
#
# Run this once before starting the stack for the first time. Idempotent:
# skips generation if the CA cert already exists in the volume.
#
# Usage (from repo root):
#   bash deploy/init-certs.sh
set -euo pipefail

VOLUME_NAME="fro-bot_mitmproxy-certs"
CERT_FILE="mitmproxy-ca-cert.pem"

echo "==> Checking for existing mitmproxy CA in volume '${VOLUME_NAME}'..."

# Check if the cert already exists in the volume
if docker run --rm \
    -v "${VOLUME_NAME}:/certs" \
    --entrypoint sh \
    mitmproxy/mitmproxy:11.0.2 \
    -c "test -f /certs/${CERT_FILE}"; then
  echo "==> CA cert already present — skipping generation."
  exit 0
fi

echo "==> Generating mitmproxy CA (this may take a moment)..."

# Run mitmdump with -n (no-server mode) so it initialises the confdir and exits.
# The CA key + cert are written to the volume at /home/mitmproxy/.mitmproxy.
docker run --rm \
  -v "${VOLUME_NAME}:/home/mitmproxy/.mitmproxy" \
  mitmproxy/mitmproxy:11.0.2 \
  mitmdump --set confdir=/home/mitmproxy/.mitmproxy --quiet -n

echo "==> CA generated successfully."
echo "    Volume: ${VOLUME_NAME}"
echo "    Cert:   ${CERT_FILE} (inside volume at /home/mitmproxy/.mitmproxy/)"
echo ""
echo "    To add the CA to your host trust store (optional, dev only):"
echo "      docker run --rm -v ${VOLUME_NAME}:/certs alpine cat /certs/${CERT_FILE} \\"
echo "        | sudo tee /usr/local/share/ca-certificates/mitmproxy-fro-bot.crt"
echo "      sudo update-ca-certificates"
