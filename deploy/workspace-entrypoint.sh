#!/bin/sh
# Workspace executor entrypoint.
#
# Trusts the mitmproxy CA before launching the workspace-agent supervisor so
# that ALL outbound TLS clients in this container work through the egress proxy:
#   - git / libcurl (clone.ts)        — read the SYSTEM CA bundle
#   - opencode (Bun, --use-system-ca) — reads the SYSTEM CA bundle
#   - node fetch/https                — covered by NODE_EXTRA_CA_CERTS
#
# NODE_EXTRA_CA_CERTS alone is insufficient: git and opencode do not consult it.
# The CA must be installed into the system trust store via update-ca-certificates.
#
# Fail-closed: if an egress proxy is configured (HTTPS_PROXY/HTTP_PROXY) but CA
# trust cannot be installed, the container exits rather than launching with
# broken TLS — every clone and model call would fail anyway, and a half-trusted
# state is worse than a clear startup error. CI smoke and proxy-less dev opt out
# via MITMPROXY_CA_WAIT_SECONDS=0 or MITMPROXY_CA_OPTIONAL=true.

set -eu

CA_SRC="${MITMPROXY_CA_PATH:-/run/mitmproxy-certs/mitmproxy-ca-cert.pem}"
CA_DEST="/usr/local/share/ca-certificates/mitmproxy.crt"
SYSTEM_BUNDLE="/etc/ssl/certs/ca-certificates.crt"
WAIT_SECONDS="${MITMPROXY_CA_WAIT_SECONDS:-30}"

# install_ca: 0 = installed, 1 = CA absent after wait, 2 = install command failed.
install_ca() {
  waited=0
  while [ ! -f "$CA_SRC" ]; do
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      echo "workspace-entrypoint: no mitmproxy CA at $CA_SRC after ${WAIT_SECONDS}s" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if ! cp "$CA_SRC" "$CA_DEST"; then
    echo "workspace-entrypoint: failed to copy mitmproxy CA to $CA_DEST" >&2
    return 2
  fi
  # Regenerate the merged system bundle (base CAs + mitmproxy).
  if ! update-ca-certificates >/dev/null 2>&1; then
    echo "workspace-entrypoint: update-ca-certificates failed" >&2
    return 2
  fi
  echo "workspace-entrypoint: installed mitmproxy CA into system trust store" >&2
  return 0
}

# A proxy is "configured" when either proxy var is set and non-empty.
proxy_configured() {
  [ -n "${HTTPS_PROXY:-}" ] || [ -n "${HTTP_PROXY:-}" ] || [ -n "${https_proxy:-}" ] || [ -n "${http_proxy:-}" ]
}

# Caller opts out of mandatory CA trust (CI smoke, proxy-less dev).
ca_optional() {
  [ "$WAIT_SECONDS" -eq 0 ] || [ "${MITMPROXY_CA_OPTIONAL:-}" = "true" ]
}

if install_ca; then
  # Point Node's fetch/https at the merged bundle too (belt-and-suspenders).
  export NODE_EXTRA_CA_CERTS="$SYSTEM_BUNDLE"
elif proxy_configured && ! ca_optional; then
  echo "workspace-entrypoint: egress proxy is configured but the mitmproxy CA could not be trusted — refusing to start with broken TLS. Set MITMPROXY_CA_OPTIONAL=true to override." >&2
  exit 1
else
  echo "workspace-entrypoint: continuing without proxy trust (no proxy configured or CA explicitly optional)" >&2
fi

# Hand off to the supervisor as PID 1 so its SIGTERM drain works.
exec node /app/apps/workspace-agent/dist/main.mjs
